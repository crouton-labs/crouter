// Run with: node --import tsx/esm --test src/core/__tests__/broker-lifecycle.test.ts
//
// The broker-backed lifecycle suite — the acceptance-gate proof of the headless-
// broker migration (plan T11). It drives the REAL `crtr` CLI into an isolated
// REAL tmux session and spawns `--headless` nodes onto the REAL headless broker
// host (host.ts), which boots a REAL detached broker PROCESS (broker.ts) per
// node. The broker hosts a fake SDK engine (fixtures/fake-engine.ts) loaded via
// the CRTR_BROKER_ENGINE seam — NOTHING in the broker, the host, the stophook,
// the inbox-watcher, the stop-guard, or the daemon (superviseTick) is mocked.
// Every assertion reads straight off the canvas data layer.
//
// Acceptance items (plan §4) → the asserting test:
//   1 spawn --headless → host_kind='broker', null placement, live broker pid     → "spawn"
//   2 supervised by broker-pid signal-0 (stophook recordPid = broker pid)         → "spawn"
//   3 inbox wakes LIVE (in-broker watcher) AND DORMANT (idle-release → daemon)    → "live wake" + "dormant wake"
//   4 survive a broker crash via grace-revive RESUME on the saved .jsonl          → "crash"
//   5 tear down cleanly — close → shutdown frame → exit, socket unlinked          → "teardown"
//   6 ONE-WRITER (R2) — never two engine pids alive across crash→grace-revive     → "crash"
//   7 tmux stays default — the existing suite passes UNMODIFIED (this file only
//     ADDS a test file + ADDS harness wiring); the "dialog" test is the §5.4
//     forward-progress bonus proof of the zero-viewer path.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { appendInbox } from '../feed/inbox.js';
import { isPidAlive } from '../canvas/pid.js';
import { FAIL_BEFORE_SESSION_START } from './fixtures/fake-engine.js';
// The PRODUCTION attach client (pure node:net + the broker codec, no TUI) reused
// as the in-test controller/observer so the G1–G9 gate exercises the REAL client
// too (§0 one-writer: a viewer holds ONLY a socket).
import { ViewSocketClient } from '../../clients/attach/view-socket.js';
import {
  CLIENT_READ_CAPS,
  FrameDecoder,
  encodeFrame,
  type BrokerToClient,
  type ClientToBroker,
  type ClientRole,
  type WelcomeFrame,
} from '../runtime/broker-protocol.js';

// crtrd.ts module const (not exported). The fresh-pi-boot grace window the daemon
// waits before grace-reviving a pi observed dead. Reference: crtrd.ts
// `REVIVE_GRACE_MS = 20_000`.
const REVIVE_GRACE_MS = 20_000;

let h: Harness;
let root: string;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-broker' });
  // An active resident root: the spawn parent AND the live node a child can hold
  // an active subscription to (so its natural stop classifies 'awaiting').
  root = h.spawnRoot('broker-suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Item 1 + 2 — spawn --headless: broker host, NULL placement, a live broker pid
// that IS the daemon's supervision signal (stophook recordPid(process.pid)).
// ===========================================================================
test('spawn --headless → broker host_kind, null placement, live broker pid; daemon leaves a healthy broker', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — spawn');
  const node = h.node(id)!;

  // Item 1: the broker host + a paneless placement.
  assert.equal(node.host_kind, 'broker', "host_kind === 'broker'");
  assert.equal(node.window ?? null, null, 'window is NULL (paneless broker)');
  assert.equal(node.pane ?? null, null, 'pane is NULL (paneless broker)');
  assert.equal(node.tmux_session ?? null, null, 'tmux_session is NULL (paneless broker)');
  assert.ok(node.pi_pid != null, 'a broker pid was recorded as pi_pid');
  assert.equal(isPidAlive(node.pi_pid), true, 'the broker pid is alive');

  // Item 2: the supervision signal IS the broker pid — the stophook recorded
  // process.pid (the broker's own pid) on session_start, == the boot proof pid.
  const boot = await h.awaitBoot(id);
  assert.equal(boot.pid, node.pi_pid, 'boot-proof pid (broker process.pid) === supervised pi_pid');

  // The daemon supervises it by that pid alone: a healthy broker is left untouched.
  const before = h.bootCount(id);
  await h.tick();
  assert.equal(h.status(id), 'active', 'a healthy broker stays active across a daemon tick');
  assert.equal(h.node(id)!.pi_pid, node.pi_pid, 'pid unchanged — not revived');
  assert.equal(h.bootCount(id), before, 'no reboot');
  assert.equal(isPidAlive(node.pi_pid), true, 'broker still alive');
});

