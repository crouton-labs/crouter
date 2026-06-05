// Run with: node --import tsx/esm --test src/core/__tests__/relaunch.test.ts
//
// Covers the `/new`-in-a-root relaunch (option C) + clean-exit termination
// semantics. tmux/respawn is unavailable in CI, so the respawn is an INJECTED
// test double (RelaunchDeps.relaunchRootInPane) and every assertion is on the
// DB / edge / disk effects.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNode,
  getNode,
  subscribe,
  subscriptionsOf,
  view,
  listNodes,
} from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { reportsDir, inboxPath, contextDir } from '../canvas/paths.js';
import { roadmapPath } from '../runtime/roadmap.js';
import {
  relaunchRoot,
  handleNewSession,
  markCleanExitDone,
  reapDescendants,
} from '../runtime/reset.js';
import { getFocus } from '../runtime/presence.js';
import { renderForest } from '../canvas/render.js';
import type { NodeMeta, NodeStatus } from '../canvas/types.js';

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

/** A respawn double that records its calls and never throws (dispatch ok). */
function okRespawn() {
  const calls: Array<{ nodeId: string; pane: string }> = [];
  return {
    calls,
    fn: (nodeId: string, pane: string): void => { calls.push({ nodeId, pane }); },
  };
}

/** A respawn double that simulates a dispatch failure (throws). */
function throwingRespawn() {
  const calls: Array<{ nodeId: string; pane: string }> = [];
  return {
    calls,
    fn: (nodeId: string, pane: string): void => {
      calls.push({ nodeId, pane });
      throw new Error('respawn-pane dispatch failed');
    },
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-relaunch-'));
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
// #1 — relaunchRoot parks the old root, keeps edges, creates a fresh root
// ---------------------------------------------------------------------------

test('relaunchRoot parks the old root (done, edges intact, no wipe) and mints a fresh root', () => {
  createNode(node('root', {
    parent: null,
    lifecycle: 'resident',
    mode: 'orchestrator',
    pi_session_id: 'root-sess',
    pi_session_file: '/abs/root-sess.jsonl',
    tmux_session: 'crtr',
    window: '@7',
  }));
  createNode(node('child', { parent: 'root' }));
  createNode(node('grand', { parent: 'child' }));
  subscribe('root', 'child', true);
  subscribe('child', 'grand', true);

  // Working state on the old root that parking must PRESERVE (no wipe).
  writeFileSync(roadmapPath('root'), '# Roadmap\nold goal\n');
  writeFileSync(inboxPath('root'), '{"ts":"x","from":"child","tier":"normal","kind":"update","label":"hi"}\n');
  writeFileSync(join(reportsDir('root'), '20260101T000000-update.md'), 'a report');

  const respawn = okRespawn();
  const res = relaunchRoot('root', 'test-pane', { relaunchRootInPane: respawn.fn });

  assert.ok(res !== null, 'relaunchRoot returns the new node id');
  const newId = res!.newNodeId;
  assert.notEqual(newId, 'root', 'a FRESH id, not the old one');

  // Respawn was dispatched against the NEW node in the given pane.
  assert.deepEqual(respawn.calls, [{ nodeId: newId, pane: 'test-pane' }]);

  // Old root: parked done, window detached, pi_session_id UNCHANGED (resumable).
  const old = getNode('root');
  assert.equal(old?.status, 'done', 'old root parked done');
  assert.equal(old?.window, null, 'old root window detached');
  assert.equal(old?.tmux_session, null, 'old root tmux_session detached');
  assert.equal(old?.intent, null, 'old root intent cleared');
  assert.equal(old?.pi_session_id, 'root-sess', 'pi_session_id preserved (resumable)');
  assert.equal(old?.pi_session_file, '/abs/root-sess.jsonl', 'pi_session_file preserved (resumable by path)');
  assert.equal(old?.parent, null, 'old root stays a root');

  // Descendants: DONE (not dead), but edges intact.
  assert.equal(getNode('child')?.status, 'done', 'child marked done (not a fault)');
  assert.equal(getNode('grand')?.status, 'done', 'grand marked done (not a fault)');
  assert.deepEqual(subscriptionsOf('root').map((s) => s.node_id), ['child'], 'root→child edge intact');
  assert.deepEqual(subscriptionsOf('child').map((s) => s.node_id), ['grand'], 'child→grand edge intact');

  // Old root working state PRESERVED (history, no wipe).
  assert.equal(existsSync(roadmapPath('root')), true, 'roadmap preserved');
  assert.equal(existsSync(inboxPath('root')), true, 'inbox preserved');
  assert.equal(existsSync(join(reportsDir('root'), '20260101T000000-update.md')), true, 'report preserved');

  // New root: fresh base resident, active, intent=refresh, empty context dir,
  // spawned_by=old, focused.
  const fresh = getNode(newId);
  assert.equal(fresh?.parent, null, 'new node is a root');
  assert.equal(fresh?.mode, 'base');
  assert.equal(fresh?.lifecycle, 'resident');
  assert.equal(fresh?.status, 'active');
  assert.equal(fresh?.intent, 'refresh', 'safety-net intent until boot');
  assert.equal(fresh?.spawned_by, 'root', 'audit-only successor link to old root');
  assert.equal(fresh?.pi_pid, null, 'no pi yet');
  assert.equal(fresh?.tmux_session, 'crtr', 'adopted the old root window location');
  assert.equal(fresh?.window, '@7');
  assert.ok(fresh?.launch, 'a fresh base launch spec was written');
  assert.equal(readdirSync(contextDir(newId)).length, 0, 'fresh empty context dir');

  assert.equal(getFocus(), newId, 'focus follows content to the new root');
});

// ---------------------------------------------------------------------------
// #1b — handleNewSession success branch: root WITH a pane routes to relaunch
// ---------------------------------------------------------------------------

test('handleNewSession on a root with a pane returns path:relaunch + parks old, mints fresh', () => {
  createNode(node('root', {
    parent: null,
    lifecycle: 'resident',
    mode: 'orchestrator',
    pi_session_id: 'root-sess',
    tmux_session: 'crtr',
    window: '@7',
  }));
  createNode(node('child', { parent: 'root' }));
  subscribe('root', 'child', true);

  const respawn = okRespawn();
  const res = handleNewSession('root', 'newsess', 'test-pane', { relaunchRootInPane: respawn.fn });

  // The policy router's success return shape: relaunch + a fresh new node id.
  assert.equal(res.path, 'relaunch', 'root + pane routes to option C relaunch');
  assert.ok(res.newNodeId, 'newNodeId set on the relaunch path');
  assert.notEqual(res.newNodeId, 'root', 'a FRESH id, not the old root');

  // Respawn dispatched against the new node in the pane.
  assert.deepEqual(respawn.calls, [{ nodeId: res.newNodeId, pane: 'test-pane' }]);

  // Parked-old + fresh-new end state.
  const old = getNode('root');
  assert.equal(old?.status, 'done', 'old root parked done');
  assert.equal(old?.window, null, 'old root window detached');
  assert.equal(old?.pi_session_id, 'root-sess', 'pi_session_id preserved (resumable)');
  assert.equal(getNode('child')?.status, 'done', 'descendant reaped done');

  const fresh = getNode(res.newNodeId!);
  assert.equal(fresh?.parent, null, 'new node is a root');
  assert.equal(fresh?.status, 'active', 'fresh root active');
  assert.equal(fresh?.spawned_by, 'root', 'audit-only successor link to old root');
  assert.equal(getFocus(), res.newNodeId, 'focus follows to the fresh root');
});

// ---------------------------------------------------------------------------
// #2 — handleNewSession on a non-root → session-id refresh only
// ---------------------------------------------------------------------------

test('handleNewSession on a non-root child only refreshes its session id', () => {
  createNode(node('root', { parent: null }));
  createNode(node('child', { parent: 'root', pi_session_id: 'old', pi_session_file: '/abs/old.jsonl' }));
  subscribe('root', 'child', true);

  const before = listNodes().length;
  const res = handleNewSession('child', 'fresh', 'test-pane', {}, '/abs/fresh.jsonl');

  assert.equal(res.path, 'reset-child');
  assert.equal(res.newNodeId, undefined, 'no new node minted');
  assert.equal(getNode('child')?.pi_session_id, 'fresh', 'session id refreshed');
  assert.equal(getNode('child')?.pi_session_file, '/abs/fresh.jsonl', 'session FILE refreshed (path-based resume)');
  assert.equal(getNode('child')?.status, 'active', 'child not reaped');
  assert.equal(listNodes().length, before, 'no node added');
});

// ---------------------------------------------------------------------------
// #3 — handleNewSession on a root with no pane → in-place reset fallback
// ---------------------------------------------------------------------------

test('handleNewSession on a root with no pane falls back to in-place resetRoot', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident', mode: 'orchestrator' }));
  createNode(node('child', { parent: 'root' }));
  subscribe('root', 'child', true);
  writeFileSync(roadmapPath('root'), '# Roadmap\n');

  const before = listNodes().length;
  const res = handleNewSession('root', 'newsess', undefined);

  assert.equal(res.path, 'reset-root', 'documented degradation: in-place reset');
  assert.equal(res.newNodeId, undefined, 'NO new node created');
  assert.equal(listNodes().length, before, 'no node added (same id re-pointed)');

  // Same id re-pointed to a pristine base resident.
  const root = getNode('root');
  assert.equal(root?.status, 'active');
  assert.equal(root?.mode, 'base');
  assert.equal(root?.lifecycle, 'resident');
  assert.equal(root?.pi_session_id, 'newsess');
  assert.equal(view('root').length, 0, 'root view emptied');
  assert.equal(getNode('child')?.status, 'done', 'descendant marked done');
  assert.equal(existsSync(roadmapPath('root')), false, 'working state wiped');
});

// ---------------------------------------------------------------------------
// #4 — rapid double /new guard
// ---------------------------------------------------------------------------

test('a second relaunchRoot on an already-parked root is a no-op', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));

  const respawn = okRespawn();
  const first = relaunchRoot('root', 'test-pane', { relaunchRootInPane: respawn.fn });
  assert.ok(first !== null, 'first /new parks + relaunches');
  const afterFirst = listNodes().length;

  // Old root is now `done`; a second session_start in the dying old pi must
  // no-op (no second parked node, no zombie new node).
  const second = relaunchRoot('root', 'test-pane', { relaunchRootInPane: respawn.fn });
  assert.equal(second, null, 'second relaunch is a no-op');
  assert.equal(listNodes().length, afterFirst, 'no second new node minted');
  assert.equal(respawn.calls.length, 1, 'respawn dispatched only once');
  assert.equal(getNode('root')?.status, 'done', 'old root unchanged (still parked)');
});

