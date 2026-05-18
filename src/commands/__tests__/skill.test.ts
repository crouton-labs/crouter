// Tests for the skill subtree argv-model migration.
// Run with: node --import tsx/esm --test 'src/commands/__tests__/skill.test.ts'
//
// Tests exercise leaf param schemas via parseArgv (framework) — no subprocess
// spawning, no filesystem side-effects from handler logic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../../core/command.js';
import type { InputParam } from '../../core/help.js';

// ---------------------------------------------------------------------------
// Shared flag param sets (mirrors the leaf definitions exactly)
// ---------------------------------------------------------------------------

const scopeAllFlag: InputParam = {
  kind: 'flag', name: 'scope', type: 'enum',
  choices: ['user', 'project', 'all'], required: false, constraint: '',
};
const scopeWriteFlag: InputParam = {
  kind: 'flag', name: 'scope', type: 'enum',
  choices: ['user', 'project'], required: false, constraint: '',
};
const pluginFlag: InputParam = {
  kind: 'flag', name: 'plugin', type: 'string', required: false, constraint: '',
};
const includeDisabledFlag: InputParam = {
  kind: 'flag', name: 'include-disabled', type: 'bool', required: false, constraint: '',
};

// ---------------------------------------------------------------------------
// skill find list
// ---------------------------------------------------------------------------

describe('skill find list params', () => {
  const params: InputParam[] = [
    scopeAllFlag,
    pluginFlag,
    includeDisabledFlag,
    { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: '' },
    { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: '' },
    { kind: 'flag', name: 'full', type: 'bool', required: false, constraint: '' },
  ];

  test('no args: defaults applied', async () => {
    const r = await parseArgv(params, []);
    assert.equal(r['includeDisabled'], false);
    assert.equal(r['limit'], 50);
    assert.equal(r['scope'], undefined);
    assert.equal(r['plugin'], undefined);
    assert.equal(r['cursor'], undefined);
  });

  test('--scope user', async () => {
    const r = await parseArgv(params, ['--scope', 'user']);
    assert.equal(r['scope'], 'user');
  });

  test('--scope invalid rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--scope', 'bogus']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });

  test('--include-disabled presence = true', async () => {
    const r = await parseArgv(params, ['--include-disabled']);
    assert.equal(r['includeDisabled'], true);
  });

  test('--include-disabled=value rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--include-disabled=yes']),
      (e: Error) => { assert.match(e.message, /takes no value/); return true; },
    );
  });

  test('--limit 100', async () => {
    const r = await parseArgv(params, ['--limit', '100']);
    assert.equal(r['limit'], 100);
  });

  test('--limit non-integer rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--limit', '1.5']),
      (e: Error) => { assert.match(e.message, /must be an integer/); return true; },
    );
  });

  test('--cursor TOKEN', async () => {
    const r = await parseArgv(params, ['--cursor', 'tok_abc']);
    assert.equal(r['cursor'], 'tok_abc');
  });

  test('--plugin my-plugin', async () => {
    const r = await parseArgv(params, ['--plugin', 'my-plugin']);
    assert.equal(r['plugin'], 'my-plugin');
  });

  test('--full presence = true, absence = false', async () => {
    const present = await parseArgv(params, ['--full']);
    assert.equal(present['full'], true);
    const absent = await parseArgv(params, []);
    assert.equal(absent['full'], false);
  });
});

// ---------------------------------------------------------------------------
// skill find search
// ---------------------------------------------------------------------------

describe('skill find search params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'query', required: true, constraint: '' },
    scopeAllFlag,
    pluginFlag,
    includeDisabledFlag,
    { kind: 'flag', name: 'search-body', type: 'bool', required: false, constraint: '' },
  ];

  test('query positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('query parsed as positional', async () => {
    const r = await parseArgv(params, ['my topic']);
    assert.equal(r['query'], 'my topic');
  });

  test('query + flags', async () => {
    const r = await parseArgv(params, ['debugging', '--scope', 'project', '--include-disabled', '--search-body']);
    assert.equal(r['query'], 'debugging');
    assert.equal(r['scope'], 'project');
    assert.equal(r['includeDisabled'], true);
    assert.equal(r['searchBody'], true);
  });

  test('--search-body presence = true, absence = false', async () => {
    const present = await parseArgv(params, ['q', '--search-body']);
    assert.equal(present['searchBody'], true);
    const absent = await parseArgv(params, ['q']);
    assert.equal(absent['searchBody'], false);
  });

  test('--scope all valid', async () => {
    const r = await parseArgv(params, ['q', '--scope', 'all']);
    assert.equal(r['scope'], 'all');
  });
});

// ---------------------------------------------------------------------------
// skill find grep
// ---------------------------------------------------------------------------

describe('skill find grep params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'pattern', required: true, constraint: '' },
    scopeAllFlag,
    pluginFlag,
  ];

  test('pattern positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('pattern parsed as positional', async () => {
    const r = await parseArgv(params, ['foo.*bar']);
    assert.equal(r['pattern'], 'foo.*bar');
  });

  test('pattern + scope + plugin', async () => {
    const r = await parseArgv(params, ['\\btest\\b', '--scope', 'user', '--plugin', 'myplugin']);
    assert.equal(r['pattern'], '\\btest\\b');
    assert.equal(r['scope'], 'user');
    assert.equal(r['plugin'], 'myplugin');
  });
});