// ===========================================================================
// Item 3 (LIVE) — the in-broker inbox-watcher delivers an inbox push WITHOUT an
// exit or revive (the broker stays alive; pi.sendUserMessage → injected).
// ===========================================================================
test('LIVE wake — in-broker watcher injects an inbox push with no exit/revive', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — live wake');
  const pid = h.node(id)!.pi_pid!;
  const boots = h.bootCount(id);

  appendInbox(id, { from: 'tester', tier: 'normal', kind: 'message', label: 'live-wake', data: { body: 'do this live' } });

  // The REAL in-broker watcher (800ms poll + 1000ms debounce) delivers via
  // pi.sendUserMessage → fake-pi.injected.jsonl.
  await h.awaitWake(id, { match: /do this live/, timeoutMs: 15_000 });

  // No exit, no revive: same broker pid, still alive, no new boot.
  assert.equal(h.bootCount(id), boots, 'no new boot — the live broker was not revived');
  assert.equal(h.node(id)!.pi_pid, pid, 'pi_pid unchanged — the broker never exited');
  assert.equal(isPidAlive(pid), true, 'the broker is still alive after the live wake');
});

// ===========================================================================
// Item 3 (DORMANT) — a natural stop while awaiting a live subscription idle-
// RELEASES the broker (it exits); the daemon's second pass revives it (RESUME)
// on the next unseen inbox entry.
// ===========================================================================
test('DORMANT wake — idle-release → broker exits → daemon pass-2 reviveNode(resume) on inbox', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — dormant wake');
  const pid = h.node(id)!.pi_pid!;

  // Give the (terminal) child an ACTIVE subscription to the LIVE root, so the
  // stop-guard classifies its natural stop as 'awaiting' (a dormant orchestrator
  // awaiting a worker) → the stophook idle-releases it (paneless → no focus).
  subscribe(id, root, true);

  await h.stop(id, 'stop');

  await h.waitForStatus(id, 'idle');
  assert.equal(h.node(id)!.intent, 'idle-release', 'awaiting + unfocused → idle-release');
  await h.waitFor(() => !isPidAlive(pid), { label: 'released broker process exited' });

  // Daemon owns wake-on-message for a dormant (pi-dead) broker: an unseen inbox
  // entry + a tick → pass 2 → reviveNode(resume:true) → a fresh broker boots.
  appendInbox(id, { from: 'tester', tier: 'normal', kind: 'message', label: 'resume-me', data: { body: 'work after release' } });
  await h.tick();

  const boot2 = await h.awaitBoot(id, { minCount: 2 });
  assert.equal(boot2.resuming, true, 'the dormant revive RESUMES the saved session');
  const newPid = h.node(id)!.pi_pid!;
  assert.ok(newPid != null && isPidAlive(newPid), 'the revived broker pid is alive');
  assert.notEqual(newPid, pid, 'the revived broker is a fresh process');
});

// ===========================================================================
// Item 4 + 6 — broker CRASH → grace-revive RESUME on the saved .jsonl; ONE-
// WRITER: the crashed pid is dead BEFORE the revive launches and never
// resurrects, and the revived pid is distinct (never two engine pids at once).
// ===========================================================================
test('CRASH → grace-revive RESUME; one-writer (old pid dead before new, never resurrects)', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — crash');
  const oldPid = h.node(id)!.pi_pid!;
  assert.equal(isPidAlive(oldPid), true, 'broker alive before the crash');
  assert.equal(h.node(id)!.intent ?? null, null, 'fresh broker has a null intent (not refresh/idle-release)');
  const boots = h.bootCount(id);

  // Kill the broker out from under the daemon (a crash). Use a fixed clock so the
  // grace window is exercised deterministically.
  process.kill(oldPid, 'SIGKILL');
  await h.waitFor(() => !isPidAlive(oldPid), { label: 'crashed broker pid is dead' });
  // ONE-WRITER: the old engine pid is dead BEFORE any revive can launch.
  assert.equal(isPidAlive(oldPid), false, 'crashed pid dead before the daemon revives');

  const NOW = 5_000_000;
  await h.tick(NOW); // pid dead, intent null → handleBrokerLiveness → handleLiveWindow marks pending
  assert.equal(h.bootCount(id), boots, 'inside the grace window → NOT yet revived');

  await h.tick(NOW + REVIVE_GRACE_MS + 1); // grace elapsed → reviveNode(resume:true)
  const boot2 = await h.awaitBoot(id, { minCount: boots + 1 });
  assert.equal(boot2.resuming, true, 'grace-revive RESUMES the saved .jsonl');

  const newPid = h.node(id)!.pi_pid!;
  assert.ok(newPid != null && isPidAlive(newPid), 'the revived broker pid is alive');
  assert.notEqual(newPid, oldPid, 'the revived pid is distinct from the crashed one');
  assert.equal(isPidAlive(oldPid), false, 'one-writer: the crashed pid never resurrected');
});

// ===========================================================================
// Item 5 — clean teardown: close → hostFor(meta).teardown → `shutdown` frame →
// broker disposes + exits, socket unlinked, status canceled, daemon leaves it.
// ===========================================================================
test('clean teardown — node close → broker shutdown frame → exit, socket unlinked, not revived', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — teardown');
  const pid = h.node(id)!.pi_pid!;
  const sock = h.brokerSock(id);
  await h.waitFor(() => existsSync(sock), { label: 'broker created its view.sock' });

  // Close via the REAL CLI (resolves the node from --node; the subprocess carries
  // no TMUX_PANE). closeNode marks canceled BEFORE teardown (crash-safe order),
  // then hostFor(broker).teardown sends the `shutdown` frame.
  const res = h.cli(root, ['node', 'close', '--node', id]);
  assert.equal(res.code, 0, `node close should exit 0\n--stderr--\n${res.stderr}`);

  await h.waitFor(() => !isPidAlive(pid), { label: 'broker process exited on shutdown frame' });
  await h.waitFor(() => !existsSync(sock), { label: 'broker unlinked its socket on exit' });
  assert.equal(h.status(id), 'canceled', 'the closed node is canceled');

  // listNodes only surfaces active|idle, so a canceled broker is never supervised.
  await h.tick();
  assert.equal(h.status(id), 'canceled', 'still canceled after a daemon tick');
  assert.equal(isPidAlive(pid), false, 'the broker stays dead — never revived');
});

