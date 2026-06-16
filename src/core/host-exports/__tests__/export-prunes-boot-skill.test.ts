// Regression: crouter must not leave its old generated `crtr-skills` Agent Skill
// installed in pi/Claude host skill dirs after memory became the first-class
// guidance surface. The legacy bundle caused pi to inject an <available_skills>
// block that described SKILL.md as current crouter behavior.
//
// Run: node --import tsx/esm --test src/core/host-exports/__tests__/export-prunes-boot-skill.test.ts

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineBranch, defineLeaf, defineRoot } from '../../command.js';
import { provisionExports } from '../export.js';

let home: string;
let prevHome: string | undefined;
let prevNoExports: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevNoExports = process.env.CRTR_NO_EXPORTS;
  home = mkdtempSync(join(tmpdir(), 'crtr-export-prune-'));
  process.env.HOME = home;
  delete process.env.CRTR_NO_EXPORTS;

  mkdirSync(join(home, '.pi', 'agent', 'skills', 'crtr-skills'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'crtr-skills'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'skills', 'crtr-skills', 'SKILL.md'),
    '---\nname: crtr-skills\n---\n\n<!-- crtr-boot-skill v2 -->\n',
    'utf8',
  );
  writeFileSync(
    join(home, '.claude', 'skills', 'crtr-skills', 'SKILL.md'),
    '---\nname: crtr-skills\n---\n\nuser-customized, no crtr marker\n',
    'utf8',
  );
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevNoExports === undefined) delete process.env.CRTR_NO_EXPORTS;
  else process.env.CRTR_NO_EXPORTS = prevNoExports;
  rmSync(home, { recursive: true, force: true });
});

const root = defineRoot({
  tagline: 'fixture',
  globals: [],
  subtrees: [
    defineBranch({
      name: 'fixture',
      help: { name: 'fixture', summary: 'fixture' },
      rootEntry: { concept: 'fixture', desc: 'fixture', useWhen: 'fixture' },
      children: [
        defineLeaf({
          name: 'demo',
          help: {
            name: 'fixture demo',
            summary: 'demo',
            output: [],
            outputKind: 'object',
            effects: ['None. Read-only.'],
          },
          slash: {
            name: 'demo',
            description: 'demo command',
            body: 'run demo',
          },
          run: async () => ({}),
        }),
      ],
    }),
  ],
});

test('provisionExports prunes marker-bearing legacy boot skills and still writes slash commands', () => {
  provisionExports(root, ['node', 'crtr', 'fixture']);

  assert.equal(
    existsSync(join(home, '.pi', 'agent', 'skills', 'crtr-skills', 'SKILL.md')),
    false,
    'marker-bearing pi crtr-skills bundle should be removed',
  );
  assert.equal(
    existsSync(join(home, '.claude', 'skills', 'crtr-skills', 'SKILL.md')),
    true,
    'markerless user-owned Claude skill should not be removed',
  );
  assert.match(
    readFileSync(join(home, '.pi', 'agent', 'prompts', 'demo.md'), 'utf8'),
    /<!-- crtr-mode-cmd v1 -->/,
    'pi slash-command export should still be provisioned',
  );
  assert.match(
    readFileSync(join(home, '.claude', 'commands', 'demo.md'), 'utf8'),
    /<!-- crtr-mode-cmd v1 -->/,
    'Claude slash-command export should still be provisioned',
  );
});

test('bare front-door argv prunes legacy boot skills before pi can start', () => {
  provisionExports(root, ['node', 'crtr']);

  assert.equal(
    existsSync(join(home, '.pi', 'agent', 'skills', 'crtr-skills', 'SKILL.md')),
    false,
    'bare crtr must remove stale pi crtr-skills before booting pi',
  );
  assert.equal(
    existsSync(join(home, '.pi', 'agent', 'prompts', 'demo.md')),
    false,
    'bare front-door pruning must not provision slash-command prompts',
  );
});
