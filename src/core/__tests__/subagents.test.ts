// Tests for subagent discovery, resolution, and frontmatter parsing.
//
// Run with: node --import tsx/esm --test src/core/__tests__/subagents.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSubagents, resolveSubagent, subagentId } from '../subagents.js';
import { resetScopeCache } from '../scope.js';
import { parseFrontmatterGeneric } from '../frontmatter.js';

describe('parseFrontmatterGeneric', () => {
  test('returns raw record including tools/model fields skills ignore', () => {
    const src = '---\nname: scout\ndescription: recon\nmodel: haiku\ntools: read, grep, bash\n---\nBody here.\n';
    const { data, body } = parseFrontmatterGeneric(src);
    assert.ok(data !== null);
    assert.equal(data!['name'], 'scout');
    assert.equal(data!['description'], 'recon');
    assert.equal(data!['model'], 'haiku');
    assert.equal(data!['tools'], 'read, grep, bash');
    assert.equal(body, 'Body here.\n');
  });

  test('list-style tools parse to an array', () => {
    const src = '---\nname: x\ndescription: d\ntools:\n  - read\n  - bash\n---\nb\n';
    const { data } = parseFrontmatterGeneric(src);
    assert.deepEqual(data!['tools'], ['read', 'bash']);
  });

  test('no frontmatter yields null data', () => {
    const { data, body } = parseFrontmatterGeneric('just a body');
    assert.equal(data, null);
    assert.equal(body, 'just a body');
  });
});

describe('subagent discovery (project scope)', () => {
  let dir: string;
  const origCwd = process.cwd();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'crtr-subagents-'));
    const agents = join(dir, '.crouter', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(dir, '.crouter', 'config.json'), '{}');
    writeFileSync(
      join(agents, 'scout.md'),
      '---\nname: scout\ndescription: Fast recon\nmodel: haiku\ntools: read, grep\n---\nYou are a scout.\n',
    );
    writeFileSync(
      join(agents, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code review\n---\nYou review code.\n',
    );
    // Missing description → skipped from listings.
    writeFileSync(join(agents, 'broken.md'), '---\nname: broken\n---\nno description\n');
    // Name defaults to filename stem when frontmatter omits it.
    writeFileSync(join(agents, 'stemmed.md'), '---\ndescription: named by file\n---\nbody\n');
    process.chdir(dir);
    resetScopeCache();
  });

  after(() => {
    process.chdir(origCwd);
    resetScopeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test('listSubagents finds valid agents and skips description-less files', () => {
    const ids = listSubagents('project').map(subagentId).sort();
    assert.deepEqual(ids, ['reviewer', 'scout', 'stemmed']);
  });

  test('frontmatter tools comma-string coerces to array; model carried', () => {
    const scout = resolveSubagent('scout', { scope: 'project' });
    assert.deepEqual(scout.frontmatter.tools, ['read', 'grep']);
    assert.equal(scout.frontmatter.model, 'haiku');
    assert.equal(scout.systemPrompt.trim(), 'You are a scout.');
    assert.equal(scout.plugin, '_');
  });

  test('name defaults to filename stem', () => {
    const a = resolveSubagent('stemmed', { scope: 'project' });
    assert.equal(a.name, 'stemmed');
    assert.equal(a.frontmatter.description, 'named by file');
  });

  test('resolveSubagent throws notFound for unknown name', () => {
    assert.throws(() => resolveSubagent('nope', { scope: 'project' }), /subagent not found/);
  });
});