// ===========================================================================
// C2 forward-progress (zero-viewer path) — an unattended blocking dialog
// resolves to its default (false) IMMEDIATELY: with no controller connected the
// broker's REAL makeBrokerUiContext falls back to noOp resolution, so the engine
// never deadlocks AND never waits on a per-dialog timeout (the design §5.4
// timeout premise is false). Red/green: the OLD broker armed a setTimeout and
// resolved only after `timeout` ms; the fixed broker resolves in ~0ms. (Supports
// acceptance item 7: the existing suite stays green; this only ADDS coverage.)
// ===========================================================================
test('C2 — unattended dialog resolves to its default IMMEDIATELY (noOp), never waits on a timeout', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — dialog');
  const pid = h.node(id)!.pi_pid!;

  // Drive the fake engine to call uiContext.confirm(..., { timeout: 5000 }) with
  // NO controller. C2 fix: makeBrokerUiContext resolves the default (false) AT
  // ONCE — it does NOT arm/await the timeout. A generous < 2000ms bound is still a
  // hard fail against the old ~5000ms timeout-wait while staying robust on slow CI.
  h.fakeCmd(id, { cmd: 'dialog', timeout: 5000 });

  const results = await h.waitFor(
    () => {
      const r = h.dialogResults(id);
      return r.length > 0 ? r : null;
    },
    { timeoutMs: 15_000, label: 'unattended dialog resolved' },
  );
  assert.equal(results[0]!.resolved, false, 'unattended confirm resolves to its default (false / deny)');
  assert.ok(
    results[0]!.ms < 2000,
    `C2: resolved IMMEDIATELY (noOp), not after the 5000ms timeout — got ${results[0]!.ms}ms`,
  );
  assert.equal(isPidAlive(pid), true, 'the broker made forward progress (still alive, did not hang or exit)');
});

// ===========================================================================
// M-1 regression — a broker that DIES before session_start must surface a boot
// failure, not strand the node forever. Before the fix handleBrokerLiveness read
// pid==null UNCONDITIONALLY as "still booting", so a broker that threw before
// recording a pid/session left the node 'active' with no engine FOREVER and the
// parent waited on a dead child. The daemon must instead crash it past the boot
// grace + push a boot-failure up the spine. (Also proves M-2: the broker's fatal
// diagnostic reaches job/broker.log instead of /dev/null.)
// ===========================================================================
test('boot failure — a broker that dies before session_start is reaped, not stranded (review M-1/M-2)', { skip: !hasTmux() }, async () => {
  // A headless child whose broker throws before session_start (no pid, no session
  // EVER recorded). spawnHeadlessChildNoBoot does not awaitBoot (there is none).
  const id = await h.spawnHeadlessChildNoBoot(root, `headless worker — boot fail ${FAIL_BEFORE_SESSION_START}`);

  // M-2: the broker logs its fatal stack to job/broker.log and exits(1). Without
  // the stdio redirect this diagnostic would be lost to /dev/null.
  const brokerLog = join(h.home, 'nodes', id, 'job', 'broker.log');
  await h.waitFor(
    () => existsSync(brokerLog) && /simulated pre-session_start boot failure/.test(readFileSync(brokerLog, 'utf8')),
    { label: 'broker logged its pre-session_start failure to job/broker.log' },
  );

  // The node is stuck 'active' with a null pid and a null session — the strand.
  const n0 = h.node(id)!;
  assert.equal(n0.pi_pid ?? null, null, 'no broker pid was ever recorded');
  assert.equal(n0.pi_session_id ?? null, null, 'no session was ever recorded');

  // Inside the boot grace the daemon LEAVES it (could be the sub-second boot gap).
  const NOW = 9_000_000;
  await h.tick(NOW);
  assert.equal(h.status(id), 'active', 'inside the boot grace → daemon leaves it (boot gap)');

  // Past the boot grace with STILL no pid and no session → crash + boot failure.
  await h.tick(NOW + REVIVE_GRACE_MS + 1);
  await h.waitForStatus(id, 'dead');
  assert.equal(h.status(id), 'dead', 'a never-booted broker is reaped, not stranded active forever');

  // …and the parent (an active subscriber of the child) was told up the spine.
  const note = h.inbox(root).find((e) => /never started/.test(e.label ?? ''));
  assert.ok(note !== undefined, 'the parent received a boot-failure notice up the spine');
});

