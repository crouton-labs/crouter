// Run with: node --import tsx/esm --test src/core/__tests__/placement-reconcile.test.ts
//
// STEP 3 of the placement/focus migration: pane-anchored reconciliation (Q6) —
// the robustness step. A manual move-pane/join-pane/break-pane must NEVER read
// as a node death; liveness becomes pane-existence, and reconcile makes crtr
// FOLLOW a move instead of fighting it. Covers:
//   - reconcileDecision (PURE, no tmux): pane moved → cache FOLLOWS; pane gone →
//     LOCATION nulled; never returns a stale window; legacy no-pane + live window
//     → backfills the pane from paneOfWindow.
//   - reconcile (impure shell over a real temp-db row, tmux absent): exercises
//     the gone / no-op paths through setPresence.
//   - isNodePaneAlive: pane present → paneExists path; pane null + window →
//     windowAlive fallback (with a real, live tmux window when available).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode, getRow } from '../../canvas/canvas.js';
import { closeDb } from '../../canvas/db.js';
import {
  reconcileDecision,
  reconcile,
  isNodePaneAlive,
  type CachedLocation,
  type LiveProbe,
} from '../../runtime/placement.js';
import type { NodeMeta } from '../../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
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
  home = mkdtempSync(join(tmpdir(), 'crtr-placement-'));
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
// reconcileDecision — the PURE robustness core (§2.4, Q6). No tmux.
// ---------------------------------------------------------------------------

const cached = (over: Partial<CachedLocation> = {}): CachedLocation => ({
  pane: '%5',
  tmux_session: 'crtr',
  window: '@1',
  ...over,
});
const probe = (over: Partial<LiveProbe> = {}): LiveProbe => ({
  paneLoc: null,
  windowPane: null,
  ...over,
});

test('reconcileDecision: pane MOVED → cache FOLLOWS to the new session/window (same pane id)', () => {
  const d = reconcileDecision(
    cached({ pane: '%5', tmux_session: 'crtr', window: '@1' }),
    probe({ paneLoc: { session: 'user-sess', window: '@9' } }),
  );
  assert.deepEqual(d, { kind: 'follow', pane: '%5', tmux_session: 'user-sess', window: '@9' });
});

test('reconcileDecision: pane GONE (paneLocation null) → LOCATION nulled', () => {
  const d = reconcileDecision(cached({ pane: '%5' }), probe({ paneLoc: null }));
  assert.deepEqual(d, { kind: 'gone' });
});

test('reconcileDecision: pane present + cache already current → no-op (never a stale write)', () => {
  const d = reconcileDecision(
    cached({ pane: '%5', tmux_session: 'crtr', window: '@1' }),
    probe({ paneLoc: { session: 'crtr', window: '@1' } }),
  );
  assert.deepEqual(d, { kind: 'none' });
});

test('reconcileDecision: NEVER returns a stale window — a follow always carries the LIVE location', () => {
  // Window renumbered under the same pane (@1 → @4); follow must report @4, the
  // live value, not the cached @1.
  const d = reconcileDecision(
    cached({ pane: '%5', tmux_session: 'crtr', window: '@1' }),
    probe({ paneLoc: { session: 'crtr', window: '@4' } }),
  );
  assert.equal(d.kind, 'follow');
  assert.equal((d as { window: string }).window, '@4', 'follow carries the live window, never the stale cache');
});

test('reconcileDecision: legacy no-pane + live window → BACKFILLS the pane from paneOfWindow', () => {
  const d = reconcileDecision(
    cached({ pane: null, tmux_session: 'crtr', window: '@1' }),
    probe({ windowPane: '%7' }),
  );
  assert.deepEqual(d, { kind: 'backfill', pane: '%7', tmux_session: 'crtr', window: '@1' });
});

test('reconcileDecision: no pane + no live window pane → no-op (nothing to anchor on)', () => {
  assert.deepEqual(
    reconcileDecision(cached({ pane: null, tmux_session: 'crtr', window: '@1' }), probe({ windowPane: null })),
    { kind: 'none' },
    'window has no resolvable active pane → nothing to backfill',
  );
});

test('reconcileDecision: no pane + no window at all → no-op (a dormant/inline-root row)', () => {
  assert.deepEqual(
    reconcileDecision(cached({ pane: null, tmux_session: null, window: null }), probe({ windowPane: '%7' })),
    { kind: 'none' },
    'no window to anchor a backfill on → no-op even if a stray windowPane was read',
  );
});

// ---------------------------------------------------------------------------
// reconcile / isNodePaneAlive — the impure shells. These call the real tmux
// driver, so the machine may have a live tmux server with arbitrary panes; we
// must never assume a hardcoded pane/session id is dead. Two robust strategies:
//   • "absent" assertions use a UNIQUELY-named session that cannot exist
//     (windowAlive/paneOfWindow on it are deterministically empty — robust
//     whether or not a server is running).
//   • "present/dead-pane" assertions create a real session and a real pane,
//     killing it to get a guaranteed-dead `%id`. Gated on hasTmux().
// ---------------------------------------------------------------------------

/** A session name guaranteed not to exist on any server. */
const ghostSession = `crtr-ghost-${process.pid}`;

