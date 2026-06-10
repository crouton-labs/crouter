// Run with: node --import tsx/esm --test src/core/__tests__/broker-dialogs.test.ts
//
// Broker dialog handling — the §5.4 C2 forward-progress proof plus the T8 attach
// gates G5/G5b/G6. Split out of broker-lifecycle.test.ts; the gates are the
// original acceptance gate, unchanged.
//
// 3-PART HEADER (headless-retarget):
//  (1) BUG IT LOCKS — the broker's blocking-dialog anti-deadlock contract: an
//      unattended (zero-viewer) confirm() resolves to its default (false)
//      IMMEDIATELY via noOp, never arming/awaiting a timeout (C2/G6a); a controller
//      receives the dialog as extension_ui_request and its extension_ui_response
//      unblocks the engine with ITS answer, not the default (G5); a dialog raised
//      under a prior controller survives that controller's detach and is delivered
//      to whoever takes control next via welcome.pending_dialog (G5b); and an
//      ATTENDED dialog the controller never answers resolves on a SHORT per-dialog
//      broker timeout, never the 120s default (G6b). Regression = an engine that
//      hangs forever on a dialog with no answerer, or a pending dialog lost on
//      controller handoff.
//  (2) WHY BROKER/SOCKET-LEVEL, NOT PANE/WINDOW — the dialog round-trip is a pure
//      async promise inside the broker's makeBrokerUiContext, forwarded/answered
//      over the view.sock to the production ViewSocketClient. No tmux pane/window
//      or pi session read is involved, so the lock holds headlessly
//      (createHeadlessHarness, no tmux). It needs a REAL broker process (the real
//      uiContext + timeout machinery), so this file keeps ONE real boot, shared
//      across all four gates.
//  (3) HOW THE HEADLESS DRIVE STILL FAILS ON REGRESSION — each gate drives the fake
//      engine to raise a real confirm() through the real broker and asserts on the
//      resolution recorded in fake-pi.dialog.jsonl (value + latency) and the frames
//      the real controller receives. A regressed timeout/noOp/handoff path fails
//      these exactly as it would under tmux; nothing here depended on a pane.
//
// ONE shared broker is booted in before() and reused across all four gates — 1 real
// boot total, not 4. Because fake-pi.dialog.jsonl is APPEND-ONLY across the shared
// broker, each gate snapshots the count before it drives (`base`) and asserts on
// the entries IT produced (results[base], results[base+1]); gates whose first
// attach must hold control use attachUntil(controller) to settle a prior gate's
// controller-detach handoff.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import { createAttachKit } from './helpers/broker-clients.js';

let h: Harness;
let id: string; // ONE shared broker, reused across C2/G5/G5b/G6 (1 real boot, not 4)

const kit = createAttachKit(() => h);
const { attach, attachUntil } = kit;

// Admit a controller, waiting out any prior gate's controller-detach handoff.
const ctrl = (cid: string) =>
  attachUntil(id, 'controller', cid, (a) => a.welcome.role === 'controller', `${cid} admitted controller`);

// dialog.jsonl is append-only across the shared broker — snapshot the count, then
// wait for AT LEAST `want` new entries and return the full (cumulative) array.
const dialogCount = () => h.dialogResults(id).length;
const awaitDialogs = (atLeast: number, label: string) =>
  h.waitFor(() => (h.dialogResults(id).length >= atLeast ? h.dialogResults(id) : null), { label, timeoutMs: 15_000 });

