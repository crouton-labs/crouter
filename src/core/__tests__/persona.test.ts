// Run: node --import tsx/esm --test src/core/__tests__/persona.test.ts
//
// The persona-transition mechanism: the two-axis model (mode × lifecycle) is
// switchable independently, and `personaDrift` detects when a node's live
// {mode,lifecycle} has diverged from the `persona_ack` it was last given
// guidance for (the central injector then delivers + commits).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { getNode, updateNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import {
  personaDrift,
  commitPersonaAck,
  transitionGuidance,
} from '../runtime/persona.js';

let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-persona-'));
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
// Birth: a fresh node is born acked to its own persona — no spurious drift.
// ---------------------------------------------------------------------------

test('a freshly spawned node has no persona drift (born acked to its own persona)', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  assert.deepEqual(meta.persona_ack, { mode: 'base', lifecycle: 'terminal' });
  assert.equal(personaDrift(meta.node_id), null, 'no drift at birth');
});

// ---------------------------------------------------------------------------
// Fix 1: promote keeps lifecycle by default; --resident flips it.
// ---------------------------------------------------------------------------

test('promote flips mode→orchestrator and KEEPS lifecycle terminal by default', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  const res = promote(meta.node_id);
  assert.equal(res.meta.mode, 'orchestrator');
  assert.equal(res.meta.lifecycle, 'terminal', 'lifecycle is NOT forced to resident');
});

test('promote with resident:true ALSO flips lifecycle→resident', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  const res = promote(meta.node_id, { resident: true });
  assert.equal(res.meta.mode, 'orchestrator');
  assert.equal(res.meta.lifecycle, 'resident', 'resident flag flips lifecycle');
});

test('promote no longer returns a guidance field (injector is the single source)', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  const res = promote(meta.node_id) as unknown as Record<string, unknown>;
  assert.equal('guidance' in res, false, 'promote() returns facts only');
});

// ---------------------------------------------------------------------------
// personaDrift detect + commit.
// ---------------------------------------------------------------------------

test('personaDrift detects base→orchestrator after promote, then clears on commit', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  promote(meta.node_id); // mode→orchestrator, lifecycle stays terminal

  const drift = personaDrift(meta.node_id);
  assert.ok(drift !== null, 'a transition is detected');
  assert.deepEqual(drift?.from, { mode: 'base', lifecycle: 'terminal' });
  assert.deepEqual(drift?.to, { mode: 'orchestrator', lifecycle: 'terminal' });
  assert.ok((drift?.guidance ?? '').length > 0, 'guidance is built');

  // Caller commits the ack after delivery — drift then clears (idempotent).
  commitPersonaAck(meta.node_id, drift!.to);
  assert.equal(personaDrift(meta.node_id), null, 'no drift after the ack is committed');
  assert.deepEqual(getNode(meta.node_id)?.persona_ack, { mode: 'orchestrator', lifecycle: 'terminal' });
});

test('personaDrift detects a lifecycle-only flip (terminal→resident)', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  // Flip only the lifecycle axis — mode unchanged.
  updateNode(meta.node_id, { lifecycle: 'resident' });

  const drift = personaDrift(meta.node_id);
  assert.ok(drift !== null);
  assert.deepEqual(drift?.from, { mode: 'base', lifecycle: 'terminal' });
  assert.deepEqual(drift?.to, { mode: 'base', lifecycle: 'resident' });
  assert.match(drift?.guidance ?? '', /resident/i, 'guidance describes the resident state');
});

// ---------------------------------------------------------------------------
// transitionGuidance: each lifecycle case + both-axes concatenation.
// ---------------------------------------------------------------------------

test('transitionGuidance terminal→resident says it is never forced to submit a final', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  const g = transitionGuidance(meta.node_id, { mode: 'base', lifecycle: 'terminal' }, { mode: 'base', lifecycle: 'resident' });
  assert.match(g, /resident/i);
  assert.match(g, /never/i);
  assert.doesNotMatch(g, /orchestrator/i, 'a lifecycle-only change carries no mode section');
});

test('transitionGuidance resident→terminal says it owes a final up the spine', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'resident' });
  const g = transitionGuidance(meta.node_id, { mode: 'base', lifecycle: 'resident' }, { mode: 'base', lifecycle: 'terminal' });
  assert.match(g, /terminal/i);
  assert.match(g, /push final/i);
});

test('transitionGuidance concatenates BOTH sections when both axes change', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null, lifecycle: 'terminal' });
  promote(meta.node_id); // ensure roadmap/memory seeded for the orchestrator section
  const g = transitionGuidance(
    meta.node_id,
    { mode: 'base', lifecycle: 'terminal' },
    { mode: 'orchestrator', lifecycle: 'resident' },
  );
  assert.match(g, /orchestrator/i, 'carries the mode (base→orchestrator) section');
  assert.match(g, /resident/i, 'carries the lifecycle (terminal→resident) section');
});