// ===========================================================================
// T8 — the `crtr attach` acceptance gate (G1–G9). Each test below drives the REAL
// detached broker process + REAL view.sock with the enriched fake engine, using
// the PRODUCTION ViewSocketClient as the controller/observer (raw node:net only
// where the client lifecycle is awkward — G7 oversized line, G8 stalled viewer).
// The engine is hosted IN-PROCESS by the broker, so engine pid == broker pid ==
// node.pi_pid == boot.pid; "engine pid unchanged" == broker pid unchanged + no new
// boot. Each test's lead comment names its gate # and the failure mode it guards.
// ===========================================================================

const liveClients: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const c of liveClients.splice(0)) {
    try {
      c.close();
    } catch {
      /* already gone */
    }
  }
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tok = (s: string): string => `${s}-${Math.random().toString(36).slice(2, 8)}`;
const frameHas = (f: BrokerToClient, token: string): boolean => JSON.stringify(f).includes(token);
const brokerPid = (id: string): number => h.node(id)!.pi_pid!;
function brokerLogText(id: string): string {
  try {
    return readFileSync(join(h.home, 'nodes', id, 'job', 'broker.log'), 'utf8');
  } catch {
    return '';
  }
}

interface Attached {
  client: ViewSocketClient;
  frames: BrokerToClient[];
  welcome: WelcomeFrame;
  send(frame: ClientToBroker): void;
  waitFrame(pred: (f: BrokerToClient) => boolean, label: string, timeoutMs?: number): Promise<BrokerToClient>;
  close(): void;
}

// Connect a ViewSocketClient to a node's running broker, hello, await welcome.
// awaitBoot returns once the boot proof is written — which is BEFORE the broker's
// server.listen() binds view.sock — so a fresh attach can momentarily race the
// bind; retry the connect on BrokerUnavailable until it is listening.
async function attach(id: string, role: ClientRole, clientId: string): Promise<Attached> {
  await h.waitFor(() => existsSync(h.brokerSock(id)), { label: `view.sock for ${id}`, timeoutMs: 20_000 });
  const frames: BrokerToClient[] = [];
  let client!: ViewSocketClient;
  for (let attempt = 0; ; attempt++) {
    client = new ViewSocketClient(id);
    client.on('frame', (f) => frames.push(f));
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
        client.connect();
      });
      break;
    } catch (err) {
      client.close();
      if (attempt >= 30) throw err;
      await delay(100);
    }
  }
  client.on('error', () => {}); // post-connect error sink (never throw uncaught)
  // Register cleanup the instant the socket is connected — BEFORE the hello/welcome
  // round-trip — so a welcome timeout cannot leak a connected socket past the test.
  liveClients.push({ close: () => client.close() });
  const waitFrame = (
    pred: (f: BrokerToClient) => boolean,
    label: string,
    timeoutMs = 15_000,
  ): Promise<BrokerToClient> => h.waitFor(() => frames.find(pred) ?? null, { label, timeoutMs });
  client.send({ type: 'hello', role, client_id: clientId });
  let welcome: WelcomeFrame;
  try {
    welcome = (await waitFrame((f) => f.type === 'welcome', `welcome for ${clientId}`)) as WelcomeFrame;
  } catch (err) {
    client.close();
    throw err;
  }
  return { client, frames, welcome, send: (f) => client.send(f), waitFrame, close: () => client.close() };
}

// Attach (as `role`) and retry until the welcome satisfies `pred` — used where the
// observable lands a beat after a prior action (G3 snapshot accrual, G5b control
// handoff after a controller detaches). Deterministic: it polls an observable.
async function attachUntil(
  id: string,
  role: ClientRole,
  clientId: string,
  pred: (a: Attached) => boolean,
  label: string,
): Promise<Attached> {
  for (let attempt = 0; ; attempt++) {
    const a = await attach(id, role, `${clientId}-${attempt}`);
    if (pred(a)) return a;
    a.close();
    if (attempt >= 40) throw new Error(`attachUntil timed out: ${label}`);
    await delay(150);
  }
}

interface RawClient {
  socket: Socket;
  frames: BrokerToClient[];
  closed: () => boolean;
  send(frame: ClientToBroker): void;
  writeRaw(data: Buffer | string): void;
  waitClosed(label: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

// A raw node:net peer. read:true decodes incoming frames; read:false leaves the
// socket PAUSED (no 'data' listener, never resumed) so it never drains — the
// stalled viewer (G8) whose backlog the broker must shed at the HWM.
async function connectRaw(id: string, opts: { read: boolean }): Promise<RawClient> {
  await h.waitFor(() => existsSync(h.brokerSock(id)), { label: `view.sock for ${id}`, timeoutMs: 20_000 });
  const frames: BrokerToClient[] = [];
  const decoder = new FrameDecoder(CLIENT_READ_CAPS);
  let isClosed = false;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(h.brokerSock(id));
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  socket.on('close', () => {
    isClosed = true;
  });
  socket.on('error', () => {
    /* close follows */
  });
  if (opts.read) {
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const f of decoder.push(chunk)) frames.push(f as BrokerToClient);
      } catch {
        /* a client-side overflow is irrelevant here */
      }
    });
  }
  const rc: RawClient = {
    socket,
    frames,
    closed: () => isClosed,
    send: (f) => {
      try {
        socket.write(encodeFrame(f));
      } catch {
        /* dead */
      }
    },
    writeRaw: (d) => {
      try {
        socket.write(d);
      } catch {
        /* dead */
      }
    },
    waitClosed: (label, timeoutMs = 15_000) => h.waitFor(() => (isClosed ? true : null), { label, timeoutMs }).then(() => undefined),
    close: () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    },
  };
  liveClients.push(rc);
  return rc;
}

