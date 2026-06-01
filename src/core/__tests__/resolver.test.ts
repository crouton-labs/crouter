// Tests for parseSkillQualifier (slash-only form) and config migration.
//
// Run with: node --import tsx/esm --test 'src/core/__tests__/resolver.test.ts'

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir as nodeHomedir } from 'node:os';
import { join } from 'node:path';
import { parseSkillQualifier, resolveSkill } from '../resolver.js';
import { resetScopeCache } from '../scope.js';
import { CrtrError } from '../errors.js';
import { InputError } from '../io.js';
import { readConfig } from '../config.js';
import { SCHEMA_VERSION } from '../../types.js';

// ---------------------------------------------------------------------------
// parseSkillQualifier — slash-only form
// ---------------------------------------------------------------------------

describe('parseSkillQualifier', () => {
  test('bare name returns single segment', () => {
    const r = parseSkillQualifier('foo');
    assert.deepEqual(r, { segments: ['foo'] });
  });

  test('plugin/name returns two segments', () => {
    const r = parseSkillQualifier('ai/interface');
    assert.deepEqual(r, { segments: ['ai', 'interface'] });
  });

  test('plugin/nested/name returns three segments', () => {
    const r = parseSkillQualifier('ai/interface/cli-design');
    assert.deepEqual(r, { segments: ['ai', 'interface', 'cli-design'] });
  });

  test('scope-qualified user/name sets scope, single segment', () => {
    const r = parseSkillQualifier('user/my-skill');
    assert.deepEqual(r, { scope: 'user', segments: ['my-skill'] });
  });

  test('scope-qualified project/name sets scope', () => {
    const r = parseSkillQualifier('project/my-skill');
    assert.deepEqual(r, { scope: 'project', segments: ['my-skill'] });
  });

  test('scope-qualified user/ai/x/y sets scope and leaves rest as segments', () => {
    const r = parseSkillQualifier('user/ai/x/y');
    assert.deepEqual(r, { scope: 'user', segments: ['ai', 'x', 'y'] });
  });

  test('colon in input throws InputError with invalid_qualifier', () => {
    assert.throws(
      () => parseSkillQualifier('ai:interface/cli-design'),
      (e: unknown) => {
        assert.ok(e instanceof InputError, 'should be InputError');
        assert.equal(e.payload.error, 'invalid_qualifier');
        assert.equal(e.payload.received, 'ai:interface/cli-design');
        assert.ok(e.payload.next.includes('ai/interface/cli-design'), `next should contain slash form, got: ${e.payload.next}`);
        return true;
      },
    );
  });

  test('legacy scope:name form throws invalid_qualifier', () => {
    assert.throws(
      () => parseSkillQualifier('user:my-skill'),
      (e: unknown) => {
        assert.ok(e instanceof InputError);
        assert.equal(e.payload.error, 'invalid_qualifier');
        assert.ok(e.payload.next.includes('user/my-skill'));
        return true;
      },
    );
  });

  test('legacy scope:plugin/name form throws invalid_qualifier', () => {
    assert.throws(
      () => parseSkillQualifier('user:ai/interface/cli-design'),
      (e: unknown) => {
        assert.ok(e instanceof InputError);
        assert.equal(e.payload.error, 'invalid_qualifier');
        assert.ok(e.payload.next.includes('user/ai/interface/cli-design'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Config migration: colon keys → slash keys on readConfig with old schema_version
// ---------------------------------------------------------------------------

describe('config migration: skill keys colon → slash', () => {
  let testHomeDir: string;
  let origHome: string | undefined;
  let crouterDir: string;

  before(() => {
    testHomeDir = join(tmpdir(), `crtr-resolver-test-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    origHome = process.env['HOME'];
    process.env['HOME'] = testHomeDir;
    crouterDir = join(testHomeDir, '.crouter');
    mkdirSync(crouterDir, { recursive: true });
  });

  after(() => {
    if (origHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = origHome;
    }
    rmSync(testHomeDir, { recursive: true, force: true });
  });

  test('colon keys are migrated to slash keys and written with new schema_version', () => {
    const oldConfig = {
      schema_version: 1,
      marketplaces: {},
      plugins: {},
      skills: {
        'ai:foo': { enabled: true },
        'ai:interface/cli-design': { enabled: false },
      },
      auto_update: { crtr: 'notify', content: 'notify', interval_hours: 24 },
      max_panes_per_window: 3,
    };
    writeFileSync(join(crouterDir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const cfg = readConfig('user');

    assert.ok(!('ai:foo' in cfg.skills), 'old colon key should be gone');
    assert.ok('ai/foo' in cfg.skills, 'slash key should exist');
    assert.equal(cfg.skills['ai/foo']?.enabled, true, 'enabled state preserved');

    assert.ok(!('ai:interface/cli-design' in cfg.skills), 'old colon key should be gone');
    assert.ok('ai/interface/cli-design' in cfg.skills, 'slash key should exist for nested');
    assert.equal(cfg.skills['ai/interface/cli-design']?.enabled, false, 'disabled state preserved');

    assert.equal(cfg.schema_version, SCHEMA_VERSION, 'schema_version bumped to current');
  });


});

// ---------------------------------------------------------------------------
// resolveSkill — leaf-name fallback
// ---------------------------------------------------------------------------

describe('resolveSkill leaf-name fallback', () => {
  let testHomeDir: string;
  let origHome: string | undefined;

  function writePluginSkill(plugin: string, skillPath: string) {
    const root = join(testHomeDir, '.crouter', 'plugins', plugin);
    mkdirSync(join(root, '.crouter-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.crouter-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin, version: '0.0.1' }),
      'utf8',
    );
    const skillDir = join(root, 'skills', ...skillPath.split('/'));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${skillPath.split('/').pop()}\n---\nbody`,
      'utf8',
    );
  }

  before(() => {
    testHomeDir = join(tmpdir(), `crtr-leaf-test-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    origHome = process.env['HOME'];
    process.env['HOME'] = testHomeDir;
    resetScopeCache();
    // Unique leaf: only one plugin has it, reached via nested path.
    writePluginSkill('ai', 'interface/cli-design');
    // Colliding leaf: two plugins both expose `dup` at different paths.
    writePluginSkill('pa', 'x/dup');
    writePluginSkill('pb', 'y/dup');
  });

  after(() => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    resetScopeCache();
    rmSync(testHomeDir, { recursive: true, force: true });
  });

  test('bare leaf name resolves to the nested skill', () => {
    const s = resolveSkill('cli-design');
    assert.equal(s.name, 'interface/cli-design');
    assert.equal(s.plugin, 'ai');
  });

  test('full path still resolves directly', () => {
    const s = resolveSkill('ai/interface/cli-design');
    assert.equal(s.name, 'interface/cli-design');
    assert.equal(s.plugin, 'ai');
  });

  test('colliding leaf name throws ambiguous listing full paths', () => {
    assert.throws(
      () => resolveSkill('dup'),
      (e: unknown) => {
        assert.ok(e instanceof CrtrError, 'should be CrtrError');
        assert.equal(e.code, 'ambiguous');
        assert.match(e.message, /pa\/x\/dup/);
        assert.match(e.message, /pb\/y\/dup/);
        return true;
      },
    );
  });

  test('colliding leaf is resolvable via full path', () => {
    const s = resolveSkill('pb/y/dup');
    assert.equal(s.plugin, 'pb');
    assert.equal(s.name, 'y/dup');
  });

  test('unknown leaf still throws not_found', () => {
    assert.throws(
      () => resolveSkill('no-such-leaf-xyz'),
      (e: unknown) => {
        assert.ok(e instanceof CrtrError);
        assert.equal(e.code, 'not_found');
        return true;
      },
    );
  });
});
