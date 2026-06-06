// Run with: node --import tsx/esm --test src/core/__tests__/placement-focus.test.ts
//
// STEP 6 of the placement/focus migration: retargetFocus / openFocus / focus +
// remain-on-exit + root-boot focus #1 + the focus.ptr bridge staying consistent.
//
// Two proof tiers (mirrors placement-revive.test.ts):
//   1. PURE (no tmux): outgoingDisposition (backstage-vs-kill) and the focus.ptr
//      dual-write bridge piggybacking on a real focus row WITHOUT clobbering it
//      (the Step-6 bridge fix). Each is provably non-vacuous (a wrong impl fails).
//   2. Gated real-tmux: the hot-swap itself — screen position invariant (ZERO new
//      user windows), the two post-swap LOCATIONs, outgoing backstaged (still
//      generating) vs reaped (dormant), the Q5 vacate-old-focus path, openFocus
//      splitting a holder viewport, and the front-door round-trip with UNIQUE
//      node_id upheld. The swap is a real tmux op, so a faithful assertion needs
//      a live server; gated {skip:!hasTmux()} like §5.2.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode, setPresence } from '../canvas/canvas.js';
import {
  openFocusRow,
  getFocusByNode,
  getFocusById,
  listFocuses,
} from '../canvas/focuses.js';
import { closeDb } from '../canvas/db.js';
import { crtrHome } from '../canvas/paths.js';
import {
  outgoingDisposition,
  retargetFocus,
  openFocus,
  focus as placementFocus,
  registerRootFocus,
  focusByPane,
  type Reviver,
} from '../runtime/placement.js';
import { setFocus, getFocus } from '../runtime/presence.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;
let savedTmux: string | undefined;

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

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-placement-focus-'));
  process.env['CRTR_HOME'] = home;
  savedTmux = process.env['TMUX'];
  delete process.env['TMUX']; // pure tests exercise the deterministic no-tmux path
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  if (savedTmux !== undefined) process.env['TMUX'] = savedTmux;
});

// ---------------------------------------------------------------------------
// 1a. PURE: outgoingDisposition — backstage (still generating) vs kill.
// ---------------------------------------------------------------------------

test('outgoingDisposition: a still-generating node → BACKSTAGE (F2: keeps running off-screen)', () => {
  assert.deepEqual(outgoingDisposition({ exists: true, generating: true }), { kind: 'backstage' });
});

test('outgoingDisposition: a dormant/done node → KILL (Invariant P: not-focused + not-generating ⇒ no pane)', () => {
  assert.deepEqual(outgoingDisposition({ exists: true, generating: false }), { kind: 'kill' });
});

test('outgoingDisposition: a HOLDER / vanished node (no row) → KILL (never backstaged)', () => {
  // A wrong impl that backstaged a holder would leak a sleep pane into crtr.
  assert.deepEqual(outgoingDisposition({ exists: false, generating: true }), { kind: 'kill' });
  assert.deepEqual(outgoingDisposition({ exists: false, generating: false }), { kind: 'kill' });
});

// ---------------------------------------------------------------------------
// 1b. PURE: the focus.ptr dual-write bridge PIGGYBACKS on a real focus row
// (Step-6 fix) — setFocus must NOT clobber the pane-correct row retargetFocus
// wrote. The OLD bridge closed `existing` unconditionally, replacing the real
// row with a `__focus_ptr__` row; asserting the focus_id survives fails it.
// ---------------------------------------------------------------------------

test('focus.ptr bridge: setFocus piggybacks on a REAL focus row (never clobbers it)', () => {
  // Simulate a real row written by retargetFocus/openFocus (a non-bridge id).
  openFocusRow('real-f', '%a', 'Suser', 'A');
  setFocus('A'); // the consistency mirror retargetFocus calls at the end

  assert.equal(getFocus(), 'A', 'focus.ptr names the node');
  const row = getFocusByNode('A');
  assert.ok(row, 'A still occupies a focus');
  assert.equal(row?.focus_id, 'real-f', 'the REAL row survived (not replaced by a bridge row)');
  assert.equal(row?.pane, '%a', 'the pane-correct row is intact');
  assert.equal(listFocuses().length, 1, 'no duplicate bridge row was inserted (UNIQUE node_id)');
});

test('focus.ptr bridge: a plain setFocus (no real row) still creates the bridge row + getFocus reads it', () => {
  setFocus('Z');
  if (existsSync(join(crtrHome(), 'focus.ptr'))) unlinkSync(join(crtrHome(), 'focus.ptr'));
  assert.equal(getFocus(), 'Z', 'getFocus falls back to the canonical bridge row when the ptr is gone');
});

// ---------------------------------------------------------------------------
// 2. Gated real-tmux: the hot-swap. Two isolated sessions: `user` (the user's
// terminal) + `back` (stand-in for the backstage `crtr`). Panes run `sleep`,
// never a real pi; node pi_pid is set explicitly to control "generating".
// ---------------------------------------------------------------------------

