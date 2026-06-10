// Run with: node --import tsx/esm --test src/core/__tests__/broker-attach-limits.test.ts
//
// T8 — the `crtr attach` acceptance gate, gates G4/G7/G8/G9 (controller
// arbitration, decoder overflow caps, backpressure shedding, and the load-bearing
// ONE-WRITER proof). Split out of broker-lifecycle.test.ts (see its header for
// the full file map); the tests are the original acceptance gate, unchanged, on
// their own isolated harness. Each test drives the REAL detached broker process +
// REAL view.sock with the enriched fake engine, using the PRODUCTION
// ViewSocketClient (helpers/broker-clients.ts) as the controller/observer — raw
// node:net only where the client lifecycle is awkward (G7 oversized line, G8
// stalled viewer). The engine is hosted IN-PROCESS by the broker, so engine pid
// == broker pid == node.pi_pid == boot.pid.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import {
  createAttachKit,
  delay,
  tok,
  frameHas,
  brokerLogText,
  lsofHolders,
} from './helpers/broker-clients.js';

let h: Harness;
let root: string;

const kit = createAttachKit(() => h);
const { attach, attachUntil, connectRaw } = kit;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-brklim' });
  root = h.spawnRoot('broker-attach-limits suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const brokerPid = (id: string): number => h.node(id)!.pi_pid!;

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
  await h.waitFor(() => /frame overflow/.test(brokerLogText(h, id)) || null, { label: 'G7 broker logged the frame-overflow drop' });

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

  await h.waitFor(() => /backpressure high-water mark exceeded/.test(brokerLogText(h, id)) || null, { label: 'G8 broker shed the stalled viewer at the HWM', timeoutMs: 30_000 });
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