// ---------------------------------------------------------------------------
// skill read show
// ---------------------------------------------------------------------------

describe('skill read show params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', required: true, constraint: '' },
    scopeWriteFlag,
    pluginFlag,
    { kind: 'flag', name: 'frontmatter', type: 'bool', required: false, constraint: '' },
  ];

  test('name positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('name parsed correctly', async () => {
    const r = await parseArgv(params, ['my-skill']);
    assert.equal(r['name'], 'my-skill');
  });

  test('--frontmatter presence = true', async () => {
    const r = await parseArgv(params, ['my-skill', '--frontmatter']);
    assert.equal(r['frontmatter'], true);
  });

  test('--frontmatter absent = false', async () => {
    const r = await parseArgv(params, ['my-skill']);
    assert.equal(r['frontmatter'], false);
  });

  test('--scope rejects all', async () => {
    await assert.rejects(
      () => parseArgv(params, ['my-skill', '--scope', 'all']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });

  test('--scope user valid', async () => {
    const r = await parseArgv(params, ['my-skill', '--scope', 'user']);
    assert.equal(r['scope'], 'user');
  });
});

// ---------------------------------------------------------------------------
// skill read where
// ---------------------------------------------------------------------------

describe('skill read where params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', required: true, constraint: '' },
    scopeWriteFlag,
    pluginFlag,
  ];

  test('name positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('name parsed correctly', async () => {
    const r = await parseArgv(params, ['some/nested/skill']);
    assert.equal(r['name'], 'some/nested/skill');
  });

  test('--scope project valid', async () => {
    const r = await parseArgv(params, ['skillname', '--scope', 'project']);
    assert.equal(r['scope'], 'project');
  });
});

// ---------------------------------------------------------------------------
// skill author guide
// ---------------------------------------------------------------------------

describe('skill author guide params', () => {
  const VALID_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'];
  const params: InputParam[] = [
    { kind: 'flag', name: 'type', type: 'enum', choices: VALID_TYPES, required: false, constraint: '' },
    { kind: 'flag', name: 'topic', type: 'string', required: false, constraint: '' },
  ];

  test('no args: both undefined', async () => {
    const r = await parseArgv(params, []);
    assert.equal(r['type'], undefined);
    assert.equal(r['topic'], undefined);
  });

  test('--type playbook', async () => {
    const r = await parseArgv(params, ['--type', 'playbook']);
    assert.equal(r['type'], 'playbook');
  });

  test('--type invalid rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--type', 'bogus']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });

  test('all valid types accepted', async () => {
    for (const t of VALID_TYPES) {
      const r = await parseArgv(params, ['--type', t]);
      assert.equal(r['type'], t);
    }
  });

  test('--topic string', async () => {
    const r = await parseArgv(params, ['--topic', 'debugging methodology']);
    assert.equal(r['topic'], 'debugging methodology');
  });
});

// ---------------------------------------------------------------------------
// skill author scaffold
// ---------------------------------------------------------------------------

describe('skill author scaffold params', () => {
  const VALID_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'];
  const params: InputParam[] = [
    { kind: 'positional', name: 'qualifier', required: true, constraint: '' },
    { kind: 'flag', name: 'type', type: 'enum', choices: VALID_TYPES, required: false, constraint: '' },
    { kind: 'flag', name: 'description', type: 'string', required: false, constraint: '' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('qualifier positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('qualifier parsed correctly', async () => {
    const r = await parseArgv(params, ['myplugin:myskill']);
    assert.equal(r['qualifier'], 'myplugin:myskill');
  });

  test('full invocation', async () => {
    const r = await parseArgv(params, [
      'myplugin:myskill',
      '--type', 'playbook',
      '--scope', 'project',
      '--description', 'Use when debugging',
    ]);
    assert.equal(r['qualifier'], 'myplugin:myskill');
    assert.equal(r['type'], 'playbook');
    assert.equal(r['scope'], 'project');
    assert.equal(r['description'], 'Use when debugging');
  });

  test('--type invalid rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['q:s', '--type', 'invalid']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });

  test('--scope all rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['q:s', '--scope', 'all']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// skill state enable / disable
// ---------------------------------------------------------------------------

describe('skill state enable/disable params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', required: true, constraint: '' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('name positional required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (e: Error) => { assert.match(e.message, /required parameter is missing/); return true; },
    );
  });

  test('name parsed correctly', async () => {
    const r = await parseArgv(params, ['my-skill']);
    assert.equal(r['name'], 'my-skill');
  });

  test('--scope user', async () => {
    const r = await parseArgv(params, ['my-skill', '--scope', 'user']);
    assert.equal(r['scope'], 'user');
  });

  test('--scope project', async () => {
    const r = await parseArgv(params, ['my-skill', '--scope', 'project']);
    assert.equal(r['scope'], 'project');
  });

  test('--scope all rejects', async () => {
    await assert.rejects(
      () => parseArgv(params, ['my-skill', '--scope', 'all']),
      (e: Error) => { assert.match(e.message, /must be one of/); return true; },
    );
  });

  test('plugin:skill qualifier as name', async () => {
    const r = await parseArgv(params, ['myplugin:myskill']);
    assert.equal(r['name'], 'myplugin:myskill');
  });
});