function tmuxOut(args: string[]): string {
  return (spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? '').trim();
}
function windowIds(session: string): string[] {
  return tmuxOut(['list-windows', '-t', session, '-F', '#{window_id}']).split('\n').filter((s) => s !== '');
}
function paneExistsReal(pane: string): boolean {
  return tmuxOut(['display-message', '-p', '-t', pane, '#{pane_id}']) === pane;
}
function paneSession(pane: string): string {
  return tmuxOut(['display-message', '-p', '-t', pane, '#{session_name}']);
}
/** A live extra pane in `session:window` running sleep; returns its `%pane_id`. */
function livePane(session: string, window: string): string {
  return tmuxOut(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600']);
}

const NOREVIVE: Reviver = () => {
  throw new Error('reviver should not be called when the node has a live pin pane');
};

/** A reviver that opens a real backstage `sleep` window for the node and points
 *  its presence at it — the stand-in for reviveIntoPlacement's backstage branch. */
function backstageReviver(back: string): Reviver {
  return (id: string) => {
    const out = tmuxOut(['new-window', '-d', '-a', '-P', '-F', '#{window_id}\t#{pane_id}', '-t', `${back}:`, 'sleep 600']);
    const [w, p] = out.split('\t');
    setPresence(id, { pane: p, tmux_session: back, window: w });
  };
}

async function withSessions(
  tag: string,
  fn: (ctx: { user: string; back: string; userWindow: string; backWindow: string }) => Promise<void>,
): Promise<void> {
  const user = `crtr-pf-user-${process.pid}-${tag}`;
  const back = `crtr-pf-back-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', user, '-c', '/tmp', 'sleep 600']);
  spawnSync('tmux', ['new-session', '-d', '-s', back, '-c', '/tmp', 'sleep 600']);
  try {
    await fn({ user, back, userWindow: windowIds(user)[0]!, backWindow: windowIds(back)[0]! });
  } finally {
    spawnSync('tmux', ['kill-session', '-t', user], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', back], { stdio: 'ignore' });
  }
}

test('retargetFocus: outgoing GENERATING → backstaged; the viewport stays put (ZERO new user windows)', { skip: !hasTmux() }, async () => {
  await withSessions('gen', async ({ user, back, userWindow, backWindow }) => {
    const focusPane = livePane(user, userWindow); // R's focus pane (the viewport)
    const backPane = livePane(back, backWindow); // A's live backstage pane
    // R is the outgoing occupant, generating (a live pi_pid). A is incoming.
    createNode(node('R', { pane: focusPane, tmux_session: user, window: userWindow, status: 'active', pi_pid: process.pid, home_session: back }));
    createNode(node('A', { pane: backPane, tmux_session: back, window: backWindow, status: 'active', pi_pid: process.pid, home_session: back }));
    openFocusRow('f1', focusPane, user, 'R');
    const userBefore = windowIds(user).length;

    const res = retargetFocus('f1', 'A', NOREVIVE);

    assert.equal(res.focused, true);
    assert.equal(res.revived, false, 'A had a live pin pane — no revive');
    assert.equal(windowIds(user).length, userBefore, 'ZERO new windows in the user session (screen position invariant)');
    // A took over the viewport: it keeps its pane id, now in the user session.
    assert.equal(getFocusByNode('A')?.focus_id, 'f1', 'A now occupies the focus');
    assert.equal(getFocusByNode('A')?.pane, backPane, 'the focus row anchors A\'s (now-in-viewport) pane');
    assert.equal(getNode('A')!.pane, backPane, 'A\'s LOCATION pane id is unchanged (swap preserves %id)');
    assert.equal(paneSession(backPane), user, 'A\'s pane physically moved to the user viewport');
    assert.equal(getNode('A')!.tmux_session, user, 'A\'s LOCATION session is the viewport');
    // R was backstaged (still generating), keeping its pane id, now in `back`.
    assert.equal(getFocusByNode('R'), null, 'R no longer occupies any focus');
    assert.equal(getNode('R')!.pane, focusPane, 'R kept its pane id');
    assert.equal(paneExistsReal(focusPane), true, 'R\'s pane is alive (NOT reaped — it is still generating)');
    assert.equal(paneSession(focusPane), back, 'R\'s pane physically moved to the backstage');
    assert.equal(getNode('R')!.tmux_session, back, 'R\'s LOCATION session is the backstage');
    assert.equal(getFocus(), 'A', 'focus.ptr followed the retarget');
  });
});

test('retargetFocus: outgoing DORMANT (no live pi) → its now-backstage pane is REAPED (Invariant P)', { skip: !hasTmux() }, async () => {
  await withSessions('kill', async ({ user, back, userWindow, backWindow }) => {
    const focusPane = livePane(user, userWindow);
    const backPane = livePane(back, backWindow);
    // R is NOT generating (pi_pid null) → its pane must be reaped after the swap.
    createNode(node('R', { pane: focusPane, tmux_session: user, window: userWindow, status: 'active', pi_pid: null, home_session: back }));
    createNode(node('A', { pane: backPane, tmux_session: back, window: backWindow, status: 'active', pi_pid: process.pid, home_session: back }));
    openFocusRow('f1', focusPane, user, 'R');

    retargetFocus('f1', 'A', NOREVIVE);

    assert.equal(getFocusByNode('A')?.focus_id, 'f1', 'A took the viewport');
    assert.equal(paneSession(backPane), user, 'A\'s pane is in the viewport');
    assert.equal(paneExistsReal(focusPane), false, 'R\'s now-backstage pane was KILLED (dormant ⇒ no pane)');
    assert.equal(getNode('R')!.pane, null, 'R\'s LOCATION was nulled (Invariant P)');
    assert.equal(getNode('R')!.tmux_session, null);
  });
});

test('retargetFocus Q5: focusing a node already focused ELSEWHERE vacates its old focus (it MOVES, no dup)', { skip: !hasTmux() }, async () => {
  await withSessions('q5', async ({ user, back, userWindow, backWindow }) => {
    // R sits in focus f1 (the user viewport). M is focused in f2 (a second pane).
    const focusPane = livePane(user, userWindow);
    const mPane = livePane(back, backWindow); // M's current focus pane (live)
    createNode(node('R', { pane: focusPane, tmux_session: user, window: userWindow, status: 'active', pi_pid: process.pid, home_session: back }));
    createNode(node('M', { pane: mPane, tmux_session: back, window: backWindow, status: 'active', pi_pid: process.pid, home_session: back }));
    openFocusRow('f1', focusPane, user, 'R');
    openFocusRow('f2', mPane, back, 'M');

    // Focus M into f1 (the user viewport): M occupies f2 ≠ f1 → vacate f2.
    const res = retargetFocus('f1', 'M', backstageReviver(back));

    assert.equal(res.focused, true);
    assert.equal(getFocusById('f2'), null, 'the OLD focus f2 was vacated (closed)');
    assert.equal(paneExistsReal(mPane), false, 'M\'s old focus pane was killed (the node moved)');
    const mFocus = getFocusByNode('M');
    assert.equal(mFocus?.focus_id, 'f1', 'M now occupies ONLY f1 (UNIQUE node_id upheld)');
    assert.equal(listFocuses().filter((f) => f.node_id === 'M').length, 1, 'exactly one focus shows M');
    assert.equal(res.revived, true, 'M was revived into the backstage after its old pane was killed');
  });
});

test('openFocus: splits a NEW viewport pane beside the caller (a holder row), NOT a new window', { skip: !hasTmux() }, async () => {
  await withSessions('open', async ({ user, userWindow }) => {
    const callerPane = tmuxOut(['display-message', '-p', '-t', `${user}:${userWindow}`, '#{pane_id}']);
    const userWinBefore = windowIds(user).length;

    const f = openFocus(callerPane, {});

    assert.ok(f, 'openFocus returned a focus row');
    assert.equal(windowIds(user).length, userWinBefore, 'a SPLIT, not a new window (Q3 side-by-side)');
    assert.ok(f!.pane?.startsWith('%'), 'the row anchors the new split pane');
    assert.equal(paneExistsReal(f!.pane!), true, 'the holder pane is live');
    assert.ok(f!.node_id.startsWith('__hold_'), 'occupied by a holder until a node is retargeted in');
    // remain-on-exit is armed on the viewport window (F3).
    const win = tmuxOut(['display-message', '-p', '-t', f!.pane!, '#{window_id}']);
    assert.equal(tmuxOut(['show-window-options', '-t', win, 'remain-on-exit']), 'remain-on-exit on', 'remain-on-exit armed (F3)');
  });
});

test('focus front-door: round-trip open(register #1) → retarget in place → the focus follows the viewport', { skip: !hasTmux() }, async () => {
  await withSessions('frontdoor', async ({ user, back, userWindow, backWindow }) => {
    const rootPane = tmuxOut(['display-message', '-p', '-t', `${user}:${userWindow}`, '#{pane_id}']);
    const aPane = livePane(back, backWindow);
    createNode(node('R', { pane: rootPane, tmux_session: user, window: userWindow, status: 'active', pi_pid: process.pid, home_session: user }));
    createNode(node('A', { pane: aPane, tmux_session: back, window: backWindow, status: 'active', pi_pid: process.pid, home_session: back }));

    // Root boot registers focus #1 on the root's own pane.
    const f1 = registerRootFocus('R', rootPane, user, userWindow);
    assert.ok(f1, 'focus #1 registered');
    assert.equal(focusByPane(rootPane)?.node_id, 'R');

    // node focus A from the root's pane → retarget IN PLACE (same focus row).
    const res = placementFocus('A', { pane: rootPane, callerNode: 'R', revive: NOREVIVE });
    assert.equal(res.inPlace, true);
    assert.equal(getFocusByNode('A')?.focus_id, f1!.focus_id, 'the SAME focus row now shows A (no new focus)');
    assert.equal(listFocuses().length, 1, 'still exactly one focus (retarget, not open)');
    assert.equal(getFocusByNode('R'), null, 'R yielded the viewport');
    // The focus followed the viewport: focusByPane on A's (now-in-viewport) pane resolves it.
    assert.equal(focusByPane(aPane)?.node_id, 'A', 'the focus row tracks A\'s pane');
  });
});
