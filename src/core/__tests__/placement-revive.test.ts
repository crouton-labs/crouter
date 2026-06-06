// Run with: node --import tsx/esm --test src/core/__tests__/placement-revive.test.ts
//
// STEP 5 of the placement/focus migration: placement-aware revive (§1.4) — THE
// step that kills the "unbidden windows in my session" bug. Two proofs:
//
//   1. The PURE bug-death test (§5.1, the crown jewel): reviveTarget(focus,
//      focusPaneAlive, homeSession) — the target decision in isolation, no tmux.
//      The load-bearing assertion is the once-focused-now-unfocused CHILD: its
//      focus is gone (focusOf == null) and home_session = 'crtr' even though the
//      OLD meta.tmux_session was tainted to a user session → backstage 'crtr',
//      NOT the user session. That is the audit §F/H1 defect, structurally dead.
//
//   2. The gated real-tmux swap-out-skipped regression (§5.2, the definitive
//      proof): focus a node into a user session, terminate its pi (the focus
//      pane collapses — Step 5 has no remain-on-exit yet), wake it via
//      reviveIntoPlacement → assert ZERO new windows appear in the user session
//      across the whole sequence; the revived node lands in home_session.
//
//   Plus: backstage-into-home_session (the taint is IGNORED), respawn-into-focus
//   (F3 resume in place, no new window), and reconcileFocus following a manual
//   move of the focus pane (Q4). The gated tests drive a benign `sleep` command,
//   never a real pi — reviveNode delegates the placement decision to exactly the
//   reviveIntoPlacement exercised here.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode } from '../canvas/canvas.js';
import { openFocusRow, getFocusByNode, getFocusById } from '../canvas/focuses.js';
import { closeDb } from '../canvas/db.js';
import { reviveTarget, reviveIntoPlacement, reconcileFocus } from '../runtime/placement.js';
import { reviveInPlace } from '../runtime/revive.js';
import type { RespawnPaneOpts } from '../runtime/placement.js';
import type { FocusRow, NodeMeta } from '../canvas/types.js';

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

