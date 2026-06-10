// Run with: node --import tsx/esm --test src/core/__tests__/broker-dialogs.test.ts
//
// Broker dialog handling — the §5.4 C2 forward-progress proof plus the T8 attach
// gates G5/G5b/G6. Split out of broker-lifecycle.test.ts (see its header for the
// full file map); the tests are the original acceptance gate, unchanged, on their
// own isolated harness. The attach-client helpers live in
// helpers/broker-clients.ts (the PRODUCTION ViewSocketClient, §0 one-writer: a
// viewer holds ONLY a socket).

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import { createAttachKit } from './helpers/broker-clients.js';

let h: Harness;
let root: string;

const kit = createAttachKit(() => h);
const { attach, attachUntil } = kit;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-brkdlg' });
  root = h.spawnRoot('broker-dialogs suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const brokerPid = (id: string): number => h.node(id)!.pi_pid!;

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
