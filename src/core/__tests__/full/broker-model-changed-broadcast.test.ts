// Run with: node --import tsx/esm --test src/core/__tests__/full/broker-model-changed-broadcast.test.ts
//
// FULL TIER (real-boot-bound): tmux-free, but it boots a REAL broker process,
// so it lives in full/ (CI), not the fast local loop.
//
// BUG-REGRESSION (real, observed 2026-06-11 in `crtr attach`): switching the
// model (/model <provider/id> or the picker) visibly did nothing — the viewer's
// status bar kept showing the OLD model until some unrelated event happened to
// arrive.
//
// 3-PART HEADER:
//  (1) BUG IT LOCKS — pi emits no AgentSessionEvent for a model switch, and the
//      broker's `set_model`/`cycle_model` handlers replied with only a bare ack
//      to the REQUESTING client. The new model reached no viewer at all: the
//      broker now broadcasts a `model_changed` frame (mirroring
//      snapshot.state.model) to every client after the engine accepts the switch.
//  (2) WHY BROKER/SOCKET-LEVEL, NOT PANE — the regression is pure frame-plumbing
//      on view.sock: a controller `set_model` in, an ack + `model_changed`
//      fan-out. No tmux pane or TUI is involved, so the lock holds headlessly
//      (createHeadlessHarness + the fake engine, whose registry stub resolves
//      any `provider/id` and whose setModel stores what it is handed).
//  (3) HOW IT FAILS ON REGRESSION — pre-fix, NO `model_changed` frame ever
//      arrives at either the controller or the observer (both waits time out);
//      the ack alone still passing would not satisfy the broadcast asserts.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from '../helpers/harness.js';
import { createAttachKit } from '../helpers/broker-clients.js';

let h: Harness;
let id: string;

const kit = createAttachKit(() => h);
const { attachUntil } = kit;

before(async () => {
  h = await createHeadlessHarness({ sessionPrefix: 'crtr-brkmodel' });
  const root = h.spawnRoot('model-changed-broadcast suite root');
  id = await h.spawnHeadlessChild(root, 'headless worker — model_changed broadcast gate');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

test('set_model acks the requester and broadcasts model_changed to every viewer', async () => {
  const c = await attachUntil(
    id,
    'controller',
    'model-ctrl',
    (a) => a.welcome.role === 'controller',
    'model-ctrl admitted controller',
  );
  const o = await attachUntil(
    id,
    'observer',
    'model-obs',
    (a) => a.welcome.role === 'observer',
    'model-obs admitted observer',
  );

  c.send({ type: 'set_model', model: 'anthropic/fake-fable' });

  const ack = await c.waitFrame((f) => f.type === 'ack' && f.for === 'set_model', 'set_model ack');
  assert.ok(ack.type === 'ack' && ack.ok, 'set_model acked ok');

  // BOTH the requester and the observer hear the switch. Pre-fix: no
  // model_changed frame exists, so neither wait ever resolves.
  const cm = await c.waitFrame(
    (f) => f.type === 'model_changed',
    'controller receives model_changed',
  );
  assert.ok(cm.type === 'model_changed' && cm.model === 'fake-fable', 'controller sees the new model id');
  const om = await o.waitFrame(
    (f) => f.type === 'model_changed',
    'observer receives model_changed',
  );
  assert.ok(om.type === 'model_changed' && om.model === 'fake-fable', 'observer sees the new model id');
});