/** lsof the holders of `path`, or null when lsof is unavailable (skip the fd
 *  check). Exit-non-zero with empty stdout means "no holders". */
function lsofHolders(path: string): number[] | null {
  if (spawnSync('which', ['lsof'], { stdio: 'ignore' }).status !== 0) return null;
  const out = (spawnSync('lsof', ['-t', '--', path], { encoding: 'utf8' }).stdout ?? '').trim();
  if (out === '') return [];
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n));
}

// ---------------------------------------------------------------------------
// G1 — controller drive + live relay. Guards: a controller's `prompt` runs the
// engine AND the streaming AgentSessionEvents are fanned out to the client
// VERBATIM. Failure mode: a broken relay/fan-out (viewer sees nothing).
// ---------------------------------------------------------------------------
test('G1 — controller prompt runs the engine and the streamed AgentSessionEvents relay to the client', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G1');
  const c = await attach(id, 'controller', 'g1-ctrl');
  assert.equal(c.welcome.role, 'controller', 'first controller is admitted as controller');

  const token = tok('G1-PROMPT');
  c.send({ type: 'prompt', text: token });

  // The full streaming turn relays: agent_end carrying the token proves the turn
  // ran AND its terminal frame reached the client; the intermediate types prove
  // the stream (not just a final blob) was fanned out.
  await c.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G1 agent_end carrying the prompt token');
  for (const t of ['message_start', 'message_update', 'tool_execution_start', 'tool_execution_end', 'message_end', 'turn_end', 'agent_start', 'turn_start'] as const) {
    assert.ok(c.frames.some((f) => f.type === t), `G1: client received a relayed ${t} frame`);
  }
  assert.ok(c.frames.some((f) => f.type === 'message_start' && frameHas(f, token)), 'G1: a relayed message carries the prompt token');
});

// ---------------------------------------------------------------------------
// G1b — message_update coalescing preserves ordering (regression for the F2
// attach typing-lag fix, 2026-06-09). The broker holds the latest message_update
// on a ~75ms timer; any OTHER event must flush it FIRST, so a viewer can never
// observe message_update AFTER its message_end (which would resurrect stale
// streaming text over the final message), and the LAST coalesced update must not
// be silently dropped at end-of-turn. Failure modes: a flush ordered after the
// non-update event, or a pending update discarded when message_end wins the race.
// ---------------------------------------------------------------------------
test('G1b — coalesced message_update never arrives after message_end; updates still relayed', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G1b');
  const c = await attach(id, 'controller', 'g1b-ctrl');

  const token = tok('G1B');
  // 12 updates at the fake engine's setImmediate pace — far faster than the 75ms
  // coalesce window, so coalescing genuinely engages (fewer relayed than emitted).
  h.fakeCmd(id, { cmd: 'stream', text: token, updates: 12 });
  await c.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G1b turn relayed');

  const types = c.frames.map((f) => f.type);
  const lastUpdate = types.lastIndexOf('message_update');
  const msgEnd = types.indexOf('message_end');
  assert.ok(lastUpdate >= 0, 'G1b: at least one message_update relayed (coalescing must not starve updates)');
  assert.ok(msgEnd >= 0, 'G1b: message_end relayed');
  assert.ok(
    lastUpdate < msgEnd,
    `G1b: a message_update arrived AFTER message_end (update@${lastUpdate} vs end@${msgEnd}) — the coalescer flushed out of order`,
  );
  // tool/turn/agent frames must also never precede a stale held update.
  for (const t of ['tool_execution_start', 'turn_end', 'agent_end'] as const) {
    const i = types.indexOf(t);
    assert.ok(i < 0 || lastUpdate < i, `G1b: message_update relayed after ${t}`);
  }
});

// ---------------------------------------------------------------------------
// G2 — detach leaves the engine running. Guards: `bye`/close drops ONE listener,
// never the engine. Failure mode: a detach that disposes the broker/engine.
// ---------------------------------------------------------------------------
test('G2 — detach (bye+close) leaves the broker alive + the engine still emitting; engine pid unchanged', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G2');
  const pid = brokerPid(id);
  const boots = h.bootCount(id);

  const c = await attach(id, 'controller', 'g2-ctrl');
  const p = tok('G2-PROMPT');
  c.send({ type: 'prompt', text: p });
  await c.waitFrame((f) => f.type === 'agent_end' && frameHas(f, p), 'G2 turn relayed before detach');

  c.send({ type: 'bye' });
  c.close();
  await delay(300); // let the broker process the 'close'
  assert.equal(isPidAlive(pid), true, 'G2: broker still alive after detach');
  assert.equal(brokerPid(id), pid, 'G2: engine (== broker) pid UNCHANGED across detach');
  assert.equal(h.bootCount(id), boots, 'G2: no reboot — no second engine spawned');

  // Still emitting: drive a turn with no client, then a fresh observer's snapshot
  // carries it (the engine kept running and processing after the detach).
  const after = tok('G2-AFTER-DETACH');
  h.fakeCmd(id, { cmd: 'stream', text: after });
  const o = await attachUntil(id, 'observer', 'g2-obs', (a) => JSON.stringify(a.welcome.snapshot.messages).includes(after), 'G2 post-detach message in snapshot');
  assert.ok(o.welcome.snapshot.messages.length > 0, 'G2: the engine produced a message after the detach');
  assert.equal(isPidAlive(pid), true, 'G2: broker still alive after the post-detach turn');
});