before(async () => {
  h = await createHeadlessHarness({ sessionPrefix: 'crtr-brkdlg' });
  const root = h.spawnRoot('broker-dialogs suite root');
  id = await h.spawnHeadlessChild(root, 'headless worker — dialog gates');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const brokerPid = (): number => h.node(id)!.pi_pid!;

// ===========================================================================
// C2 forward-progress (zero-viewer path) — an unattended blocking dialog
// resolves to its default (false) IMMEDIATELY: with no controller connected the
// broker's REAL makeBrokerUiContext falls back to noOp resolution, so the engine
// never deadlocks AND never waits on a per-dialog timeout (the design §5.4
// timeout premise is false). Red/green: the OLD broker armed a setTimeout and
// resolved only after `timeout` ms; the fixed broker resolves in ~0ms.
// ===========================================================================
test('C2 — unattended dialog resolves to its default IMMEDIATELY (noOp), never waits on a timeout', async () => {
  const pid = brokerPid();
  const base = dialogCount();

  // Drive the fake engine to call uiContext.confirm(..., { timeout: 5000 }) with
  // NO controller. C2 fix: makeBrokerUiContext resolves the default (false) AT
  // ONCE — it does NOT arm/await the timeout. A generous < 2000ms bound is still a
  // hard fail against the old ~5000ms timeout-wait while staying robust on slow CI.
  h.fakeCmd(id, { cmd: 'dialog', timeout: 5000 });

  const results = await awaitDialogs(base + 1, 'unattended dialog resolved');
  assert.equal(results[base]!.resolved, false, 'unattended confirm resolves to its default (false / deny)');
  assert.ok(
    results[base]!.ms < 2000,
    `C2: resolved IMMEDIATELY (noOp), not after the 5000ms timeout — got ${results[base]!.ms}ms`,
  );
  assert.equal(isPidAlive(pid), true, 'the broker made forward progress (still alive, did not hang or exit)');
});

// ---------------------------------------------------------------------------
// G5 — dialog forward + answer. Guards: a blocking dialog reaches the controller
// as extension_ui_request and the controller's extension_ui_response unblocks the
// engine with ITS answer (not the default). Failure mode: a dialog the controller
// can't see/answer (silent deadlock).
// ---------------------------------------------------------------------------
test('G5 — controller receives an extension_ui_request, answers it, and the engine proceeds with that answer', async () => {
  const base = dialogCount();
  const c = await ctrl('g5-ctrl');
  h.fakeCmd(id, { cmd: 'dialog', timeout: 20_000 }); // generous: the controller answers first

  const req = await c.waitFrame((f) => f.type === 'extension_ui_request', 'G5 dialog forwarded to controller');
  assert.equal((req as { method: string }).method, 'confirm', 'G5: the forwarded dialog is the confirm() the engine raised');
  const reqId = (req as { id: string }).id;
  c.send({ type: 'extension_ui_response', id: reqId, confirmed: true });

  const results = await awaitDialogs(base + 1, 'G5 dialog resolved by the controller');
  assert.equal(results[base]!.resolved, true, 'G5: the engine proceeded with the controller answer (true), not the default (false)');
});

// ---------------------------------------------------------------------------
// G5 (mid-dialog attach) — Guards: a dialog raised under a prior controller stays
// pending across that controller's detach (M2) and is delivered to whoever takes
// control next via welcome.pending_dialog. Failure mode: a pending dialog lost on
// controller handoff.
// ---------------------------------------------------------------------------
test('G5 — a controller attaching MID-dialog receives the pending dialog via welcome.pending_dialog', async () => {
  const base = dialogCount();
  const a = await ctrl('g5b-A');
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
  const results = await awaitDialogs(base + 1, 'G5b dialog resolved by controller B');
  assert.equal(results[base]!.resolved, true, 'G5b: controller B answered the handed-off dialog and the engine proceeded');
});

// ---------------------------------------------------------------------------
// G6 — anti-deadlock. (a) a zero-viewer dialog resolves to its default AT ONCE
// (noOp). (b) an ATTENDED dialog the controller never answers resolves on a SHORT
// per-dialog broker timeout. Guards: the engine never hangs on a dialog with no
// answerer. Failure mode: a forever-blocked turn.
// ---------------------------------------------------------------------------
test('G6 — zero-viewer dialog resolves immediately; an unanswered attended dialog resolves on the broker timeout', async () => {
  const pid = brokerPid();
  const base = dialogCount();

  // (a) zero viewers → immediate noOp default (NOT the 5000ms timeout).
  h.fakeCmd(id, { cmd: 'dialog', timeout: 5000 });
  const r1 = await awaitDialogs(base + 1, 'G6a zero-viewer dialog resolved');
  assert.equal(r1[base]!.resolved, false, 'G6a: zero-viewer dialog resolves to the default (deny)');
  assert.ok(r1[base]!.ms < 2000, `G6a: resolved immediately (noOp), not after the 5000ms timeout — got ${r1[base]!.ms}ms`);

  // (b) controller attached but silent → the broker resolves on the SHORT explicit
  // per-dialog timeout (800ms), never the 120s default.
  const c = await ctrl('g6-ctrl');
  h.fakeCmd(id, { cmd: 'dialog', timeout: 800 });
  await c.waitFrame((f) => f.type === 'extension_ui_request', 'G6b dialog forwarded to controller'); // received, deliberately NOT answered
  const r2 = await awaitDialogs(base + 2, 'G6b attended dialog resolved on timeout');
  assert.equal(r2[base + 1]!.resolved, false, 'G6b: an unanswered attended dialog resolves to the default (deny)');
  assert.ok(r2[base + 1]!.ms >= 600 && r2[base + 1]!.ms < 5000, `G6b: resolved on the ~800ms per-dialog timeout, not instantly and not the 120s default — got ${r2[base + 1]!.ms}ms`);
  assert.equal(isPidAlive(pid), true, 'G6: the engine made forward progress on both dialogs (still alive)');
});
