// Tests for src/core/runtime/memory.ts:
//   1. projectKey resolves the git-repo-root (walk up for .git), and falls back
//      to the cwd itself when not inside a repo.
//   2. The orchestration kernel names the three memory scopes and the document
//      substrate flow (crtr memory write/list/find/read).
//
// Run: node --import tsx/esm --test src/core/__tests__/memory.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb } from '../canvas/db.js';
import { mangleCwd } from '../artifact.js';
import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { personaDrift } from '../runtime/persona.js';
import { loadKernel } from '../personas/index.js';
import {
  projectKey,
  userMemoryDir,
  projectMemoryDir,
} from '../runtime/memory.js';

let home: string;
// Scratch repos created per-test for the git-root keying cases; tracked so they
// can be removed in `after` regardless of which test created them.
const scratch: string[] = [];

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
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

// ---------------------------------------------------------------------------
// projectKey: git-root vs not-in-a-repo fallback
// ---------------------------------------------------------------------------

test('projectKey resolves the git-repo-root by walking up for a .git entry', () => {
  const repo = mkdtempSync(join(tmpdir(), 'crtr-repo-'));
  scratch.push(repo);
  mkdirSync(join(repo, '.git')); // a .git directory marks the repo root
  const nested = join(repo, 'pkg', 'src');
  mkdirSync(nested, { recursive: true });

  // A cwd deep inside the repo keys to the repo ROOT, not the cwd.
  assert.equal(projectKey(nested), mangleCwd(repo));
  assert.equal(projectKey(repo), mangleCwd(repo));
  // A .git FILE (worktree/submodule) is recognized the same way.
  const wt = mkdtempSync(join(tmpdir(), 'crtr-wt-'));
  scratch.push(wt);
  writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n');
  assert.equal(projectKey(join(wt, 'a')), mangleCwd(wt));
});

test('projectKey falls back to the mangled cwd when not inside a repo', () => {
  const bare = mkdtempSync(join(tmpdir(), 'crtr-bare-'));
  scratch.push(bare);
  const sub = join(bare, 'x', 'y');
  mkdirSync(sub, { recursive: true });
  // No .git anywhere up the tree → the cwd itself is the key.
  assert.equal(projectKey(sub), mangleCwd(sub));
});

// ---------------------------------------------------------------------------
// Kernel + guidance: substrate flow, not MEMORY.md
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
  // The old MEMORY.md pointer-line flow must NOT be present.
  assert.ok(!kernel.includes('MEMORY.md'), 'kernel does not mention MEMORY.md');
  assert.ok(!kernel.includes('pointer line'), 'kernel does not teach the pointer-line flow');
});

test('promotion guidance references the three stores; dirs are not re-listed', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id);
  const drift = personaDrift(meta.node_id);
  assert.ok(drift !== null, 'promotion drifts the persona');
  const guidance = drift.guidance;
  // It NAMES the three stores so a promoting node knows its memory scopes.
  for (const store of ['user-global', 'project', 'node-local']) {
    assert.ok(guidance.includes(store), `guidance names the ${store} store`);
  }
  // Dirs are NOT re-listed in guidance (the node already saw them in context).
  assert.ok(!guidance.includes(userMemoryDir()), 'user-global dir not re-listed in guidance');
  assert.ok(!guidance.includes(projectMemoryDir('/tmp/work')), 'project dir not re-listed in guidance');
  // The old <memory> block reference must NOT be present in guidance.
  assert.ok(!guidance.includes('<memory>'), 'guidance does not point at the removed <memory> block');
});
