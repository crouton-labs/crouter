// Run with: node --import tsx/esm --test src/core/__tests__/full/detach-focus.test.ts
//
// `crtr node demote --detach` on a node with a live viewer (Alt+C → D).
//
// BROKER-CUT ADAPTATION (taste/broker-is-the-host, 2026-06-10): every node is a
// detached headless broker. After a09b71f a managed child opens NO viewer on
// spawn — a viewer is opened on demand via `node focus`, registering its
// `crtr attach` VIEWER pane in the focuses table. The engine is NOT in a pane, so the
// pre-cut "relocate the still-running pi pane to the backstage" behavior —
// detachToBackground's engine break-pane/release path, and its isGenerating()
// gate that released a non-generating node to dormant — is DELETED. The Bug-1
// non-generating-release test that locked that gate is deleted with it (the
// behavior no longer exists; nothing to invent coverage for).
//
// What SURVIVES and is locked here: `node demote --detach` flips the node
// terminal IN PLACE and CLOSES its viewer pane + focus row, leaving the broker
// ENGINE running untouched (reconnectable by a later `focus`). This drives the
// REAL verb (subprocess, AS the node) — the actual Alt+C → D menu path — against
// a live broker node genuinely focused in a viewer pane, and proves:
//   (a) lifecycle flips terminal in place,
//   (b) the broker engine keeps running (pi_pid alive, unchanged — NOT killed),
//   (c) the viewer pane is closed + its focus row dropped (no orphaned/phantom
//       viewport row — Invariant P / F5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from '../helpers/harness.js';
import { getNode } from '../../canvas/canvas.js';
import { getFocusByNode, getFocusByPane, listFocuses } from '../../canvas/focuses.js';
import { closeDb } from '../../canvas/db.js';
import { isPidAlive } from '../../canvas/pid.js';

const SKIP = !hasTmux() ? 'tmux unavailable' : false;

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}
function paneExistsReal(pane: string): boolean {
  return (
    (spawnSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}'], { encoding: 'utf8' }).stdout ?? '').trim() ===
    pane
  );
}
// Split a throwaway pane in the harness session; return its %id. The caller pane
// `node focus` opens the viewer beside (a09b71f: spawn no longer auto-opens one).
function makePane(session: string): string {
  const r = spawnSync(
    'tmux',
    ['split-window', '-d', '-t', session, '-P', '-F', '#{pane_id}', 'sleep 100000'],
    { encoding: 'utf8' },
  );
  const pane = (r.stdout ?? '').trim();
  assert.ok(pane.startsWith('%'), `expected a %pane_id, got "${pane}" (stderr: ${r.stderr})`);
  return pane;
}

// ===========================================================================
// `crtr node demote --detach` on a node with a live viewer (Alt+C → D).
// ===========================================================================
test(
  'node demote --detach: flips terminal in place, CLOSES the viewer pane + focus row, broker engine keeps running',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-detach-focus' });
    try {
      // A resident root + a live terminal child B. spawnChild launches B's broker
      // but opens NO viewer (a09b71f) — so B has no focus row yet.
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      const b0 = h.node(B)!;
      assert.equal(b0.lifecycle, 'terminal', 'B born terminal');
      assert.equal(b0.status, 'active', 'B active after boot');
      const brokerPid = b0.pi_pid!;
      assert.ok(brokerPid != null && isPidAlive(brokerPid), 'B broker engine alive before detach');

      // Put B genuinely "on screen": `node focus` opens its one `crtr attach`
      // VIEWER pane beside a caller pane in the harness session, registering the
      // viewer focus row (§A.3) — the on-demand viewer the detach then tears down.
      const caller = makePane(h.session);
      const focusRes = h.cli(B, ['node', 'focus', B, '--pane', caller]);
      assert.equal(focusRes.code, 0, `node focus B exit 0\n${focusRes.stderr}`);

      // The viewer pane is the node's on-screen presence (the focuses row `focus`
      // registered) — NOT a node-row pane (a broker carries null placement).
      closeDb();
      const viewerRow = getFocusByNode(B);
      assert.ok(viewerRow !== null && viewerRow.pane !== null, 'B has a registered viewer focus row');
      const viewerPane = viewerRow.pane!;
      assert.equal(paneExistsReal(viewerPane), true, 'B viewer pane is live on screen');

      // --- Drive the REAL verb on the focused node (the Alt+C → D menu path). ---
      const res = h.cli(B, ['node', 'demote', '--node', B, '--pane', viewerPane, '--detach']);
      assert.equal(res.code, 0, `node demote --detach exit 0\n${res.stderr}`);
      assert.match(res.stdout, /viewer closed \(broker still running off-screen\)/, `the viewer was closed\n${res.stdout}`);

      closeDb();
      const b = getNode(B)!;
      // (a) lifecycle flipped to terminal IN PLACE (it was already terminal; the
      //     demote is idempotent on lifecycle — the point is it does not end B).
      assert.equal(b.lifecycle, 'terminal', '(a) B lifecycle=terminal after the flip');
      assert.equal(b.status, 'active', '(a) detach does NOT end the node — B stays active');

      // (b) the broker ENGINE keeps running — detach closes only the viewer, never
      //     the engine (the one-host invariant: the engine was never in a pane).
      assert.equal(b.pi_pid, brokerPid, "(b) B's broker pid is UNCHANGED (engine not killed/respawned)");
      assert.equal(isPidAlive(brokerPid), true, '(b) B broker engine still alive off-screen');

      // (c) the viewer pane is CLOSED and its focus row dropped — no orphaned /
      //     phantom viewport (A3 hazard / Invariant P).
      await h.waitForPaneGone(B);
      assert.equal(paneExistsReal(viewerPane), false, '(c) B viewer pane closed');
      assert.equal(getFocusByNode(B), null, '(c) B no longer occupies any focus (row CLOSED — Invariant P)');
      assert.equal(getFocusByPane(viewerPane), null, '(c) NO phantom focus resolves on the closed viewer %id');
      assert.equal(listFocuses().length, 0, '(c) no dangling focus rows remain');
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
