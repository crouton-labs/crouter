// Run with: node --import tsx/esm --test src/core/__tests__/reset.test.ts
//
// resetRoot now handles ONLY the non-root child `/new` (a session-id refresh).
// A root's `/new` mints a fresh node via relaunchRoot — see relaunch-root.test.ts.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
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

test('resetRoot on a non-root child refreshes the session id (no reap, no reset)', () => {
  createNode(node('root', { parent: null }));
  createNode(node('child', { parent: 'root', pi_session_id: 'old' }));
  subscribe('root', 'child', true);

  const res = resetRoot('child', 'fresh', '/abs/sessions/fresh.jsonl');

  assert.equal(res.reset, false, 'a child `/new` is not a graph reset');
  assert.deepEqual(res.reaped, []);
  assert.deepEqual(res.detached, []);
  assert.equal(getNode('child')?.pi_session_id, 'fresh', 'session id refreshed');
  assert.equal(getNode('child')?.pi_session_file, '/abs/sessions/fresh.jsonl', 'session FILE refreshed too');
  assert.equal(getNode('child')?.status, 'active', 'child not reaped');
  assert.equal(getNode('root')?.status, 'active', 'the subscribing root is untouched');
});

test('resetRoot on a ROOT is a no-op (roots route to relaunchRoot, not here)', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident', pi_session_id: 'keep' }));
  createNode(node('child', { parent: 'root' }));
  subscribe('root', 'child', true);

  const res = resetRoot('root', 'new-sess');

  assert.equal(res.reset, false);
  assert.deepEqual(res.reaped, [], 'a root `/new` reaps nothing here');
  assert.equal(getNode('root')?.status, 'active', 'root left untouched');
  assert.equal(getNode('root')?.pi_session_id, 'keep', 'a root session id is NOT refreshed here');
  assert.equal(getNode('child')?.status, 'active', 'descendant left untouched');
});

test('resetRoot is a no-op for an unknown node', () => {
  const res = resetRoot('ghost', 'x');
  assert.equal(res.reset, false);
  assert.deepEqual(res.reaped, []);
  assert.deepEqual(res.detached, []);
});