// ---------------------------------------------------------------------------
// #5 — /new before the root ever spawned children
// ---------------------------------------------------------------------------

test('relaunchRoot on a childless root: reap is a no-op, new node minted', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident', tmux_session: 'crtr', window: '@1' }));

  assert.deepEqual(reapDescendants('root'), [], 'no descendants to reap');

  const respawn = okRespawn();
  const res = relaunchRoot('root', 'test-pane', { relaunchRootInPane: respawn.fn });

  assert.ok(res !== null, 'new node minted without throwing');
  assert.equal(getNode('root')?.status, 'done', 'old root parked');
  assert.equal(getNode(res!.newNodeId)?.status, 'active', 'fresh root active');
});

// ---------------------------------------------------------------------------
// #6 — respawn dispatch failure → rollback + resetRoot
// ---------------------------------------------------------------------------

test('a respawn dispatch failure rolls back and degrades to resetRoot', () => {
  createNode(node('root', {
    parent: null,
    lifecycle: 'resident',
    mode: 'orchestrator',
    pi_session_id: 'root-sess',
    tmux_session: 'crtr',
    window: '@3',
  }));

  const respawn = throwingRespawn();
  const res = handleNewSession('root', 'newsess', 'test-pane', { relaunchRootInPane: respawn.fn });

  assert.equal(res.path, 'reset-root', 'degraded to in-place reset');

  // Old root: restored to active with its window/session, re-pointed by resetRoot.
  const old = getNode('root');
  assert.equal(old?.status, 'active', 'old root back to active');
  assert.equal(old?.window, '@3', 'window restored');
  assert.equal(old?.tmux_session, 'crtr', 'session restored');
  assert.equal(old?.mode, 'base', 'resetRoot re-pointed to base');
  assert.equal(old?.pi_session_id, 'newsess', 'resetRoot rebound the new session id');

  // The new node (if created) is left dead so the daemon ignores it; no zombie
  // active node remains besides the old root.
  const actives = listNodes({ status: ['active'] }).map((r) => r.node_id);
  assert.deepEqual(actives, ['root'], 'only the old root is active — no zombie');
  const dead = listNodes({ status: ['dead'] });
  assert.equal(dead.length, 1, 'the half-built new node is left dead');
  assert.equal(getNode(dead[0]!.node_id)?.spawned_by, 'root', 'the dead node is the new root');

  assert.equal(getFocus(), 'root', 'focus restored to the old root');
});