// ---------------------------------------------------------------------------
// G3 — catch-up snapshot. Guards: messages produced with NO viewer attached are
// in welcome.snapshot on reattach, and live events resume. Failure mode: a viewer
// that reattaches blind to history / gets no further events.
// ---------------------------------------------------------------------------
test('G3 — messages produced while detached appear in welcome.snapshot on reattach; live events resume', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G3');
  const past = tok('G3-DETACHED');
  h.fakeCmd(id, { cmd: 'stream', text: past }); // produced with zero viewers attached

  const o = await attachUntil(id, 'observer', 'g3-obs', (a) => JSON.stringify(a.welcome.snapshot.messages).includes(past), 'G3 detached message in snapshot');
  assert.ok(
    JSON.stringify(o.welcome.snapshot.messages).includes(past),
    'G3: welcome.snapshot.messages contains the message produced while detached',
  );

  const live = tok('G3-LIVE');
  h.fakeCmd(id, { cmd: 'stream', text: live });
  await o.waitFrame((f) => f.type === 'agent_end' && frameHas(f, live), 'G3 live events resume after reattach');
});

// ---------------------------------------------------------------------------
// G4 — arbitration + observer read. Guards: 2nd client is admitted observer, an
// observer prompt is rejected not_controller, BOTH clients receive the relay.
// Failure mode: two controllers, or an observer driving the engine, or fan-out
// that misses a viewer.
// ---------------------------------------------------------------------------
test('G4 — second client is observer; observer prompt → error{not_controller}; both receive the stream', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G4');
  const c1 = await attach(id, 'controller', 'g4-ctrl');
  assert.equal(c1.welcome.role, 'controller', 'first client holds control');
  const c2 = await attach(id, 'controller', 'g4-second'); // requests control; held → observer
  assert.equal(c2.welcome.role, 'observer', 'second client is admitted read-only observer (first-attach-wins)');

  c2.send({ type: 'prompt', text: 'observer must not drive' });
  const err = await c2.waitFrame((f) => f.type === 'error', 'G4 observer prompt rejected');
  assert.equal((err as { code: string }).code, 'not_controller', 'G4: observer prompt → error{not_controller}');

  const token = tok('G4-BROADCAST');
  c1.send({ type: 'prompt', text: token });
  await c1.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G4 controller received the stream');
  await c2.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G4 observer ALSO received the stream');
});

// ---------------------------------------------------------------------------
// G5 — dialog forward + answer. Guards: a blocking dialog reaches the controller
// as extension_ui_request and the controller's extension_ui_response unblocks the
// engine with ITS answer (not the default). Failure mode: a dialog the controller
// can't see/answer (silent deadlock).
// ---------------------------------------------------------------------------
test('G5 — controller receives an extension_ui_request, answers it, and the engine proceeds with that answer', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G5a');
  const c = await attach(id, 'controller', 'g5-ctrl');
  h.fakeCmd(id, { cmd: 'dialog', timeout: 20_000 }); // generous: the controller answers first

  const req = await c.waitFrame((f) => f.type === 'extension_ui_request', 'G5 dialog forwarded to controller');
  assert.equal((req as { method: string }).method, 'confirm', 'G5: the forwarded dialog is the confirm() the engine raised');
  const reqId = (req as { id: string }).id;
  c.send({ type: 'extension_ui_response', id: reqId, confirmed: true });

  const results = await h.waitFor(() => {
    const r = h.dialogResults(id);
    return r.length > 0 ? r : null;
  }, { label: 'G5 dialog resolved by the controller', timeoutMs: 15_000 });
  assert.equal(results[0]!.resolved, true, 'G5: the engine proceeded with the controller answer (true), not the default (false)');
});

