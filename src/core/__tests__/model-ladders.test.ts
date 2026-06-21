// Run: node --import tsx/esm --test src/core/__tests__/model-ladders.test.ts
//
// The runtime model ladder is user-configurable: config.json can override the
// provider default, the per-provider ladder cells, and persona-strength picks.
// This test verifies both the merge shape and the cached sync read invalidation
// on config edits.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig } from '../config.js';
import { buildLaunchSpec, equivalentOtherProviderModel, normalizeModel } from '../runtime/launch.js';

let home: string;
const crtrRoot = () => join(home, '.crouter');
const configFile = () => join(crtrRoot(), 'config.json');

function writeConfig(config: unknown): void {
  mkdirSync(crtrRoot(), { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-model-ladders-'));
  process.env['HOME'] = home;
});

beforeEach(() => {
  rmSync(crtrRoot(), { recursive: true, force: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['HOME'];
});

test('config merge keeps ladder defaults while honoring overrides', () => {
  writeConfig({
    modelLadders: {
      defaultProvider: 'openai',
      anthropic: {
        ultra: 'anthropic/custom-ultra-1',
        strong: 'anthropic/custom-strong-1',
        medium: 'anthropic/custom-medium-1',
        light: 'anthropic/custom-light-1',
      },
      openai: {
        ultra: 'openai/custom-ultra-1',
        strong: 'openai/custom-strong-1',
        medium: 'openai/custom-medium-1',
        light: 'openai/custom-light-1',
      },
    },
    personaStrengths: {
      developer: 'light',
    },
  });

  const cfg = readConfig('user');
  assert.equal(cfg.modelLadders.defaultProvider, 'openai');
  assert.equal(cfg.modelLadders.openai.strong, 'openai/custom-strong-1');
  assert.equal(cfg.modelLadders.anthropic.light, 'anthropic/custom-light-1');
  assert.equal(cfg.personaStrengths.developer, 'light');
});

test('normalizeModel and buildLaunchSpec honor config overrides, and edits invalidate the cache', () => {
  writeConfig({
    modelLadders: {
      defaultProvider: 'openai',
      anthropic: {
        ultra: 'anthropic/custom-ultra-1',
        strong: 'anthropic/custom-strong-1',
        medium: 'anthropic/custom-medium-1',
        light: 'anthropic/custom-light-1',
      },
      openai: {
        ultra: 'openai/custom-ultra-1',
        strong: 'openai/custom-strong-1',
        medium: 'openai/custom-medium-1',
        light: 'openai/custom-light-1',
      },
    },
    personaStrengths: {
      developer: 'light',
    },
  });

  assert.equal(normalizeModel('strong'), 'openai/custom-strong-1', 'config default provider wins over env/default');
  assert.equal(normalizeModel('opus'), 'anthropic/custom-strong-1', 'family aliases still map to anthropic');

  const override = buildLaunchSpec('developer', 'base', {
    lifecycle: 'terminal',
    hasManager: true,
    model: 'medium',
  });
  assert.equal(override.launch.model, 'openai/custom-medium-1', 'meta.model_override wins over personaStrengths');

  const persona = buildLaunchSpec('developer', 'base', {
    lifecycle: 'terminal',
    hasManager: true,
  });
  assert.equal(persona.launch.model, 'openai/custom-light-1', 'personaStrengths wins over persona frontmatter');

  writeConfig({
    modelLadders: {
      defaultProvider: 'anthropic',
      anthropic: {
        ultra: 'anthropic/custom-ultra-2',
        strong: 'anthropic/custom-strong-2',
        medium: 'anthropic/custom-medium-2',
        light: 'anthropic/custom-light-2',
      },
      openai: {
        ultra: 'openai/custom-ultra-2',
        strong: 'openai/custom-strong-2',
        medium: 'openai/custom-medium-2',
        light: 'openai/custom-light-2',
      },
    },
    personaStrengths: {
      developer: 'strong',
    },
  });

  assert.equal(normalizeModel('strong'), 'anthropic/custom-strong-2', 'a config edit invalidates the cached sync read');
  const edited = buildLaunchSpec('developer', 'base', {
    lifecycle: 'terminal',
    hasManager: true,
  });
  assert.equal(edited.launch.model, 'anthropic/custom-strong-2', 'edited personaStrengths are picked up on the next launch');
});

test('equivalentOtherProviderModel maps a failed ladder model to the other provider at the same strength', () => {
  writeConfig({
    modelLadders: {
      defaultProvider: 'anthropic',
      anthropic: {
        ultra: 'anthropic/custom-ultra',
        strong: 'anthropic/custom-strong:high',
        medium: 'anthropic/custom-medium',
        light: 'anthropic/custom-light',
      },
      openai: {
        ultra: 'openai/custom-ultra',
        strong: 'openai/custom-strong:xhigh',
        medium: 'openai/custom-medium',
        light: 'openai/custom-light',
      },
    },
  });

  assert.deepEqual(equivalentOtherProviderModel('anthropic/custom-strong:medium'), {
    fromProvider: 'anthropic',
    toProvider: 'openai',
    strength: 'strong',
    model: 'openai/custom-strong:xhigh',
  });
  assert.deepEqual(equivalentOtherProviderModel('openai/custom-light'), {
    fromProvider: 'openai',
    toProvider: 'anthropic',
    strength: 'light',
    model: 'anthropic/custom-light',
  });
  assert.equal(equivalentOtherProviderModel('anthropic/custom-strong:medium', new Set<'anthropic' | 'openai'>(['anthropic'])), null);
  assert.equal(equivalentOtherProviderModel('some-provider/not-in-ladder'), null);
});

test('malformed existing user config surfaces instead of falling back to defaults', () => {
  mkdirSync(crtrRoot(), { recursive: true });
  writeFileSync(configFile(), '{\n', 'utf8');

  assert.throws(
    () =>
      buildLaunchSpec('developer', 'base', {
        lifecycle: 'terminal',
        hasManager: true,
      }),
    /JSON|Unexpected token|Unexpected end/,
  );
});