/** Run `fn` with a fresh detached session; tear it down after. */
async function withSession(tag: string, fn: (session: string) => Promise<void>): Promise<void> {
  const session = `crtr-placement-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', '/tmp', 'sleep 600']);
  try {
    await fn(session);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  }
}

function tmuxOut(args: string[]): string {
  return (spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? '').trim();
}

/** A guaranteed-DEAD `%pane_id` inside a still-live `window` of `session`: split
 *  a fresh pane, capture its id, kill it. The window survives via its original
 *  pane, so the id is dead while its old window is alive. */
function makeDeadPane(session: string, window: string): string {
  const dead = tmuxOut(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600']);
  spawnSync('tmux', ['kill-pane', '-t', dead], { stdio: 'ignore' });
  return dead;
}

test('reconcile: an unknown node is a silent no-op', () => {
  assert.doesNotThrow(() => reconcile('ghost'));
});

test('reconcile: no pane + a non-existent window → no-op (cache left intact, not nulled)', () => {
  // A ghost session can never resolve an active pane → backfill cannot fire and
  // reconcile leaves the (already pane-less) cache exactly as it was.
  createNode(node('n', { pane: null, tmux_session: ghostSession, window: '@1' }));
  reconcile('n');
  const r = getRow('n');
  assert.equal(r?.pane, null, 'still no pane');
  assert.equal(r?.tmux_session, ghostSession, 'session left intact (no-op, not nulled)');
  assert.equal(r?.window, '@1', 'window left intact');
});

test('reconcile: a DEAD pane → LOCATION nulled (gone branch)', { skip: !hasTmux() }, async () => {
  await withSession('gone', async (session) => {
    const window = tmuxOut(['display-message', '-p', '-t', `${session}:`, '#{window_id}']);
    const dead = makeDeadPane(session, window);
    createNode(node('n', { pane: dead, tmux_session: session, window }));
    reconcile('n');
    const r = getRow('n');
    assert.equal(r?.pane, null, 'pane nulled');
    assert.equal(r?.tmux_session, null, 'session nulled');
    assert.equal(r?.window, null, 'window nulled');
  });
});

// ---------------------------------------------------------------------------
// isNodePaneAlive — pane-existence primary, windowAlive fallback.
// ---------------------------------------------------------------------------

test('isNodePaneAlive: an unknown node id is not alive', () => {
  assert.equal(isNodePaneAlive('ghost'), false);
});

test('isNodePaneAlive: pane null + a non-existent window → not alive (windowAlive fallback false)', () => {
  createNode(node('legacy', { pane: null, tmux_session: ghostSession, window: '@1' }));
  assert.equal(isNodePaneAlive('legacy'), false, 'no pane + dead window → fallback false');
});

test('isNodePaneAlive: a DEAD pane is NOT alive (paneExists path), id or row alike', { skip: !hasTmux() }, async () => {
  await withSession('dead', async (session) => {
    const window = tmuxOut(['display-message', '-p', '-t', `${session}:`, '#{window_id}']);
    const dead = makeDeadPane(session, window);
    createNode(node('n', { pane: dead, tmux_session: session, window }));
    assert.equal(isNodePaneAlive('n'), false, 'a killed pane → not alive (by id)');
    assert.equal(isNodePaneAlive(getRow('n')!), false, 'same verdict passed a NodeRow directly');
  });
});

// ---------------------------------------------------------------------------
// Real-tmux behavior (gated): the windowAlive fallback + lazy backfill, and a
// live pane FOLLOWING a manual move (the Q6 robustness core).
// ---------------------------------------------------------------------------

test('isNodePaneAlive: pane null + a LIVE window → alive via the windowAlive fallback (+ lazy backfill)', { skip: !hasTmux() }, async () => {
  await withSession('alive', async (session) => {
    const window = tmuxOut(['list-windows', '-t', session, '-F', '#{window_id}']).split('\n')[0]!;
    createNode(node('legacy', { pane: null, tmux_session: session, window }));
    assert.equal(isNodePaneAlive('legacy'), true, 'no pane but a live window → alive (legacy fallback)');

    // reconcile lazily backfills that legacy row's pane from the live window.
    reconcile('legacy');
    const got = getNode('legacy');
    assert.ok(got?.pane != null && got.pane.startsWith('%'), 'reconcile backfilled the pane from paneOfWindow');
    assert.equal(got?.tmux_session, session, 'session preserved through the backfill');
    assert.equal(got?.window, window, 'window preserved through the backfill');
  });
});

test('isNodePaneAlive + reconcile: a LIVE pane is alive and FOLLOWS a join-pane move to another window', { skip: !hasTmux() }, async () => {
  await withSession('move', async (session) => {
    // Original window W0 and its active pane P.
    const w0 = tmuxOut(['display-message', '-p', '-t', `${session}:`, '#{window_id}']);
    const pane = tmuxOut(['display-message', '-p', '-t', `${session}:${w0}`, '#{pane_id}']);
    // A second window W1 to move P into.
    const w1 = tmuxOut(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${session}:`, 'sleep 600']);
    assert.ok(pane.startsWith('%') && w0.startsWith('@') && w1.startsWith('@') && w0 !== w1);

    createNode(node('m', { pane, tmux_session: session, window: w0 }));
    assert.equal(isNodePaneAlive('m'), true, 'a live pane reads alive');

    // Manually join P into W1 — the Q6 robustness scenario. P's id survives; W0
    // (now empty) closes. This must NOT read as a death.
    spawnSync('tmux', ['join-pane', '-s', pane, '-t', `${session}:${w1}`], { stdio: 'ignore' });
    assert.equal(isNodePaneAlive('m'), true, 'a manual join-pane is NOT a death — the pane still exists');

    // reconcile FOLLOWS the move: same pane id, new window.
    reconcile('m');
    const got = getNode('m');
    assert.equal(got?.pane, pane, 'pane id is invariant across the move');
    assert.equal(got?.window, w1, 'window FOLLOWED the join-pane to W1');
    assert.equal(got?.tmux_session, session, 'still the same session');
  });
});