// ---------------------------------------------------------------------------
// G5 (mid-dialog attach) — Guards: a dialog raised under a prior controller stays
// pending across that controller's detach (M2) and is delivered to whoever takes
// control next via welcome.pending_dialog. Failure mode: a pending dialog lost on
// controller handoff.
// ---------------------------------------------------------------------------
test('G5 — a controller attaching MID-dialog receives the pending dialog via welcome.pending_dialog', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G5b');
  const a = await attach(id, 'controller', 'g5b-A');
  h.fakeCmd(id, { cmd: 'dialog', timeout: 30_000 }); // stays pending long enough for the handoff
  const reqA = await a.waitFrame((f) => f.type === 'extension_ui_request', 'G5b dialog forwarded to controller A');
  const reqId = (reqA as { id: string }).id;

  a.send({ type: 'bye' });
  a.close(); // M2: detach frees control but does NOT cancel the pending dialog

  // Controller B takes control (retry covers the close→controllerId=null beat) and
  // its welcome carries the still-pending dialog.
  const b = await attachUntil(
    id,
    'controller',
    'g5b-B',
    (x) => x.welcome.role === 'controller' && x.welcome.pending_dialog != null,
    'G5b controller B takes control with the pending dialog',
  );
  assert.equal(b.welcome.pending_dialog!.id, reqId, 'G5b: welcome.pending_dialog is the same dialog raised under A');
  assert.equal((b.welcome.pending_dialog as { method: string }).method, 'confirm', 'G5b: the pending dialog is the confirm()');

  b.send({ type: 'extension_ui_response', id: reqId, confirmed: true });
  const results = await h.waitFor(() => {
    const r = h.dialogResults(id);
    return r.length > 0 ? r : null;
  }, { label: 'G5b dialog resolved by controller B', timeoutMs: 15_000 });
  assert.equal(results[0]!.resolved, true, 'G5b: controller B answered the handed-off dialog and the engine proceeded');
});

// ---------------------------------------------------------------------------
// G6 — anti-deadlock. (a) a zero-viewer dialog resolves to its default AT ONCE
// (noOp). (b) an ATTENDED dialog the controller never answers resolves on a SHORT
// per-dialog broker timeout. Guards: the engine never hangs on a dialog with no
// answerer. Failure mode: a forever-blocked turn.
// ---------------------------------------------------------------------------
test('G6 — zero-viewer dialog resolves immediately; an unanswered attended dialog resolves on the broker timeout', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G6');
  const pid = brokerPid(id);

  // (a) zero viewers → immediate noOp default (NOT the 5000ms timeout).
  h.fakeCmd(id, { cmd: 'dialog', timeout: 5000 });
  const r1 = await h.waitFor(() => (h.dialogResults(id).length >= 1 ? h.dialogResults(id) : null), { label: 'G6a zero-viewer dialog resolved', timeoutMs: 15_000 });
  assert.equal(r1[0]!.resolved, false, 'G6a: zero-viewer dialog resolves to the default (deny)');
  assert.ok(r1[0]!.ms < 2000, `G6a: resolved immediately (noOp), not after the 5000ms timeout — got ${r1[0]!.ms}ms`);

  // (b) controller attached but silent → the broker resolves on the SHORT explicit
  // per-dialog timeout (800ms), never the 120s default.
  const c = await attach(id, 'controller', 'g6-ctrl');
  h.fakeCmd(id, { cmd: 'dialog', timeout: 800 });
  await c.waitFrame((f) => f.type === 'extension_ui_request', 'G6b dialog forwarded to controller'); // received, deliberately NOT answered
  const r2 = await h.waitFor(() => (h.dialogResults(id).length >= 2 ? h.dialogResults(id) : null), { label: 'G6b attended dialog resolved on timeout', timeoutMs: 15_000 });
  assert.equal(r2[1]!.resolved, false, 'G6b: an unanswered attended dialog resolves to the default (deny)');
  assert.ok(r2[1]!.ms >= 600 && r2[1]!.ms < 5000, `G6b: resolved on the ~800ms per-dialog timeout, not instantly and not the 120s default — got ${r2[1]!.ms}ms`);
  assert.equal(isPidAlive(pid), true, 'G6: the engine made forward progress on both dialogs (still alive)');
});

// ---------------------------------------------------------------------------
// G7 — decoder overflow (guards C5 OOM). A client line over BROKER_READ_CAPS is
// cap-and-dropped; the broker survives and other clients are unaffected. Failure
// mode: an unbounded decoder buffer growing the broker to OOM.
// ---------------------------------------------------------------------------
test('G7 — an oversized client line is dropped (frame_overflow), the broker survives, other clients unaffected', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G7');
  const pid = brokerPid(id);
  const boots = h.bootCount(id);
  const survivor = await attach(id, 'observer', 'g7-survivor');

  // 26 MiB with NO newline > BROKER_READ_CAPS.maxLineBytes (24 MiB) → the bounded
  // FrameDecoder throws FrameOverflowError; the broker drops the peer.
  const bad = await connectRaw(id, { read: true });
  bad.writeRaw(Buffer.alloc(26 * 1024 * 1024, 0x78));
  await bad.waitClosed('G7 oversized peer dropped by the broker');
  await h.waitFor(() => /frame overflow/.test(brokerLogText(id)) || null, { label: 'G7 broker logged the frame-overflow drop' });

  // The broker survives and the other client is unaffected: a fresh turn relays.
  const token = tok('G7-AFTER');
  h.fakeCmd(id, { cmd: 'stream', text: token });
  await survivor.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G7 survivor still receives live frames');
  assert.equal(isPidAlive(pid), true, 'G7: the broker survived the overflow');
  assert.equal(brokerPid(id), pid, 'G7: broker pid unchanged');
  assert.equal(h.bootCount(id), boots, 'G7: no reboot');
});