// ---------------------------------------------------------------------------
// #7 — markCleanExitDone guard table (termination rule)
// ---------------------------------------------------------------------------

test('markCleanExitDone: quit on an active/intent-null node marks it done', () => {
  createNode(node('n', { status: 'active', intent: null }));
  assert.equal(markCleanExitDone('n', 'quit'), true);
  assert.equal(getNode('n')?.status, 'done');
});

test('markCleanExitDone does NOT clobber an idle-released node', () => {
  createNode(node('n', { status: 'idle', intent: 'idle-release' }));
  assert.equal(markCleanExitDone('n', 'quit'), false);
  assert.equal(getNode('n')?.status, 'idle', 'unchanged');
  assert.equal(getNode('n')?.intent, 'idle-release', 'intent unchanged');
});

test('markCleanExitDone does NOT clobber a node mid-refresh-yield', () => {
  createNode(node('n', { status: 'active', intent: 'refresh' }));
  assert.equal(markCleanExitDone('n', 'quit'), false);
  assert.equal(getNode('n')?.status, 'active', 'unchanged');
  assert.equal(getNode('n')?.intent, 'refresh', 'intent unchanged');
});

test('markCleanExitDone does NOT re-mark an already-done node', () => {
  createNode(node('n', { status: 'done', intent: null }));
  assert.equal(markCleanExitDone('n', 'quit'), false);
  assert.equal(getNode('n')?.status, 'done', 'unchanged');
});

