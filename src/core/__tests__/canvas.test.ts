import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNode,
  getNode,
  getRow,
  updateNode,
  setStatus,
  listNodes,
  subscribe,
  unsubscribe,
  setSubscriptionActive,
  recordSpawn,
  subscribersOf,
  subscriptionsOf,
  view,
  hasActiveLiveSubscription,
  rebuildIndex,
} from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import {
  contextDir,
  reportsDir,
  jobDir,
  nodeMetaPath,
} from '../canvas/paths.js';
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
  home = mkdtempSync(join(tmpdir(), 'crtr-canvas-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  // Fresh db + dirs per test for isolation.
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

test('createNode scaffolds dirs, writes meta, indexes the row', () => {
  createNode(node('a'));
  assert.ok(existsSync(contextDir('a')));
  assert.ok(existsSync(reportsDir('a')));
  assert.ok(existsSync(jobDir('a')));
  assert.ok(existsSync(nodeMetaPath('a')));

  const meta = getNode('a');
  assert.equal(meta?.node_id, 'a');
  assert.equal(meta?.kind, 'general');

  const row = getRow('a');
  assert.equal(row?.node_id, 'a');
  assert.equal(row?.status, 'active');
});

test('meta.json is the source of truth on disk', () => {
  createNode(node('a', { kind: 'developer' }));
  const raw = JSON.parse(readFileSync(nodeMetaPath('a'), 'utf8'));
  assert.equal(raw.kind, 'developer');
});

test('updateNode merges meta and re-indexes the row', () => {
  createNode(node('a'));
  updateNode('a', { mode: 'orchestrator', lifecycle: 'resident' });
  assert.equal(getNode('a')?.mode, 'orchestrator');
  assert.equal(getRow('a')?.lifecycle, 'resident');
  // unspecified fields preserved
  assert.equal(getNode('a')?.kind, 'general');
});

test('setStatus updates both meta and row', () => {
  createNode(node('a'));
  setStatus('a', 'done');
  assert.equal(getNode('a')?.status, 'done');
  assert.equal(getRow('a')?.status, 'done');
});

test('listNodes filters by status', () => {
  createNode(node('a', { status: 'active' }));
  createNode(node('b', { status: 'idle' }));
  createNode(node('c', { status: 'done' }));
  assert.equal(listNodes().length, 3);
  assert.deepEqual(
    listNodes({ status: ['active', 'idle'] }).map((n) => n.node_id).sort(),
    ['a', 'b'],
  );
});

test('subscription spine: subscribersOf / subscriptionsOf', () => {
  createNode(node('mgr'));
  createNode(node('w1'));
  createNode(node('w2'));
  // mgr subscribes to both workers (parent watches children)
  subscribe('mgr', 'w1');
  subscribe('mgr', 'w2', false);

  // w1's subscribers = who a w1 push fans out to = mgr
  assert.deepEqual(subscribersOf('w1').map((s) => s.node_id), ['mgr']);
  // mgr's subscriptions = its reports = both workers
  const subs = subscriptionsOf('mgr');
  assert.deepEqual(subs.map((s) => s.node_id).sort(), ['w1', 'w2']);
  assert.equal(subs.find((s) => s.node_id === 'w1')?.active, true);
  assert.equal(subs.find((s) => s.node_id === 'w2')?.active, false);
});

test('subscribe is idempotent and flips active', () => {
  createNode(node('a'));
  createNode(node('b'));
  subscribe('a', 'b', true);
  subscribe('a', 'b', false); // re-subscribe updates the flag, no dup
  const subs = subscriptionsOf('a');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].active, false);

  setSubscriptionActive('a', 'b', true);
  assert.equal(subscriptionsOf('a')[0].active, true);

  unsubscribe('a', 'b');
  assert.equal(subscriptionsOf('a').length, 0);
});

test('view = transitive closure down the subscription spine', () => {
  // root → mid → leaf, plus root → sib
  for (const id of ['root', 'mid', 'leaf', 'sib']) createNode(node(id));
  subscribe('root', 'mid');
  subscribe('root', 'sib');
  subscribe('mid', 'leaf');
  assert.deepEqual(view('root').sort(), ['leaf', 'mid', 'sib']);
  assert.deepEqual(view('mid'), ['leaf']);
});

test('view is cycle-safe', () => {
  createNode(node('a'));
  createNode(node('b'));
  subscribe('a', 'b');
  subscribe('b', 'a');
  assert.deepEqual(view('a'), ['b']);
});

test('hasActiveLiveSubscription: the stop-guard primitive', () => {
  createNode(node('mgr'));
  createNode(node('child', { status: 'active' }));
  // no subscription yet
  assert.equal(hasActiveLiveSubscription('mgr'), false);

  subscribe('mgr', 'child', true);
  assert.equal(hasActiveLiveSubscription('mgr'), true); // active sub to a live node

  setStatus('child', 'done');
  assert.equal(hasActiveLiveSubscription('mgr'), false); // child no longer live

  setStatus('child', 'active');
  setSubscriptionActive('mgr', 'child', false);
  assert.equal(hasActiveLiveSubscription('mgr'), false); // passive sub doesn't count
});

test('recordSpawn writes the audit-only spawned_by edge', () => {
  createNode(node('parent'));
  createNode(node('child', { parent: 'parent' }));
  recordSpawn('child', 'parent');
  // spawned_by does not appear in the subscription spine
  assert.equal(subscriptionsOf('child').length, 0);
  assert.equal(subscribersOf('parent').length, 0);
});

test('rebuildIndex reconstructs node rows from on-disk metas', () => {
  createNode(node('a', { parent: null }));
  createNode(node('b', { parent: 'a' }));
  // wipe just the db, keep the node dirs
  closeDb();
  rmSync(join(home, 'canvas.db'), { force: true });
  rmSync(join(home, 'canvas.db-wal'), { force: true });
  rmSync(join(home, 'canvas.db-shm'), { force: true });

  assert.equal(getRow('a'), null); // gone from index
  rebuildIndex();
  assert.equal(getRow('a')?.node_id, 'a');
  assert.equal(getRow('b')?.parent, 'a');
});
