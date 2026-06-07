// Run with: node --import tsx/esm --test src/core/__tests__/placement-teardown.test.ts
//
// STEP 7 of the placement/focus migration: the lifecycle-successor + teardown
// verbs (§1.6/§2.3, flow (e)). Two PURE surfaces (no tmux — pane ids below are
// never realized, so closePane no-ops and only the DB effects are asserted):
//
//   • handFocusToManager(focusId, managerId) — the §1.6 manager-takeover, a PURE
//     DB occupant swap. Returns true (TAKEOVER) only when a successor will
//     GENUINELY claim the frozen pane — a live manager (swapped in) or a dormant
//     manager the daemon will revive (status='idle' && intent='idle-release').
//     Returns false (caller disarms the freeze + closes the focus) for every
//     other case; each guard is asserted distinctly.
//   • tearDownNode(nodeId) — close/reset teardown: close the focus row it
//     occupies and null its LOCATION.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode } from '../canvas/canvas.js';
import { openFocusRow, getFocusByNode, getFocusById } from '../canvas/focuses.js';
import { closeDb } from '../canvas/db.js';
import { handFocusToManager, tearDownNode } from '../runtime/placement.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}
function tmuxOut(args: string[]): string {
  return (spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? '').trim();
}
function paneSession(pane: string): string {
  return tmuxOut(['display-message', '-p', '-t', pane, '#{session_name}']);
}
function windowCount(session: string): number {
  return tmuxOut(['list-windows', '-t', session, '-F', '#{window_id}']).split('\n').filter((s) => s !== '').length;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-placement-teardown-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

// ---------------------------------------------------------------------------
// handFocusToManager (pure DB) — §1.6 manager-takeover + its three false-guards.
// ---------------------------------------------------------------------------

test('handFocusToManager: dormant idle-release manager → TAKEOVER (repoints the row, returns true)', () => {
  openFocusRow('f', '%m', 'Sa', 'M');
  // The daemon's superviseTick second pass revives a node ONLY when it is idle +
  // idle-release (crtrd.ts ~309) — that is the ONLY dormant manager that will be
  // brought into the frozen %m, so it is the ONLY dormant takeover that returns true.
  createNode(node('mgr', { status: 'idle', intent: 'idle-release' }));

  assert.equal(handFocusToManager('f', 'mgr'), true, 'a manager the daemon WILL revive takes the focus');
  assert.equal(getFocusByNode('mgr')?.focus_id, 'f', 'the row now shows the manager');
  assert.equal(getFocusByNode('M'), null, 'the finished node no longer occupies it');
  // Non-vacuous: a no-op impl returns false / leaves M as occupant → both the
  // return value and the occupant assert fail.
});

test('handFocusToManager: managerId null → false, occupant UNCHANGED', () => {
  openFocusRow('f', '%m', 'Sa', 'M');

  assert.equal(handFocusToManager('f', null), false, 'no manager → caller must close the focus');
  assert.equal(getFocusById('f')?.node_id, 'M', 'occupant unchanged');
  // Non-vacuous: an impl that skipped the null guard would either return true or
  // setFocusOccupant(f, null) → NOT NULL violation; the clean false + unchanged
  // occupant fail against both.
});

test('handFocusToManager: manager IS the focus occupant → false (no self-handoff)', () => {
  openFocusRow('f', '%m', 'Sa', 'M');

  assert.equal(handFocusToManager('f', 'M'), false, 'handing a node its own focus is a no-op false');
  assert.equal(getFocusById('f')?.node_id, 'M', 'occupant unchanged');
  // Non-vacuous: an impl missing the `managerId === f.node_id` guard would return
  // true.
});

test('handFocusToManager: manager already focused ELSEWHERE → false, neither focus moved (UNIQUE node_id)', () => {
  openFocusRow('fM', '%m', 'Sa', 'M');
  openFocusRow('fMgr', '%g', 'Sb', 'mgr'); // mgr already occupies its own viewport

  assert.equal(handFocusToManager('fM', 'mgr'), false, 'a busy manager is not moved — caller closes');
  assert.equal(getFocusById('fM')?.node_id, 'M', "M's focus is not handed over");
  assert.equal(getFocusByNode('mgr')?.focus_id, 'fMgr', "mgr's other focus is untouched");
  // Non-vacuous: an impl missing the already-focused guard would setFocusOccupant
  // (fM, mgr) → UNIQUE(node_id) violation (mgr already in fMgr), so the expected
  // clean false + both rows intact fail.
});

// ---------------------------------------------------------------------------
// MAJOR 1 — the LIVE-vs-DORMANT manager split inside handFocusToManager.
// ---------------------------------------------------------------------------

test('handFocusToManager: LIVE backstage manager → swaps its pane INTO the focus slot (MAJOR 1)', { skip: !hasTmux() }, () => {
  // Two real sessions: `user` (the viewport %m sits frozen in) + `back` (where
  // the manager's pi runs live, the normal multi-child state). The swap is a
  // real tmux op, so this needs a live server (gated like the other §5.2 tests).
  const user = `crtr-hfm-user-${process.pid}`;
  const back = `crtr-hfm-back-${process.pid}`;
  spawnSync('tmux', ['new-session', '-d', '-s', user, '-c', '/tmp', 'sleep 600']);
  spawnSync('tmux', ['new-session', '-d', '-s', back, '-c', '/tmp', 'sleep 600']);
  try {
    const userWindow = tmuxOut(['list-windows', '-t', user, '-F', '#{window_id}']).split('\n')[0]!;
    const backWindow = tmuxOut(['list-windows', '-t', back, '-F', '#{window_id}']).split('\n')[0]!;
    const focusPane = tmuxOut(['display-message', '-p', '-t', `${user}:${userWindow}`, '#{pane_id}']); // M's frozen focus pane (%m, the viewport)
    const mgrPane = tmuxOut(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${back}:${backWindow}`, 'sleep 600']); // mgr's LIVE backstage pane

    createNode(node('M', { pane: focusPane, tmux_session: user, window: userWindow, status: 'done' }));
    createNode(node('mgr', { pane: mgrPane, tmux_session: back, window: backWindow, status: 'active', pi_pid: process.pid }));
    openFocusRow('f', focusPane, user, 'M');
    const userWinsBefore = windowCount(user);

    assert.equal(handFocusToManager('f', 'mgr'), true, 'a LIVE manager takes the focus');

    // Pure-DB takeover (also covered ungated above): occupant repointed M → mgr.
    assert.equal(getFocusByNode('mgr')?.focus_id, 'f', 'the manager occupies the focus row');
    assert.equal(getFocusByNode('M'), null, 'the finished node no longer occupies it');
    // The synchronous swap (MAJOR 1): the focus row re-anchors to mgr's pane,
    // which has physically moved into the user viewport; the old focus pane (%m)
    // swapped down into the backstage slot; mgr's presence is the OLD focus slot.
    assert.equal(getFocusById('f')?.pane, mgrPane, 'focus row re-anchored to the manager pane (swap)');
    assert.equal(paneSession(mgrPane), user, 'the manager pane physically moved into the user viewport');
    assert.equal(getNode('mgr')!.window, userWindow, 'manager presence window == the OLD focus slot window');
    assert.equal(getNode('mgr')!.tmux_session, user, 'manager presence session == the viewport');
    assert.equal(paneSession(focusPane), back, '%m (the dead node\'s pane) swapped DOWN into the backstage slot');
    assert.equal(windowCount(user), userWinsBefore, 'no new user window — a swap, not an open (screen position invariant)');
    // Non-vacuous: the pre-MAJOR-1 impl only repointed the occupant and deferred
    // the physical revive to the daemon — but the daemon revives ONLY dormant
    // managers, so a LIVE one is never brought in. That impl leaves the focus row
    // pane == focusPane, mgrPane still in `back`, %m frozen in the viewport, and
    // mgr's presence at the backstage — every swap assert above fails against it.
  } finally {
    spawnSync('tmux', ['kill-session', '-t', user], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', back], { stdio: 'ignore' });
  }
});

test('handFocusToManager: DORMANT idle-release manager (dead pane) → occupant repointed, NO swap, focus pane UNCHANGED', () => {
  openFocusRow('f', '%focus', 'Suser', 'M');
  // The manager is dormant + idle-release (the ONLY dormant manager the daemon
  // revives): its pane is recorded but NOT a live tmux pane (its dead-pi window
  // collapsed) and its pi is dead. isNodePaneAlive(mgr) is therefore false, so the
  // live-swap is skipped — the external daemon later respawns it into the frozen
  // %focus, exactly because status='idle' && intent='idle-release'.
  createNode(node('mgr', { pane: '%mgr-dead', tmux_session: 'back', window: '@wb', pi_pid: null, status: 'idle', intent: 'idle-release' }));

  assert.equal(handFocusToManager('f', 'mgr'), true, 'still a takeover (occupant repointed)');
  assert.equal(getFocusByNode('mgr')?.focus_id, 'f', 'the manager occupies the focus row (DB repoint)');
  assert.equal(getFocusByNode('M'), null, 'the finished node no longer occupies it');
  // The split: with no physical swap, the focus row stays anchored on the ORIGINAL
  // frozen focus pane (the pane the daemon will respawn the manager INTO) and the
  // manager's backstage presence is left untouched.
  assert.equal(getFocusById('f')?.pane, '%focus', 'focus row pane NOT re-anchored to the manager pane (no swap)');
  assert.equal(getNode('mgr')!.pane, '%mgr-dead', 'manager presence pane unchanged');
  assert.equal(getNode('mgr')!.window, '@wb', 'manager presence window unchanged (never moved into a viewport)');
  // Non-vacuous: an impl that re-anchored the focus row to the manager pane in
  // the DB (or wrote the manager's presence to the viewport) regardless of a real
  // physical swap would set f.pane='%mgr-dead' and mgr.window=the focus window —
  // both asserts fail. Proves the swap gates on PANE LIVENESS, not merely on the
  // manager having a pane.
});

// ---------------------------------------------------------------------------
// BUG REGRESSION (dead-focus-pane): handFocusToManager must return FALSE — so
// the stophook caller runs closeFocusToShell to DISARM remain-on-exit and the
// pane REAPS on exit — whenever NO successor will actually claim the frozen pane.
// Pre-fix it repointed the occupant and returned true for ANY non-null,
// not-already-focused manager (even done/dead/canceled, idle-but-not-idle-
// release, or a live-but-paneless inline root). The daemon revives NONE of those
// into the frozen pane, so closeFocusToShell was skipped, remain-on-exit stayed
// ON, and the focus pane FROZE forever as a dead pane with no reaper.
// Diagnosis: nodes/mq32wjve-68de0c31/context/dead-focus-pane-fix.md
// ---------------------------------------------------------------------------

test('handFocusToManager (BUG REGRESSION): a manager the daemon will NEVER revive → false, occupant UNCHANGED (caller disarms + reaps)', () => {
  openFocusRow('f', '%focus', 'Suser', 'M'); // M occupies the frozen focus pane

  // (a) DONE manager — the daemon ignores done nodes entirely (the most common
  //     trigger: demoting a child to terminal whose manager already finished).
  createNode(node('mgrDone', { status: 'done', pane: '%d', tmux_session: 'back', window: '@wd' }));
  assert.equal(handFocusToManager('f', 'mgrDone'), false, 'a DONE manager will never be revived → caller must disarm + reap');
  assert.equal(getFocusByNode('mgrDone'), null, 'a DONE manager is NOT repointed into the focus row');

  // (b) DORMANT but NOT idle-release — idle with a different intent; crtrd's
  //     second pass (idle && idle-release) skips it, so it never enters the pane.
  createNode(node('mgrIdleDone', { status: 'idle', intent: 'done', pane: '%i', tmux_session: 'back', window: '@wi' }));
  assert.equal(handFocusToManager('f', 'mgrIdleDone'), false, 'idle but NOT idle-release → daemon never revives it → false');
  assert.equal(getFocusByNode('mgrIdleDone'), null, 'a non-idle-release manager is NOT repointed');

  // (c) LIVE-but-PANELESS manager (an inline root, pane == null) — the live-swap
  //     branch is skipped (no pane to swap) and, being active not idle-release,
  //     the daemon never revives it either.
  createNode(node('mgrPaneless', { status: 'active', pi_pid: process.pid, pane: null }));
  assert.equal(handFocusToManager('f', 'mgrPaneless'), false, 'a live-but-paneless inline root cannot claim the pane → false');
  assert.equal(getFocusByNode('mgrPaneless'), null, 'a paneless manager is NOT repointed');

  // The occupant is untouched across all three → the caller (canvas-stophook
  // agent_end done-branch) runs closeFocusToShell, disarming the freeze.
  assert.equal(getFocusById('f')?.node_id, 'M', 'M still occupies its focus → caller disarms remain-on-exit + closes the row');
  // Non-vacuous: the pre-fix impl repointed the occupant + returned true for each
  // of (a)/(b)/(c), so every false return AND every "NOT repointed" assert fails
  // against it — and that stray true would have stranded the pane frozen forever.
});

// ---------------------------------------------------------------------------
// tearDownNode (pure DB; no tmux — pane is null so closePane never runs).
// ---------------------------------------------------------------------------

test('tearDownNode: closes the focus row M occupied and nulls its LOCATION', () => {
  createNode(node('M', { pane: null, window: null }));
  openFocusRow('fM', null, 'Sa', 'M'); // M occupies a focus row

  tearDownNode('M');

  assert.equal(getFocusByNode('M'), null, 'the focus row M occupied is closed');
  const m = getNode('M')!;
  assert.equal(m.pane ?? null, null, 'pane nulled');
  assert.equal(m.window ?? null, null, 'window nulled');
  assert.equal(m.tmux_session ?? null, null, 'session nulled');
  // Non-vacuous: an impl that skips closeFocusRow leaves fM → getFocusByNode('M')
  // is non-null.
});
