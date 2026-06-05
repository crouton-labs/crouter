// Run: node --import tsx/esm --test src/core/__tests__/stop-guard.test.ts
//
// The stop-guard keys "is this stop legitimate?" on the LIFECYCLE value, not on
// parent/mode: a resident node is interactable and never forced to submit a
// final, so it may go dormant regardless of whether it has a parent.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, subscribe, setStatus } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { evaluateStop } from '../runtime/stop-guard.js';
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

const noSignals = { pushedFinal: false, askedHuman: false };

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-stopguard-'));
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

test('a RESIDENT node is allowed to go dormant — even WITH a parent (keyed on lifecycle, not parent)', () => {
  createNode(node('parent', { parent: null, lifecycle: 'resident' }));
  // A resident sub-orchestrator with a parent and NOTHING live to await: under
  // the old parent===null rule this would have stalled; now it goes dormant.
  createNode(node('sub', { parent: 'parent', lifecycle: 'resident', mode: 'orchestrator' }));
  const d = evaluateStop('sub', noSignals);
  assert.deepEqual(d, { action: 'allow', reason: 'dormant' });
});

test('a resident ROOT (no parent) is allowed to go dormant', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  const d = evaluateStop('root', noSignals);
  assert.deepEqual(d, { action: 'allow', reason: 'dormant' });
});

test('a TERMINAL node awaiting a live worker is "awaiting" (not stalled)', () => {
  createNode(node('mgr', { parent: null, lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('worker', { parent: 'mgr', lifecycle: 'terminal', status: 'active' }));
  subscribe('mgr', 'worker', true); // active sub to a live publisher
  const d = evaluateStop('mgr', noSignals);
  assert.equal(d.action, 'allow');
  assert.equal(d.reason, 'awaiting');
});

test('a TERMINAL node with nothing live to await and no final pushed is reprompted (stalled)', () => {
  createNode(node('lonely', { parent: 'mgr', lifecycle: 'terminal' }));
  const d = evaluateStop('lonely', noSignals);
  assert.equal(d.action, 'reprompt');
  assert.equal(d.reason, 'stalled');
});

test('a TERMINAL node whose only worker is dead is stalled (no LIVE subscription)', () => {
  createNode(node('mgr', { parent: null, lifecycle: 'terminal' }));
  createNode(node('worker', { parent: 'mgr', lifecycle: 'terminal' }));
  subscribe('mgr', 'worker', true);
  setStatus('worker', 'dead'); // publisher no longer live
  const d = evaluateStop('mgr', noSignals);
  assert.equal(d.action, 'reprompt');
  assert.equal(d.reason, 'stalled');
});

test('pushedFinal → finished; askedHuman → escalated (both short-circuit before lifecycle)', () => {
  createNode(node('t', { parent: 'mgr', lifecycle: 'terminal' }));
  assert.deepEqual(evaluateStop('t', { pushedFinal: true, askedHuman: false }), { action: 'allow', reason: 'finished' });
  assert.deepEqual(evaluateStop('t', { pushedFinal: false, askedHuman: true }), { action: 'allow', reason: 'escalated' });
});
