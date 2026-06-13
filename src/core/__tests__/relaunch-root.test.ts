// Run with: node --import tsx/esm --test src/core/__tests__/relaunch-root.test.ts
//
// Bug regression (commit 07e704e, "broker becomes universal host"): `/new` on a
// ROOT used to do an in-place SAME-id reset (resetRoot reaped + wiped + re-pointed
// the same node id) instead of starting a genuinely new node. Model B fixes it:
// relaunchRoot parks the old root `done` (kept as history, NOT canceled) and mints
// a FRESH node id + broker, re-pointing the viewer pane. These tests lock in that
// behavior via the injectable deps seam, so they run tmux-free and broker-free.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { relaunchRoot, type RelaunchDeps } from '../runtime/reset.js';
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

/** A tmux-free / broker-free deps seam. `pid` controls the new broker launch:
 *  a number = success, null = a boot failure. Records the node ids launchBroker
 *  was called with, so the boot-failure test can find the half-born new node. */
function makeDeps(pid: number | null): { deps: RelaunchDeps; launched: string[] } {
  const launched: string[] = [];
  const deps: RelaunchDeps = {
    launchBroker: (nodeId) => {
      launched.push(nodeId);
      return { pid };
    },
    waitForViewSocket: () => true,
    respawnViewer: () => true,
    teardownBroker: () => {},
  };
  return { deps, launched };
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

test('relaunchRoot parks the old root done and mints a fresh active root, reaping descendants', () => {
  // root → child → grandchild (a parent that subscribes to its workers).
  createNode(node('root', { parent: null, lifecycle: 'resident', cwd: '/tmp/proj' }));
  createNode(node('child', { parent: 'root' }));
  createNode(node('grand', { parent: 'child' }));
  subscribe('root', 'child', true);
  subscribe('child', 'grand', true);

  const { deps, launched } = makeDeps(4242);
  const res = relaunchRoot('root', deps);

  // A fresh, DIFFERENT node id was minted and booted.
  assert.ok(res, 'relaunchRoot returns the new node id');
  const newId = res!.newNodeId;
  assert.notEqual(newId, 'root', 'a genuinely NEW node id (not a same-id reset — the bug)');
  assert.deepEqual(launched, [newId], 'the new node id is the one we booted a broker for');

  // (1) Old root parked DONE — kept as history, NOT canceled (explicit CTO call).
  assert.equal(getNode('root')?.status, 'done', 'old root parked done (kept as history)');

  // (2) The new node is an active, top-level resident inheriting the old root's
  //     kind + cwd.
  const fresh = getNode(newId);
  assert.equal(fresh?.status, 'active', 'new node is active');
  assert.equal(fresh?.parent, null, 'new node is a root (no spine parent)');
  assert.equal(fresh?.kind, 'general', 'new node inherits the old root kind');
  assert.equal(fresh?.cwd, '/tmp/proj', 'new node inherits the old root cwd');
  assert.equal(fresh?.lifecycle, 'resident', 'a relaunched root is resident');

  // (3) Descendants reaped → canceled (A5: an externally-reaped node did not
  //     finish its OWN work; done is reserved for finalize).
  assert.equal(getNode('child')?.status, 'canceled', 'descendant child canceled');
  assert.equal(getNode('grand')?.status, 'canceled', 'descendant grandchild canceled');
});

test('relaunchRoot on a boot failure leaves the old root + descendants fully intact', () => {
  // The mint-and-boot-FIRST ordering: a launch failure (pid=null) must occur
  // BEFORE the old root is parked or its descendants reaped.
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('child', { parent: 'root' }));
  subscribe('root', 'child', true);

  const { deps, launched } = makeDeps(null); // broker never starts
  const res = relaunchRoot('root', deps);

  assert.equal(res, null, 'a boot failure returns null');

  // Old root + descendant untouched: still live, ready to keep running.
  assert.equal(getNode('root')?.status, 'active', 'old root left active + untouched');
  assert.equal(getNode('child')?.status, 'active', 'descendant left active + untouched');

  // The half-born new node was crashed (so the daemon never watches a zombie).
  assert.equal(launched.length, 1, 'one broker launch was attempted');
  assert.equal(getNode(launched[0]!)?.status, 'dead', 'the half-born new node is crashed (dead)');
});

test('relaunchRoot is a no-op for a non-root child and an already-parked root', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('child', { parent: 'root' }));
  createNode(node('done-root', { parent: null, status: 'done' }));

  const { deps, launched } = makeDeps(1);
  assert.equal(relaunchRoot('child', deps), null, 'a child is not a relaunchable root');
  assert.equal(relaunchRoot('done-root', deps), null, 'a done root is not relaunched again (double /new)');
  assert.equal(relaunchRoot('ghost', deps), null, 'an unknown node is a no-op');
  assert.deepEqual(launched, [], 'no broker was booted for any of the no-op cases');
});
