// Tests for the three-tier scoped memory (src/core/runtime/memory.ts):
//   1. The three store paths land under crtrHome (user-global / project / node).
//   2. projectKey resolves the git-repo-root (walk up for .git), and falls back
//      to the cwd itself when not inside a repo.
//   3. seed* are guarded/idempotent (never clobber an evolved index).
//   4. promote() seeds ALL THREE stores, guarded across re-promotion.
//   5. The kernel + promotion guidance name the type\u2192store mapping.
//
// CRTR_HOME isolation, like context-intro.test.ts.
//
// Run: node --import tsx/esm --test src/core/__tests__/memory.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb } from '../canvas/db.js';
import { crtrHome } from '../canvas/paths.js';
import { mangleCwd } from '../artifact.js';
import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { personaDrift } from '../runtime/persona.js';
import { loadKernel } from '../personas/index.js';
import {
  memoryDir,
  memoryPath,
  userMemoryDir,
  userMemoryPath,
  hasUserMemory,
  readUserMemory,
  seedUserMemory,
  projectKey,
  projectMemoryDir,
  projectMemoryPath,
  hasProjectMemory,
  readProjectMemory,
  seedProjectMemory,
  hasMemory,
  USER_MEMORY_TEMPLATE,
  PROJECT_MEMORY_TEMPLATE,
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
// Store paths
// ---------------------------------------------------------------------------

test('the three stores all live under crtrHome, at their scoped paths', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });

  // user-global: <crtrHome>/memory/
  assert.equal(userMemoryDir(), join(crtrHome(), 'memory'));
  assert.equal(userMemoryPath(), join(crtrHome(), 'memory', 'MEMORY.md'));

  // project: <crtrHome>/projects/<key>/memory/
  assert.equal(projectMemoryDir('/tmp/work'), join(crtrHome(), 'projects', projectKey('/tmp/work'), 'memory'));
  assert.equal(projectMemoryPath('/tmp/work'), join(projectMemoryDir('/tmp/work'), 'MEMORY.md'));

  // node-local: <crtrHome>/nodes/<id>/context/memory/ (unchanged)
  assert.ok(memoryDir(meta.node_id).startsWith(join(crtrHome(), 'nodes', meta.node_id)));
  assert.ok(memoryPath(meta.node_id).endsWith('/context/memory/MEMORY.md'));
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
  // No .git anywhere up the tree \u2192 the cwd itself is the key.
  assert.equal(projectKey(sub), mangleCwd(sub));
});

// ---------------------------------------------------------------------------
// seed*: guarded / idempotent
// ---------------------------------------------------------------------------

test('seedUserMemory / seedProjectMemory write the template once, then never clobber', () => {
  assert.equal(hasUserMemory(), false);
  assert.equal(seedUserMemory(), true, 'first seed writes');
  assert.equal(readUserMemory(), USER_MEMORY_TEMPLATE);
  assert.equal(hasUserMemory(), true);

  const evolved = '# Memory\n\n- [Likes terse replies](terse.md) \u2014 keep it short\n';
  writeFileSync(userMemoryPath(), evolved);
  assert.equal(seedUserMemory(), false, 'second seed is a no-op');
  assert.equal(readUserMemory(), evolved, 'evolved index left untouched');

  assert.equal(seedProjectMemory('/tmp/work'), true, 'project first seed writes');
  assert.equal(readProjectMemory('/tmp/work'), PROJECT_MEMORY_TEMPLATE);
  assert.equal(seedProjectMemory('/tmp/work'), false, 'project second seed is a no-op');
});

// ---------------------------------------------------------------------------
// promote(): seeds all three, guarded across re-promotion
// ---------------------------------------------------------------------------

test('promote() seeds all three stores and surfaces all three paths', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  assert.equal(hasMemory(meta.node_id), false);
  assert.equal(hasUserMemory(), false);
  assert.equal(hasProjectMemory('/tmp/work'), false);

  const res = promote(meta.node_id);

  assert.ok(hasMemory(meta.node_id), 'node-local seeded');
  assert.ok(hasUserMemory(), 'user-global seeded');
  assert.ok(hasProjectMemory('/tmp/work'), 'project seeded');
  assert.ok(existsSync(userMemoryDir()), 'user dir created for direct writes');
  assert.ok(existsSync(projectMemoryDir('/tmp/work')), 'project dir created for direct writes');

  assert.equal(res.memoryPath, memoryPath(meta.node_id));
  assert.equal(res.userMemoryPath, userMemoryPath());
  assert.equal(res.projectMemoryPath, projectMemoryPath('/tmp/work'));
});

test('promote() is idempotent across re-promotion \u2014 never clobbers evolved stores', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id);

  const evolvedUser = '# Memory\n\n- [CTO, terse](cto.md) \u2014 senior, wants density\n';
  const evolvedProject = '# Memory\n\n- [ESM only](esm.md) \u2014 .js extensions required\n';
  writeFileSync(userMemoryPath(), evolvedUser);
  writeFileSync(projectMemoryPath('/tmp/work'), evolvedProject);

  promote(meta.node_id); // re-promote

  assert.equal(readUserMemory(), evolvedUser, 'user store survived re-promotion');
  assert.equal(readProjectMemory('/tmp/work'), evolvedProject, 'project store survived re-promotion');
});

// ---------------------------------------------------------------------------
// The kernel + guidance name the type\u2192store mapping
// ---------------------------------------------------------------------------

test('the orchestration kernel names the three stores and the type\u2192store mapping', () => {
  const kernel = loadKernel();
  for (const store of ['user-global', 'project', 'node-local']) {
    assert.ok(kernel.includes(store), `kernel names the ${store} store`);
  }
  // The type taxonomy still drives placement.
  assert.match(kernel, /`type`/, 'kernel still frames the type taxonomy');
  assert.match(kernel, /user.*\u2192.*user-global|`user` \u2192 user-global/, 'maps user \u2192 user-global');
});

test('promotion guidance names all three stores so a base-spawned node learns where to write', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id);
  // Guidance is now built by the persona injector, not returned by promote().
  const guidance = personaDrift(meta.node_id)?.guidance ?? '';
  for (const store of ['user-global', 'project', 'node-local']) {
    assert.ok(guidance.includes(store), `guidance names the ${store} store`);
  }
  assert.ok(guidance.includes(userMemoryDir()), 'guidance names the user-global dir');
  assert.ok(guidance.includes(projectMemoryDir('/tmp/work')), 'guidance names the project dir');
});
