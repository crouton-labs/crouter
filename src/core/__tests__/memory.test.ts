// Tests for the substrate memory surface in the orchestration kernel:
//   1. The kernel names the three memory scopes and the document substrate flow
//      (crtr memory write/list/find/read).
//   2. Promotion guidance names the three stores without re-listing their dirs.
//
// Run: node --import tsx/esm --test src/core/__tests__/memory.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb } from '../canvas/db.js';
import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { personaDrift } from '../runtime/persona.js';
import { loadKernel } from '../personas/index.js';

let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-memory-'));
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
// Kernel + guidance: the document substrate flow
// ---------------------------------------------------------------------------

test('the orchestration kernel names the three stores and the substrate commands', () => {
  const kernel = loadKernel();
  for (const store of ['user-global', 'project', 'node-local']) {
    assert.ok(kernel.includes(store), `kernel names the ${store} store`);
  }
  // The substrate commands must be present.
  assert.ok(kernel.includes('crtr memory write'), 'kernel mentions crtr memory write');
  assert.ok(kernel.includes('crtr memory list'), 'kernel mentions crtr memory list');
  assert.ok(kernel.includes('crtr memory find'), 'kernel mentions crtr memory find');
  assert.ok(kernel.includes('crtr memory read'), 'kernel mentions crtr memory read');
  // It teaches the substrate flow only — no MEMORY.md pointer-line index.
  assert.ok(!kernel.includes('MEMORY.md'), 'kernel does not mention MEMORY.md');
  assert.ok(!kernel.includes('pointer line'), 'kernel does not teach the pointer-line flow');
});

test('promotion guidance references the three stores; no <memory> block', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id);
  const drift = personaDrift(meta.node_id);
  assert.ok(drift !== null, 'promotion drifts the persona');
  const guidance = drift.guidance;
  // It NAMES the three stores so a promoting node knows its memory scopes.
  for (const store of ['user-global', 'project', 'node-local']) {
    assert.ok(guidance.includes(store), `guidance names the ${store} store`);
  }
  // The guidance points at the substrate flow, not a <memory> block.
  assert.ok(!guidance.includes('<memory>'), 'guidance does not point at a <memory> block');
});
