// spawnNode: provenance (spawned_by) is decoupled from the spine (parent +
// subscription). A managed child gets both; an independent root gets provenance
// only — no subscription wires back to the spawner.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, getRow, subscribersOf } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { nodeDir } from '../canvas/paths.js';
import { spawnNode } from '../runtime/nodes.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function spawner(id: string): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'resident',
    status: 'active',
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-spawn-root-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('managed child: parent on the spine + active subscription + provenance', () => {
  createNode(spawner('A'));
  const child = spawnNode({ kind: 'developer', cwd: '/tmp/work', parent: 'A' });

  const meta = getNode(child.node_id)!;
  assert.equal(meta.parent, 'A', 'child keeps its spine parent');
  assert.equal(meta.spawned_by, 'A', 'child provenance defaults to its parent');
  assert.equal(meta.lifecycle, 'terminal', 'a plain child is terminal');

  const subs = subscribersOf(child.node_id);
  assert.equal(subs.length, 1, 'exactly one subscriber (the parent)');
  assert.equal(subs[0]!.node_id, 'A');
  assert.equal(subs[0]!.active, true, 'parent subscription is active');
});

test('independent root: provenance only, no parent, no subscription', () => {
  createNode(spawner('A'));
  const root = spawnNode({
    kind: 'developer',
    cwd: '/tmp/work',
    parent: null,
    spawnedBy: 'A',
    lifecycle: 'resident',
  });

  const meta = getNode(root.node_id)!;
  assert.equal(meta.parent, null, 'a root has no spine parent (top-level)');
  assert.equal(meta.spawned_by, 'A', 'a root still records who spawned it');
  assert.equal(meta.lifecycle, 'resident', 'a root is resident');

  assert.equal(
    subscribersOf(root.node_id).length,
    0,
    'nobody is subscribed to an independent root — the spawner is not woken by it',
  );
});

test('unknown parent: spawnNode throws and mints NO node dir / row (validate before create)', () => {
  // Pre-allocate the would-be id so we can prove nothing was scaffolded for it.
  const orphanId = 'orphan-under-ghost';
  assert.throws(
    () => spawnNode({ kind: 'developer', cwd: '/tmp/work', parent: 'ghost', nodeId: orphanId }),
    /cannot spawn under unknown parent node: ghost/,
  );

  // No half-born orphan: no meta (getNode null), no db row, no node dir on disk.
  assert.equal(getNode(orphanId), null, 'no meta.json written for the orphan');
  assert.equal(getRow(orphanId), null, 'no index row written for the orphan');
  assert.equal(existsSync(nodeDir(orphanId)), false, 'no node dir scaffolded for the orphan');
});
