// Tests for parseSkillQualifier (slash-only form) and config migration.
//
// Run with: node --import tsx/esm --test 'src/core/__tests__/resolver.test.ts'

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir as nodeHomedir } from 'node:os';
import { join } from 'node:path';
import { parseSkillQualifier } from '../resolver.js';
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