function focus(over: Partial<FocusRow> = {}): FocusRow {
  return { focus_id: 'f1', pane: '%a', session: 'Suser', node_id: 'M', ...over };
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-placement-revive-'));
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
// 1. The PURE bug-death test (§5.1) — reviveTarget in isolation. No tmux.
// ---------------------------------------------------------------------------

test('reviveTarget: a node on a LIVE focus → resume IN PLACE in that focus pane', () => {
  const d = reviveTarget(focus({ pane: '%a', session: 'Suser', node_id: 'M' }), true, 'crtr');
  assert.deepEqual(d, { kind: 'focus-pane', pane: '%a', session: 'Suser' });
});

test('reviveTarget: a non-focused CHILD (home_session=crtr) → BACKSTAGE crtr (never a user session)', () => {
  assert.deepEqual(reviveTarget(null, false, 'crtr'), { kind: 'backstage', session: 'crtr' });
});

test('reviveTarget: a ROOT (home_session = its own user session) → backstage THAT session (NOT the bug)', () => {
  // A root legitimately lives in its own adopted user session; reviving it there
  // is correct. The bug is a non-focused CHILD landing in a user session — not a
  // root reviving into its own.
  assert.deepEqual(reviveTarget(null, false, 'Suser-root'), { kind: 'backstage', session: 'Suser-root' });
});

test('THE BUG, structurally dead: a once-focused-now-unfocused CHILD → BACKSTAGE crtr, NOT the tainted user session', () => {
  // The exact audit §F/H1 scenario. The child WAS focused, so its OLD
  // meta.tmux_session was tainted to the user session — but the focus is gone
  // (focusOf == null) and reviveTarget keys on home_session ('crtr'), NEVER on
  // the tainted tmux_session. So the revive lands backstage in 'crtr'. THIS is
  // the assertion that proves the "unbidden windows" bug cannot recur: even with
  // a tainted tmux_session sitting in the row, the target is home_session only.
  const d = reviveTarget(null, false, 'crtr');
  assert.equal(d.kind, 'backstage');
  assert.equal((d as { session: string }).session, 'crtr');
  assert.notEqual((d as { session: string }).session, 'Suser', 'NOT the tainted user session');
});

test('A-MAJOR-1 dead (refresh-yield twin): a focused (tainted) child reviveInPlace propagates CRTR_ROOT_SESSION = home_session (backstage), so any child it spawns lands backstage — NOT the user session', () => {
  // The reviveInPlace (refresh-yield) counterpart to the reviveTarget crown
  // jewel above. A focused child M was tainted: meta.tmux_session = the USER
  // session (focus taints it), home_session = the backstage `crtr`. Pre-fix,
  // reviveInPlace re-execed M's pi with CRTR_ROOT_SESSION = meta.tmux_session =
  // the user session, so any child M then spawned opened its window in the user's
  // session (and re-tainted that grandchild's home_session). The fix sources
  // CRTR_ROOT_SESSION from home_session — the taint-immune backstage. We capture
  // the env reviveInPlace dispatches to the pane respawn and assert it carries
  // the backstage, never the tainted session. Fails against the pre-fix code.
  const back = `crtr-back-${process.pid}`;
  const user = `crtr-user-${process.pid}`; // the focus taint that must be ignored
  createNode(node('M', { home_session: back, tmux_session: user, window: '@7', pane: '%5' }));

  let captured: Record<string, string> | undefined;
  const spy = (opts: RespawnPaneOpts): boolean => {
    captured = opts.env;
    return true;
  };

  reviveInPlace('M', '%5', spy);

  assert.equal(captured?.['CRTR_ROOT_SESSION'], back, 'children spawn into the backstage home_session');
  assert.notEqual(captured?.['CRTR_ROOT_SESSION'], user, 'NEVER the tainted user session (A-MAJOR-1 dead)');
  // The node's own LOCATION is unchanged — the re-exec is in place, the pane
  // never moved, so it still sits in the (still-tainted) user session.
  assert.equal(getNode('M')!.tmux_session, user, 'LOCATION preserved (in-place re-exec); only the child env is hardened');
});

test('reviveTarget: a focus whose pane has COLLAPSED (focusPaneAlive=false) → backstage, not a dead pane', () => {
  // Step-5 limitation: a focused node that fully terminates has no remain-on-exit
  // yet, so its focus pane collapses. focusPaneAlive=false → backstage (home),
  // never the gone focus pane. Still SAFE: home_session, never a user session.
  const d = reviveTarget(focus({ pane: '%gone', session: 'Suser', node_id: 'M' }), false, 'crtr');
  assert.deepEqual(d, { kind: 'backstage', session: 'crtr' });
});

// ---------------------------------------------------------------------------
// 2. Gated real-tmux placement (skip when tmux is absent). Each test isolates
// two real sessions: `user` (the user's terminal) and `back` (the backstage that
// stands in for `crtr`). We drive reviveIntoPlacement with a benign `sleep`
// command, never a real pi.
// ---------------------------------------------------------------------------

function tmuxOut(args: string[]): string {
  return (spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? '').trim();
}

function windowIds(session: string): string[] {
  return tmuxOut(['list-windows', '-t', session, '-F', '#{window_id}']).split('\n').filter((s) => s !== '');
}

/** Hold two real, isolated sessions (`user` + `back`) open for `fn`, exposing the
 *  user session's first window + active pane, then tear both down. */
async function withUserAndBackstage(
  tag: string,
  fn: (ctx: { user: string; back: string; userWindow: string }) => Promise<void>,
): Promise<void> {
  const user = `crtr-rev-user-${process.pid}-${tag}`;
  const back = `crtr-rev-back-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', user, '-c', '/tmp', 'sleep 600']);
  spawnSync('tmux', ['new-session', '-d', '-s', back, '-c', '/tmp', 'sleep 600']);
  try {
    const userWindow = windowIds(user)[0]!;
    await fn({ user, back, userWindow });
  } finally {
    spawnSync('tmux', ['kill-session', '-t', user], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', back], { stdio: 'ignore' });
  }
}

/** Open a real, live extra pane inside `session:window` (a stand-in focus pane)
 *  running `sleep`, and return its durable `%pane_id`. */
function liveFocusPane(session: string, window: string): string {
  return tmuxOut(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600']);
}

const launch = (over: Partial<{ resuming: boolean }> = {}) => ({
  command: 'sleep 600',
  env: {} as Record<string, string>,
  cwd: '/tmp',
  name: 'm',
  resuming: false,
  ...over,
});

test('reviveIntoPlacement (backstage): a non-focused node opens in home_session, IGNORING its tainted tmux_session', { skip: !hasTmux() }, async () => {
  await withUserAndBackstage('backstage', async ({ user, back }) => {
    // A child whose tmux_session was TAINTED to the user session (as focus would
    // have done) but which is NOT focused now. home_session = the backstage.
    createNode(node('M', { home_session: back, tmux_session: user, window: null, pane: null }));
    const userBefore = windowIds(user).length;
    const backBefore = windowIds(back).length;

    const placed = reviveIntoPlacement('M', launch());

    assert.equal(windowIds(user).length, userBefore, 'ZERO new windows in the user session');
    assert.equal(windowIds(back).length, backBefore + 1, 'exactly one new window in home_session (backstage)');
    assert.equal(placed.session, back, 'placed into home_session, not the tainted user session');
    assert.ok(placed.pane?.startsWith('%'), 'a durable pane id was recorded');
    const m = getNode('M')!;
    assert.equal(m.tmux_session, back, 'LOCATION repointed to the backstage; the taint is overwritten');
    assert.equal(m.pane, placed.pane, 'the row pane matches the opened pane');
  });
});

test('§5.2 swap-out-skipped regression: focus→terminate→wake puts ZERO new windows in the user session', { skip: !hasTmux() }, async () => {
  await withUserAndBackstage('regress', async ({ user, back, userWindow }) => {
    // The bug scenario, end to end:
    //   1. M is a child focused into the user session: a real focus pane in
    //      `user`, a focus row on it, and (the taint) tmux_session=user.
    //   2. Its pi terminates → the focus pane COLLAPSES (Step 5 has no
    //      remain-on-exit yet) — modelled by killing the focus pane.
    //   3. The daemon/reviveNode wakes M → reviveIntoPlacement.
    // The fix: M lands in home_session (backstage), NOT a new window in `user`.
    const focusPane = liveFocusPane(user, userWindow);
    createNode(node('M', { home_session: back, tmux_session: user, window: userWindow, pane: focusPane }));
    openFocusRow('f1', focusPane, user, 'M');

    const userBefore = windowIds(user).length;
    const backBefore = windowIds(back).length;

    // Terminate: the focus pane collapses (no remain-on-exit in Step 5).
    spawnSync('tmux', ['kill-pane', '-t', focusPane], { stdio: 'ignore' });

    const placed = reviveIntoPlacement('M', launch({ resuming: true }));

    assert.equal(windowIds(user).length, userBefore, 'ZERO new windows opened in the user session across the sequence');
    assert.equal(windowIds(back).length, backBefore + 1, 'the revived node landed in home_session (backstage)');
    assert.equal(placed.session, back, 'reviveIntoPlacement targeted home_session, not the tainted user session');
    assert.equal(getNode('M')!.tmux_session, back, 'LOCATION repointed to the backstage');
  });
});

test('reviveIntoPlacement (focus-pane): a node on a LIVE focus resumes IN PLACE — no new window anywhere', { skip: !hasTmux() }, async () => {
  await withUserAndBackstage('inplace', async ({ user, back, userWindow }) => {
    const focusPane = liveFocusPane(user, userWindow);
    createNode(node('M', { home_session: back, tmux_session: user, window: userWindow, pane: focusPane }));
    openFocusRow('f1', focusPane, user, 'M');

    const userBefore = windowIds(user).length;
    const backBefore = windowIds(back).length;

    const placed = reviveIntoPlacement('M', launch({ resuming: true }));

    assert.equal(placed.pane, focusPane, 'resumed into the SAME focus pane id (respawn-pane -k, no new pane)');
    assert.equal(windowIds(user).length, userBefore, 'no new window in the user session (resume in place)');
    assert.equal(windowIds(back).length, backBefore, 'no new window in the backstage either');
    assert.equal(placed.session, user, 'the focus pane lives in the user session — the F3 resume stays there (desired)');
    assert.equal(getFocusByNode('M')?.pane, focusPane, 'the focus row still anchors the same pane');
  });
});

test('reconcileFocus: follows a manual move of the focus pane to another session (Q4)', { skip: !hasTmux() }, async () => {
  await withUserAndBackstage('recfocus', async ({ user, back, userWindow }) => {
    // Focus pane starts in `user`; the row caches session=user.
    const focusPane = liveFocusPane(user, userWindow);
    openFocusRow('f1', focusPane, user, 'M');

    // The user moves the focus pane into the backstage session (join-pane). The
    // pane id survives; the row's cached session is now stale.
    const backWindow = windowIds(back)[0]!;
    spawnSync('tmux', ['join-pane', '-s', focusPane, '-t', `${back}:${backWindow}`], { stdio: 'ignore' });

    reconcileFocus('f1');
    const f = getFocusById('f1');
    assert.equal(f?.pane, focusPane, 'pane id is invariant across the move');
    assert.equal(f?.session, back, 'reconcileFocus FOLLOWED the move to the backstage session');
  });
});
