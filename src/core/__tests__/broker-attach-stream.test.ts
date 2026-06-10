// Run with: node --import tsx/esm --test src/core/__tests__/broker-attach-stream.test.ts
//
// T8 — the `crtr attach` acceptance gate, gates G1/G1b/G2/G3 (controller drive,
// relay/coalescing, detach survival, catch-up snapshot). Split out of
// broker-lifecycle.test.ts (see its header for the full file map); the tests are
// the original acceptance gate, unchanged, on their own isolated harness. Each
// test drives the REAL detached broker process + REAL view.sock with the enriched
// fake engine, using the PRODUCTION ViewSocketClient (helpers/broker-clients.ts)
// as the controller/observer. The engine is hosted IN-PROCESS by the broker, so
// engine pid == broker pid == node.pi_pid == boot.pid; "engine pid unchanged" ==
// broker pid unchanged + no new boot. Each test's lead comment names its gate #
// and the failure mode it guards.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import { createAttachKit, delay, tok, frameHas } from './helpers/broker-clients.js';

let h: Harness;
let root: string;

const kit = createAttachKit(() => h);
const { attach, attachUntil } = kit;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-brkstrm' });
  root = h.spawnRoot('broker-attach-stream suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const brokerPid = (id: string): number => h.node(id)!.pi_pid!;

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