test('markCleanExitDone is a no-op for every non-quit reason', () => {
  for (const reason of ['new', 'reload', 'resume', 'fork']) {
    closeDb();
    rmSync(home, { recursive: true, force: true });
    createNode(node('n', { status: 'active', intent: null }));
    assert.equal(markCleanExitDone('n', reason), false, `${reason} → no-op`);
    assert.equal(getNode('n')?.status, 'active', `${reason} leaves node unchanged`);
  }
});

test('markCleanExitDone is a no-op for an unknown node', () => {
  assert.equal(markCleanExitDone('ghost', 'quit'), false);
});

// ---------------------------------------------------------------------------
// #8 — a parked / quit (done) node is invisible to the daemon's supervised set
// ---------------------------------------------------------------------------

test('a done node (parked or cleanly quit) is not in the supervised set', () => {
  // A done node with a live-LOOKING window — the daemon never sees it because
  // it only ever supervises listNodes({status:['active','idle']}).
  createNode(node('parked', { parent: null, status: 'done', tmux_session: 'crtr', window: '@9' }));
  createNode(node('live', { parent: null, status: 'active', tmux_session: 'crtr', window: '@1' }));

  const supervised = listNodes({ status: ['active', 'idle'] }).map((r) => r.node_id);
  assert.ok(!supervised.includes('parked'), 'parked done node excluded from supervision');
  assert.ok(supervised.includes('live'), 'live root still supervised');
});

// ---------------------------------------------------------------------------
// #9 — renderForest excludes parked / dead / canceled roots
// ---------------------------------------------------------------------------

test('renderForest renders only LIVE (active|idle) roots', () => {
  const mk = (id: string, status: NodeStatus): void => {
    createNode(node(id, { parent: null, status, name: id, kind: 'general' }));
  };
  mk('liveroot', 'active');
  mk('idleroot', 'idle');
  mk('parkedroot', 'done');
  mk('deadroot', 'dead');
  mk('cancelroot', 'canceled');

  const out = renderForest();
  assert.ok(out.includes('liveroot'), 'active root rendered');
  assert.ok(out.includes('idleroot'), 'idle root rendered');
  assert.ok(!out.includes('parkedroot'), 'parked (done) root hidden');
  assert.ok(!out.includes('deadroot'), 'dead root hidden');
  assert.ok(!out.includes('cancelroot'), 'canceled root hidden');
});
