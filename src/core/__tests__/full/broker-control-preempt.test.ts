// Run with: node --import tsx/esm --test src/core/__tests__/full/broker-control-preempt.test.ts
// (FULL tier — boots a real isolated tmux session + a real headless broker.)
//
// BUG-REGRESSION (broker-universal-host cut, design §D preemptive handoff; U1
// report mq8ftenr-5d55313d). Before the cut, `request_control` granted control
// ONLY when controllerId===null and otherwise returned a `control_held` error —
// so a second client could NEVER preempt a live (and usually idle/abandoned)
// controller. With every node now broker-hosted, a tmux pane and a web tab are
// true peers: either must be able to take control of a node the other currently
// drives. The fix makes request_control preemptive last-requester-wins — it
// ALWAYS succeeds, reassigning control to the requester and broadcasting a
// control_changed that demotes the prior controller. There is no `control_held`
// error frame anymore.
//
// Drive: controller A attaches and holds control; observer B then requests
// control. Assert control reassigns to B, a control_changed broadcasts demoting
// A, and B got NO error frame back (the old `control_held` reject is gone).
// Regression check: restore the controllerId!==null reject and B's request is
// refused (controller_id stays A / B receives an error) → these asserts go RED.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from '../helpers/harness.js';
import { createAttachKit } from '../helpers/broker-clients.js';

let h: Harness;
let id: string;

const kit = createAttachKit(() => h);
const { attach, attachUntil } = kit;

before(async () => {
  h = await createHeadlessHarness({ sessionPrefix: 'crtr-ctrlpreempt' });
  const root = h.spawnRoot('control-preempt suite root');
  id = await h.spawnHeadlessChild(root, 'headless worker — control preemption');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

test('D3 — a second client preempts the live controller (last-requester-wins); the prior controller is demoted, no control_held reject', async () => {
  // A attaches and is granted control (controllerId was null). attachUntil
  // suffixes the client_id per retry, so the broker-assigned id is the welcome's.
  const bId = 'd3-B';
  const a = await attachUntil(id, 'controller', 'd3-A', (x) => x.welcome.role === 'controller', 'A admitted controller');
  const aId = a.welcome.controller_id;
  assert.ok(aId !== null, 'A holds control after attach');

  // B attaches as an observer while A holds control (its welcome reflects A).
  const b = await attach(id, 'observer', bId);
  assert.equal(b.welcome.role, 'observer', 'B starts as an observer (A holds control)');
  assert.equal(b.welcome.controller_id, aId, 'B sees A as the current controller');

  // B preempts. Under the OLD model this returned a control_held error and B
  // never became controller; under §D it ALWAYS succeeds.
  b.send({ type: 'request_control' });

  // A is demoted via a broadcast control_changed naming B as the new controller.
  const changed = await a.waitFrame(
    (f) => f.type === 'control_changed' && (f as { controller_id: string | null }).controller_id === bId,
    'A receives control_changed demoting it to B',
  );
  assert.equal((changed as { controller_id: string | null }).controller_id, bId, 'control reassigned to B (last-requester-wins)');

  // B sees itself as the controller too (same broadcast).
  await b.waitFrame(
    (f) => f.type === 'control_changed' && (f as { controller_id: string | null }).controller_id === bId,
    'B observes itself become controller',
  );

  // The old `control_held` reject is gone: B's request drew NO error frame.
  assert.ok(
    !b.frames.some((f) => f.type === 'error'),
    'B received NO error frame — there is no control_held reject in the preemptive model',
  );
});
