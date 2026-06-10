// Run with: node --import tsx/esm --test src/core/__tests__/broker-attach-stream.test.ts
//
// T8 — the `crtr attach` acceptance gate, gates G1/G1b/G2/G3 (controller drive,
// relay/coalescing, detach survival, catch-up snapshot). Split out of
// broker-lifecycle.test.ts; the gates are the original acceptance gate, unchanged.
//
// 3-PART HEADER (headless-retarget):
//  (1) BUG IT LOCKS — the broker's client fan-out: a controller `prompt` must run
//      the engine and the streamed AgentSessionEvents must relay VERBATIM and IN
//      ORDER to every viewer (G1); message_update coalescing must flush BEFORE any
//      other event so a stale update can never land after message_end, and the
//      last coalesced update must not be dropped (G1b, the F2 typing-lag fix);
//      detach (bye+close) must drop ONE listener, never the engine (G2); and
//      messages produced with no viewer attached must be in welcome.snapshot on
//      reattach (G3). Regression = a viewer that sees nothing / sees stale text /
//      kills the engine on detach / reattaches blind to history.
//  (2) WHY BROKER/SOCKET-LEVEL, NOT PANE/WINDOW — the relay is a pure unix-socket
//      path: ViewSocketClient ⇄ broker view.sock ⇄ in-process fake engine's
//      subscribe channel. No tmux pane, window, or pi session read is involved, so
//      the lock holds headlessly (createHeadlessHarness, no tmux). It needs a REAL
//      broker PROCESS (not just model state) because it proves the cross-process
//      frame codec + fan-out + coalescer, which is why this file keeps ONE real
//      boot — shared across all four gates to stay off the fast-tier long pole.
//  (3) HOW THE HEADLESS DRIVE STILL FAILS ON REGRESSION — each gate attaches the
//      PRODUCTION ViewSocketClient over the real socket and asserts on the frames
//      the real broker relays (order, types, snapshot, pid stability). A broken
//      relay/coalescer/detach path fails the frame assertions exactly as it would
//      under tmux; nothing here depended on a pane.
//
// The engine is hosted IN-PROCESS by the broker, so engine pid == broker pid ==
// node.pi_pid == boot.pid; "engine pid unchanged" == broker pid unchanged + no new
// boot. ONE shared broker is booted in before() and reused across all four gates
// (each just attaches fresh clients) — 1 real boot total, not 4. A gate whose
// first attach must hold control uses attachUntil(controller) so the prior gate's
// controller-detach handoff settles deterministically before it drives.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import { createAttachKit, delay, tok, frameHas } from './helpers/broker-clients.js';

let h: Harness;
let id: string; // ONE shared broker, reused across G1/G1b/G2/G3 (1 real boot, not 4)

const kit = createAttachKit(() => h);
const { attach, attachUntil } = kit;

// Admit a controller, waiting out any prior gate's controller-detach handoff.
const ctrl = (cid: string) =>
  attachUntil(id, 'controller', cid, (a) => a.welcome.role === 'controller', `${cid} admitted controller`);

before(async () => {
  h = await createHeadlessHarness({ sessionPrefix: 'crtr-brkstrm' });
  const root = h.spawnRoot('broker-attach-stream suite root');
  id = await h.spawnHeadlessChild(root, 'headless worker — attach-stream gates');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const brokerPid = (): number => h.node(id)!.pi_pid!;

// ---------------------------------------------------------------------------
// G1 — controller drive + live relay. Guards: a controller's `prompt` runs the
// engine AND the streaming AgentSessionEvents are fanned out to the client
// VERBATIM. Failure mode: a broken relay/fan-out (viewer sees nothing).
// ---------------------------------------------------------------------------
test('G1 — controller prompt runs the engine and the streamed AgentSessionEvents relay to the client', async () => {
  const c = await ctrl('g1-ctrl');
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
test('G1b — coalesced message_update never arrives after message_end; updates still relayed', async () => {
  const c = await ctrl('g1b-ctrl');

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
test('G2 — detach (bye+close) leaves the broker alive + the engine still emitting; engine pid unchanged', async () => {
  const pid = brokerPid();
  const boots = h.bootCount(id);

  const c = await ctrl('g2-ctrl');
  const p = tok('G2-PROMPT');
  c.send({ type: 'prompt', text: p });
  await c.waitFrame((f) => f.type === 'agent_end' && frameHas(f, p), 'G2 turn relayed before detach');

  c.send({ type: 'bye' });
  c.close();
  await delay(300); // let the broker process the 'close'
  assert.equal(isPidAlive(pid), true, 'G2: broker still alive after detach');
  assert.equal(brokerPid(), pid, 'G2: engine (== broker) pid UNCHANGED across detach');
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
test('G3 — messages produced while detached appear in welcome.snapshot on reattach; live events resume', async () => {
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
