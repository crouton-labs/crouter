// Regression: `crtr sys sync` is the one-shot migration path from legacy
// Agent Skill bundles into crouter memory docs. The hard cut removes SKILL.md as
// an active guidance surface, but must keep the converter.
//
// Run: node --import tsx/esm --test src/commands/sys/__tests__/sync-import.test.ts

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sysSyncLeaf } from '../sync.js';
import { parseFrontmatterGeneric } from '../../../core/frontmatter.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'crtr-sys-sync-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test('imports a SKILL.md bundle as a plain crouter memory doc', async () => {
  const sourceRoot = join(home, '.claude', 'skills');
  const bundle = join(sourceRoot, 'demo-skill');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, 'SKILL.md'),
    '---\nname: Demo Skill\ndescription: Handles demos. Use when demo work appears.\n---\n\n# Demo\n\nDo the demo.\n',
    'utf8',
  );

  const result = await sysSyncLeaf.run({ source: sourceRoot, scope: 'user' });

  assert.equal(result?.imported, 1);
  const target = join(home, '.crouter', 'memory', 'demo-skill.md');
  assert.equal(existsSync(target), true);
  const parsed = parseFrontmatterGeneric(readFileSync(target, 'utf8'));
  assert.equal(parsed.data?.kind, 'knowledge');
  assert.equal(parsed.data?.['system-prompt-visibility'], 'preview');
  assert.equal(parsed.data?.['file-read-visibility'], 'none');
  assert.equal(
    parsed.data?.['when-and-why-to-read'],
    'When demo work appears, this knowledge should be read because handles demos.',
  );
  assert.match(parsed.body, /Do the demo\./);
});

test('skips generated crtr boot skills instead of importing them', async () => {
  const bundle = join(home, '.pi', 'agent', 'skills', 'crtr-skills');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, 'SKILL.md'),
    '---\nname: crtr-skills\n---\n\n<!-- crtr-boot-skill v2 -->\n',
    'utf8',
  );

  const result = await sysSyncLeaf.run({ source: bundle, scope: 'user' });

  assert.equal(result?.imported, 0);
  assert.equal(result?.skipped, 1);
  assert.equal(existsSync(join(home, '.crouter', 'memory', 'crtr-skills.md')), false);
});

test('permanently ignores selected SKILL.md bundles', async () => {
  const sourceRoot = join(home, '.claude', 'skills');
  const bundle = join(sourceRoot, 'ignored-skill');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, 'SKILL.md'),
    '---\nname: Ignored Skill\ndescription: Ignore me. Use when testing ignores.\n---\n\n# Ignore\n',
    'utf8',
  );

  const ignored = await sysSyncLeaf.run({ source: sourceRoot, scope: 'user', ignore: true });
  assert.equal(ignored?.ignored, 1);
  assert.equal(existsSync(join(home, '.crouter', 'skill-import-ignore.json')), true);

  const dry = await sysSyncLeaf.run({ source: sourceRoot, scope: 'user', dryRun: true });
  assert.equal(dry?.wouldImport, 0);
  assert.equal((dry?.results as unknown[]).length, 0);

  const shown = await sysSyncLeaf.run({ source: sourceRoot, scope: 'user', dryRun: true, showIgnored: true });
  assert.equal(shown?.ignored, 1);
  assert.equal((shown?.results as Array<{ status: string }>)[0].status, 'ignored');
});
