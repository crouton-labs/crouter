// Run with: node --import tsx/esm --test src/core/__tests__/reset.test.ts
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNode,
  getNode,
  subscribe,
  setStatus,
  subscriptionsOf,
  view,
} from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { reportsDir, inboxPath } from '../canvas/paths.js';
import { roadmapPath } from '../runtime/roadmap.js';
import { resetRoot } from '../runtime/reset.js';
import type { NodeMeta } from '../canvas/types.js';

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

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-reset-'));
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

test('resetRoot empties the root view, reaps descendants, and wipes working state', () => {
  // root → child → grandchild (mirrors a parent that subscribes to its workers)
  createNode(node('root', { parent: null, lifecycle: 'resident', mode: 'orchestrator', pi_session_id: 'old-sess' }));
  createNode(node('child', { parent: 'root' }));
  createNode(node('grand', { parent: 'child' }));
  subscribe('root', 'child', true);
  subscribe('child', 'grand', true);

  // Root accumulated working state.
  writeFileSync(roadmapPath('root'), '# Roadmap\nold goal\n');
  writeFileSync(inboxPath('root'), '{"ts":"x","from":"child","tier":"normal","kind":"update","label":"hi"}\n');
  writeFileSync(join(reportsDir('root'), '20260101T000000-update.md'), 'stale report');

  assert.equal(view('root').length, 2, 'precondition: root sees 2 descendants');

  const res = resetRoot('root', 'new-sess', '/abs/sessions/new.jsonl');

  assert.equal(res.reset, true);
  assert.deepEqual(res.detached, ['child'], 'root detaches its direct subscription');
  assert.deepEqual(res.reaped.sort(), ['child', 'grand'], 'whole sub-DAG reaped');

  // Graph is empty from the root's view.
  assert.equal(view('root').length, 0, 'root view is empty after reset');
  assert.equal(subscriptionsOf('root').length, 0, 'no outgoing edges remain');

  // Descendants are done (clean teardown, not a fault; daemon skips them).
  assert.equal(getNode('child')?.status, 'done');
  assert.equal(getNode('grand')?.status, 'done');

  // Working state wiped.
  assert.equal(existsSync(roadmapPath('root')), false, 'roadmap wiped');
  assert.equal(existsSync(inboxPath('root')), false, 'inbox wiped');

  // Root reset to a pristine base resident, rebound to the new session id.
  const root = getNode('root');
  assert.equal(root?.mode, 'base');
  assert.equal(root?.lifecycle, 'resident');
  assert.equal(root?.status, 'active');
  assert.equal(root?.intent, null);
  assert.equal(root?.pi_session_id, 'new-sess');
  assert.equal(root?.pi_session_file, '/abs/sessions/new.jsonl', 'session FILE rebound too');
  assert.ok(root?.launch, 'a fresh base launch spec was written');
});

test('resetRoot on a non-root only refreshes the session id (no reap)', () => {
  createNode(node('root', { parent: null }));
  createNode(node('child', { parent: 'root', pi_session_id: 'old' }));
  subscribe('root', 'child', true);
  subscribe('child', 'root', false); // contrived: ensure child has an outgoing edge

  const res = resetRoot('child', 'fresh', '/abs/sessions/fresh.jsonl');

  assert.equal(res.reset, false, 'a non-root is not a graph reset');
  assert.deepEqual(res.reaped, []);
  assert.deepEqual(res.detached, []);
  assert.equal(getNode('child')?.pi_session_id, 'fresh', 'session id still refreshed');
  assert.equal(getNode('child')?.pi_session_file, '/abs/sessions/fresh.jsonl', 'session FILE refreshed too');
  assert.equal(getNode('child')?.status, 'active', 'child not reaped');
  // The root that subscribes to the child is untouched.
  assert.equal(getNode('root')?.status, 'active');
});

test('resetRoot is a no-op for an unknown node', () => {
  const res = resetRoot('ghost', 'x');
  assert.equal(res.reset, false);
  assert.deepEqual(res.reaped, []);
  assert.deepEqual(res.detached, []);
});

test('reaped descendants keep their meta on disk (orphaned, not deleted)', () => {
  createNode(node('root', { parent: null }));
  createNode(node('child', { parent: 'root' }));
  subscribe('root', 'child', true);
  setStatus('child', 'idle');

  resetRoot('root', 'new');

  // The node record persists (we detach + mark done, we don't delete the node).
  const child = getNode('child');
  assert.ok(child, 'child meta still on disk');
  assert.equal(child?.status, 'done');
  // It is just unreachable from the root.
  assert.equal(view('root').length, 0);
});