// ---------------------------------------------------------------------------
// G8 — backpressure leak (guards M1). A stalled (non-reading) viewer is shed at
// the HWM (32 MiB byte cap) while the broker + other viewers are unaffected.
// Failure mode: an indefinitely-growing per-viewer queue (broker OOM) or a slow
// viewer back-pressuring the shared engine.
// ---------------------------------------------------------------------------
test('G8 — a stalled viewer is dropped at the backpressure HWM; the broker + fast viewers are unaffected', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G8');
  const pid = brokerPid(id);
  const fast = await attach(id, 'observer', 'g8-fast'); // reads normally

  // A helloed viewer that NEVER reads (paused socket). It must be in the broadcast
  // set before the flood; hello, then a short beat for the broker to process it.
  const stalled = await connectRaw(id, { read: false });
  stalled.send({ type: 'hello', role: 'observer', client_id: 'g8-stalled' });
  await delay(400);

  // A fast event stream: ~60 MiB across 240 message_update frames. The stalled
  // viewer's per-viewer backlog crosses the 32 MiB byte cap → dropped; the fast
  // viewer drains between frames (per-update yield) and survives.
  //
  // The DROP SIGNAL is the broker's own log line, NOT the stalled socket's 'close':
  // a PAUSED node socket does not surface the peer FIN/close until it is resumed,
  // so the broker-side `backpressure high-water mark exceeded` line is the
  // deterministic, race-free proof that the slow viewer was shed at the HWM.
  const token = tok('G8-FLOOD');
  h.fakeCmd(id, { cmd: 'stream', text: token, updates: 240, padBytes: 256 * 1024, tool: false });

  await h.waitFor(() => /backpressure high-water mark exceeded/.test(brokerLogText(id)) || null, { label: 'G8 broker shed the stalled viewer at the HWM', timeoutMs: 30_000 });
  // The fast viewer drained the WHOLE stream (agent_end is the terminal frame) —
  // proving only the stalled viewer was shed, while the fast one was unaffected.
  await fast.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'G8 fast viewer received the whole stream', 30_000);
  assert.equal(isPidAlive(pid), true, 'G8: the broker survived the slow-viewer flood');
  assert.equal(brokerPid(id), pid, 'G8: broker pid unchanged (the engine was not back-pressured into a restart)');
});

// ---------------------------------------------------------------------------
// G9 — the load-bearing ONE-WRITER assertion. Across attach→detach→reattach the
// broker pid AND engine pid (the same, in-process) are UNCHANGED and no second
// engine is ever spawned; the viewer holds ONLY the socket (never the .jsonl).
// Failure mode: a viewer that spawns/forks a second engine or opens the session
// .jsonl — the corruption the headless design exists to prevent.
// ---------------------------------------------------------------------------
test('G9 — one-writer: broker/engine pid stable across attach→detach→reattach; no second engine; viewer holds only the socket', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — G9');
  const pid0 = brokerPid(id);
  const boots0 = h.bootCount(id);

  const c1 = await attach(id, 'controller', 'g9-a');
  const a = tok('G9-A');
  c1.send({ type: 'prompt', text: a });
  await c1.waitFrame((f) => f.type === 'agent_end' && frameHas(f, a), 'G9 first turn relayed');
  c1.send({ type: 'bye' });
  c1.close();
  await delay(300);
  assert.equal(brokerPid(id), pid0, 'G9: broker/engine pid unchanged after detach');
  assert.equal(isPidAlive(pid0), true, 'G9: the one engine is still alive after detach');
  assert.equal(h.bootCount(id), boots0, 'G9: no second engine spawned across detach');

  // attachUntil (not a fixed sleep) synchronizes on the controller handoff: the
  // detach's controllerId=null lands a beat after close, so retry until the
  // reattach is admitted controller before driving the second prompt.
  const c2 = await attachUntil(id, 'controller', 'g9-b', (x) => x.welcome.role === 'controller', 'G9 reattach re-takes control');
  assert.equal(c2.welcome.role, 'controller', 'G9: the reattached client drives the SAME engine as controller');
  const b = tok('G9-B');
  c2.send({ type: 'prompt', text: b });
  await c2.waitFrame((f) => f.type === 'agent_end' && frameHas(f, b), 'G9 reattached controller drives the SAME engine');
  assert.equal(brokerPid(id), pid0, 'G9: STILL the same broker/engine pid after reattach (one writer, never two)');
  assert.equal(isPidAlive(pid0), true, 'G9: the single engine is alive across the full cycle');
  assert.equal(h.bootCount(id), boots0, 'G9: exactly one engine boot across attach→detach→reattach');

  // fd-check (best-effort): the viewer host (this test process) must NOT hold the
  // session .jsonl — only the broker may. With the fake engine the .jsonl is not
  // held open continuously, so the meaningful assertion is that the VIEWER never
  // appears among its holders (and any holder that exists is the broker).
  const jsonl = join(h.home, 'nodes', id, 'fake-session.jsonl');
  const holders = lsofHolders(jsonl);
  if (holders !== null) {
    assert.ok(!holders.includes(process.pid), 'G9: the attach client (this process) does NOT hold the session .jsonl');
    for (const holder of holders) {
      assert.equal(holder, pid0, 'G9: the ONLY holder of the session .jsonl is the broker/engine');
    }
  }
});
