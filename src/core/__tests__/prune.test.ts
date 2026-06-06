import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNode,
  getRow,
  subscribe,
  recordSpawn,
  subscribersOf,
  subscriptionsOf,
  pruneNodes,
} from '../canvas/canvas.js';
import { closeDb, openDb } from '../canvas/db.js';
import { nodeDir } from '../canvas/paths.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

const DAY = 86_400_000;
const old = () => new Date(Date.now() - 30 * DAY).toISOString();
const now = () => new Date().toISOString();

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: now(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

function totalEdges(): number {
  return (
    openDb().prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
  ).n;
}

/** The standard fixture: three prunable terminal nodes (old), three survivors
 *  (two old-but-live, one recent-but-dead), and edges that touch a pruned node
 *  so cascade is observable. */
function seedFixture(): void {
  createNode(node('old-dead', { status: 'dead', created: old() }));
  createNode(node('old-done', { status: 'done', created: old() }));
  createNode(node('old-canceled', { status: 'canceled', created: old() }));
  createNode(node('old-active', { status: 'active', created: old() }));
  createNode(node('old-idle', { status: 'idle', created: old() }));
  createNode(node('recent-dead', { status: 'dead', created: now() }));

  // A survivor subscribes to a pruned node (cascade on to_id) …
  subscribe('old-active', 'old-dead', true);
  // … and a pruned node's audit edge to another pruned node (cascade on both).
  recordSpawn('old-done', 'old-dead');
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-prune-'));
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

test('prune removes terminal nodes past the TTL and keeps live + recent ones', () => {
  seedFixture();
  assert.equal(totalEdges(), 2);

  const result = pruneNodes({ ttlDays: 14 });

  // The three old terminal nodes are pruned; nothing else.
  assert.equal(result.dryRun, false);
  assert.deepEqual(
    result.pruned.map((p) => p.node_id).sort(),
    ['old-canceled', 'old-dead', 'old-done'],
  );

  // Pruned rows are gone …
  for (const id of ['old-dead', 'old-done', 'old-canceled']) {
    assert.equal(getRow(id), null, `${id} row should be pruned`);
  }
  // … and the survivors remain (live-but-old + recent-but-dead).
  for (const id of ['old-active', 'old-idle', 'recent-dead']) {
    assert.ok(getRow(id) !== null, `${id} should survive`);
  }
});

test('pruning cascade-deletes the pruned nodes\u2019 edges', () => {
  seedFixture();
  assert.equal(totalEdges(), 2);

  pruneNodes({ ttlDays: 14 });

  // Both edges touched a pruned node (old-dead) → both cascade away.
  assert.equal(totalEdges(), 0);
  // The surviving subscriber's edge to the pruned publisher is gone.
  assert.deepEqual(subscriptionsOf('old-active'), []);
  assert.deepEqual(subscribersOf('old-dead'), []);
});

test('pruning removes each pruned node\u2019s on-disk dir, leaves survivors\u2019 dirs', () => {
  seedFixture();
  assert.ok(existsSync(nodeDir('old-dead')));
  assert.ok(existsSync(nodeDir('old-active')));

  pruneNodes({ ttlDays: 14 });

  assert.ok(!existsSync(nodeDir('old-dead')), 'pruned dir should be removed');
  assert.ok(!existsSync(nodeDir('old-done')));
  assert.ok(!existsSync(nodeDir('old-canceled')));
  assert.ok(existsSync(nodeDir('old-active')), 'survivor dir should remain');
  assert.ok(existsSync(nodeDir('recent-dead')));
});

test('--dry-run reports candidates but deletes nothing', () => {
  seedFixture();
  const before = totalEdges();

  const result = pruneNodes({ ttlDays: 14, dryRun: true });

  // Candidates are reported …
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.pruned.map((p) => p.node_id).sort(),
    ['old-canceled', 'old-dead', 'old-done'],
  );

  // … but NOTHING is deleted: rows, edges, and dirs all intact.
  for (const id of ['old-dead', 'old-done', 'old-canceled']) {
    assert.ok(getRow(id) !== null, `${id} must survive a dry run`);
    assert.ok(existsSync(nodeDir(id)), `${id} dir must survive a dry run`);
  }
  assert.equal(totalEdges(), before);
});

test('prune and the daemon operate on disjoint status sets', () => {
  // active|idle (the daemon's domain) are NEVER pruned, even when ancient.
  createNode(node('ancient-active', { status: 'active', created: old() }));
  createNode(node('ancient-idle', { status: 'idle', created: old() }));

  const result = pruneNodes({ ttlDays: 14 });

  assert.equal(result.pruned.length, 0);
  assert.ok(getRow('ancient-active') !== null);
  assert.ok(getRow('ancient-idle') !== null);
});
