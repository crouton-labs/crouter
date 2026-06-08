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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { appendInbox } from '../feed/inbox.js';
import { isPidAlive } from '../canvas/pid.js';
import { FAIL_BEFORE_SESSION_START } from './fixtures/fake-engine.js';

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
// §5.4 forward-progress (zero-viewer path) — an unattended blocking dialog
// resolves to its default (false) on its own timeout: the broker's REAL
// dialogPromise/makeBrokerUiContext arms a setTimeout when no controller is
// connected, so the engine never deadlocks. (Supports acceptance item 7: the
// existing suite stays green; this only ADDS coverage.)
// ===========================================================================
test('unattended dialog resolves to its default on timeout — forward progress, no deadlock', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — dialog');
  const pid = h.node(id)!.pi_pid!;

  // Drive the fake engine to call uiContext.confirm(...,{timeout:600}); with NO
  // controller, dialogPromise resolves the default (false) after ~600ms.
  h.fakeCmd(id, { cmd: 'dialog', timeout: 600 });

  const results = await h.waitFor(
    () => {
      const r = h.dialogResults(id);
      return r.length > 0 ? r : null;
    },
    { timeoutMs: 15_000, label: 'unattended dialog resolved' },
  );
  assert.equal(results[0]!.resolved, false, 'unattended confirm resolves to its default (false)');
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
