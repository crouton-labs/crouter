// Tests for the pkg subtree argv migration.
// Exercises parseArgv against the param schemas declared in pkg.ts leaves.
// No subprocess spawning; no real FS writes. Tests are schema/parsing level only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../command.js';
import type { InputParam } from '../help.js';

// ---------------------------------------------------------------------------
// plugin manage install — positional source + optional flags
// ---------------------------------------------------------------------------

describe('pkg plugin manage install', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'source', type: 'string', required: true, constraint: 'Git URL.' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
    { kind: 'flag', name: 'ref', type: 'string', required: false, constraint: '' },
  ];

  test('positional source is required', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('parses positional source', async () => {
    const result = await parseArgv(params, ['https://github.com/org/my-plugin.git']);
    assert.equal(result['source'], 'https://github.com/org/my-plugin.git');
  });

  test('parses positional source with --scope flag', async () => {
    const result = await parseArgv(params, ['https://github.com/org/repo.git', '--scope', 'user']);
    assert.equal(result['source'], 'https://github.com/org/repo.git');
    assert.equal(result['scope'], 'user');
  });

  test('parses --ref flag', async () => {
    const result = await parseArgv(params, ['https://example.com/repo.git', '--ref', 'v1.2.3']);
    assert.equal(result['ref'], 'v1.2.3');
  });

  test('rejects invalid scope enum', async () => {
    await assert.rejects(
      () => parseArgv(params, ['https://example.com/repo.git', '--scope', 'all']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// plugin manage remove / enable / disable — positional name + optional scope
// ---------------------------------------------------------------------------

describe('pkg plugin manage remove/enable/disable', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('parses positional name', async () => {
    const result = await parseArgv(params, ['my-plugin']);
    assert.equal(result['name'], 'my-plugin');
  });

  test('parses name with scope', async () => {
    const result = await parseArgv(params, ['my-plugin', '--scope', 'project']);
    assert.equal(result['name'], 'my-plugin');
    assert.equal(result['scope'], 'project');
  });

  test('missing name throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--scope', 'user']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// plugin manage update — optional --name flag
// ---------------------------------------------------------------------------

describe('pkg plugin manage update', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'name', type: 'string', required: false, constraint: '' },
  ];

  test('no args is valid (update-all path)', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['name'], undefined);
  });

  test('--name sets the name', async () => {
    const result = await parseArgv(params, ['--name', 'my-plugin']);
    assert.equal(result['name'], 'my-plugin');
  });
});

// ---------------------------------------------------------------------------
// plugin inspect list — --include-disabled bool flag + pagination
// ---------------------------------------------------------------------------

describe('pkg plugin inspect list', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: '' },
    { kind: 'flag', name: 'include-disabled', type: 'bool', required: false, constraint: '' },
    { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: '' },
    { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: '' },
  ];

  test('no args returns defaults', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['includeDisabled'], false);
    assert.equal(result['limit'], 50);
    assert.equal(result['scope'], undefined);
    assert.equal(result['cursor'], undefined);
  });

  test('--include-disabled presence sets true', async () => {
    const result = await parseArgv(params, ['--include-disabled']);
    assert.equal(result['includeDisabled'], true);
  });

  test('--include-disabled camelCase key', async () => {
    const result = await parseArgv(params, ['--include-disabled']);
    assert.ok('includeDisabled' in result);
    assert.ok(!('include-disabled' in result));
  });

  test('--limit parsed as int', async () => {
    const result = await parseArgv(params, ['--limit', '25']);
    assert.equal(result['limit'], 25);
  });

  test('--cursor passed through', async () => {
    const result = await parseArgv(params, ['--cursor', 'user:some-plugin']);
    assert.equal(result['cursor'], 'user:some-plugin');
  });

  test('--scope all is valid', async () => {
    const result = await parseArgv(params, ['--scope', 'all']);
    assert.equal(result['scope'], 'all');
  });
});

// ---------------------------------------------------------------------------
// plugin inspect show — positional name
// ---------------------------------------------------------------------------

describe('pkg plugin inspect show', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('parses positional name', async () => {
    const result = await parseArgv(params, ['my-plugin']);
    assert.equal(result['name'], 'my-plugin');
  });

  test('missing name throws', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// market manage install — --marketplace + --plugin required flags
// ---------------------------------------------------------------------------

describe('pkg market manage install', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'marketplace', type: 'string', required: true, constraint: '' },
    { kind: 'flag', name: 'plugin', type: 'string', required: true, constraint: '' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('parses --marketplace and --plugin together', async () => {
    const result = await parseArgv(params, ['--marketplace', 'official', '--plugin', 'my-plugin']);
    assert.equal(result['marketplace'], 'official');
    assert.equal(result['plugin'], 'my-plugin');
  });

  test('missing --marketplace throws', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--plugin', 'my-plugin']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('missing --plugin throws', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--marketplace', 'official']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('parses all three flags', async () => {
    const result = await parseArgv(params, ['--marketplace', 'official', '--plugin', 'my-plugin', '--scope', 'user']);
    assert.equal(result['marketplace'], 'official');
    assert.equal(result['plugin'], 'my-plugin');
    assert.equal(result['scope'], 'user');
  });
});

// ---------------------------------------------------------------------------
// market manage update — optional --marketplace flag
// ---------------------------------------------------------------------------

describe('pkg market manage update', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'marketplace', type: 'string', required: false, constraint: '' },
  ];

  test('no args is valid (update-all path)', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['marketplace'], undefined);
  });

  test('--marketplace sets name', async () => {
    const result = await parseArgv(params, ['--marketplace', 'official']);
    assert.equal(result['marketplace'], 'official');
  });
});

// ---------------------------------------------------------------------------
// market manage remove — positional name
// ---------------------------------------------------------------------------

describe('pkg market manage remove', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'name', type: 'string', required: true, constraint: '' },
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: '' },
  ];

  test('parses positional name', async () => {
    const result = await parseArgv(params, ['official']);
    assert.equal(result['name'], 'official');
  });
});

// ---------------------------------------------------------------------------
// market inspect list / browse — pagination flags
// ---------------------------------------------------------------------------

describe('pkg market inspect list pagination', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: '' },
    { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: '' },
    { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: '' },
  ];

  test('default limit is 50', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['limit'], 50);
  });

  test('--limit and --cursor parsed together', async () => {
    const result = await parseArgv(params, ['--limit', '10', '--cursor', 'tok123']);
    assert.equal(result['limit'], 10);
    assert.equal(result['cursor'], 'tok123');
  });
});

describe('pkg market inspect browse', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'marketplace', type: 'string', required: false, constraint: '' },
    { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: '' },
    { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: '' },
  ];

  test('--marketplace optional', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['marketplace'], undefined);
  });

  test('--marketplace with pagination', async () => {
    const result = await parseArgv(params, ['--marketplace', 'official', '--limit', '20']);
    assert.equal(result['marketplace'], 'official');
    assert.equal(result['limit'], 20);
  });
});
