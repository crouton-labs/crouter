// Tests for the sys subtree after argv migration.
// Exercises: positional key, --value coercion, enum validation (--scope, --target),
// bool presence flags (--fix, --remote, --check).
// Run with: node --import tsx/esm --test 'src/core/__tests__/**/*.test.ts'

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../command.js';
import type { InputParam } from '../help.js';

// ---------------------------------------------------------------------------
// Shared param schemas (mirror sys.ts definitions)
// ---------------------------------------------------------------------------

const configGetParams: InputParam[] = [
  { kind: 'positional', name: 'key', type: 'string', required: true, constraint: 'Dotted key path.' },
  { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Scope.' },
];

const configSetParams: InputParam[] = [
  { kind: 'positional', name: 'key', type: 'string', required: true, constraint: 'Dotted key path.' },
  { kind: 'flag', name: 'value', type: 'string', required: true, constraint: 'Value to write.' },
  { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Scope.' },
];

const configPathParams: InputParam[] = [
  { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Scope.' },
];

const sysDoctorParams: InputParam[] = [
  { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Scope.' },
  { kind: 'flag', name: 'fix', type: 'bool', required: false, constraint: '' },
  { kind: 'flag', name: 'remote', type: 'bool', required: false, constraint: '' },
];

const sysUpdateParams: InputParam[] = [
  { kind: 'flag', name: 'target', type: 'enum', choices: ['self', 'content', 'all'], required: false, constraint: '' },
  { kind: 'flag', name: 'check', type: 'bool', required: false, constraint: '' },
];

// ---------------------------------------------------------------------------
// sys config get
// ---------------------------------------------------------------------------

describe('sys config get: argv parsing', () => {
  test('positional key is required — missing throws', async () => {
    await assert.rejects(
      () => parseArgv(configGetParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional key is captured', async () => {
    const result = await parseArgv(configGetParams, ['auto_update.crtr']);
    assert.equal(result['key'], 'auto_update.crtr');
  });

  test('--scope valid enum passes', async () => {
    const result = await parseArgv(configGetParams, ['some.key', '--scope', 'project']);
    assert.equal(result['scope'], 'project');
  });

  test('--scope "all" is valid', async () => {
    const result = await parseArgv(configGetParams, ['some.key', '--scope', 'all']);
    assert.equal(result['scope'], 'all');
  });

  test('--scope invalid enum throws', async () => {
    await assert.rejects(
      () => parseArgv(configGetParams, ['some.key', '--scope', 'global']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--scope absent leaves field undefined', async () => {
    const result = await parseArgv(configGetParams, ['some.key']);
    assert.equal(result['scope'], undefined);
  });
});

// ---------------------------------------------------------------------------
// sys config set — value coercion
// ---------------------------------------------------------------------------

describe('sys config set: --value coercion', () => {
  test('string value passed through unchanged', async () => {
    const result = await parseArgv(configSetParams, ['some.key', '--value', 'hello']);
    assert.equal(result['value'], 'hello');
  });

  test('"true" string arrives as string (handler coerces)', async () => {
    const result = await parseArgv(configSetParams, ['some.key', '--value', 'true']);
    // The argv layer keeps it as a string; the handler calls parseConfigValue
    assert.equal(result['value'], 'true');
  });

  test('"false" string arrives as string', async () => {
    const result = await parseArgv(configSetParams, ['some.key', '--value', 'false']);
    assert.equal(result['value'], 'false');
  });

  test('integer string arrives as string', async () => {
    const result = await parseArgv(configSetParams, ['some.key', '--value', '42']);
    assert.equal(result['value'], '42');
  });

  test('--value is required — missing throws', async () => {
    await assert.rejects(
      () => parseArgv(configSetParams, ['some.key']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('key positional is required — missing throws', async () => {
    await assert.rejects(
      () => parseArgv(configSetParams, ['--value', 'x']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('--scope valid enum passes', async () => {
    const result = await parseArgv(configSetParams, ['some.key', '--value', 'x', '--scope', 'user']);
    assert.equal(result['scope'], 'user');
  });

  test('--scope "all" rejected (not in choices)', async () => {
    await assert.rejects(
      () => parseArgv(configSetParams, ['some.key', '--value', 'x', '--scope', 'all']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// parseConfigValue coercion (via a thin harness)
// ---------------------------------------------------------------------------

// We re-implement parseConfigValue's logic inline here to keep the test
// self-contained (it's a private helper in sys.ts).
function parseConfigValue(raw: string): boolean | number | string {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

describe('parseConfigValue coercion', () => {
  test('"true" → boolean true', () => { assert.strictEqual(parseConfigValue('true'), true); });
  test('"false" → boolean false', () => { assert.strictEqual(parseConfigValue('false'), false); });
  test('"42" → number 42', () => { assert.strictEqual(parseConfigValue('42'), 42); });
  test('"-1" → number -1', () => { assert.strictEqual(parseConfigValue('-1'), -1); });
  test('"notify" → string', () => { assert.strictEqual(parseConfigValue('notify'), 'notify'); });
  test('"3.14" → string (non-integer float stays string)', () => { assert.strictEqual(parseConfigValue('3.14'), '3.14'); });
  test('empty string → string', () => { assert.strictEqual(parseConfigValue(''), ''); });
});

// ---------------------------------------------------------------------------
// sys config path
// ---------------------------------------------------------------------------

describe('sys config path: argv parsing', () => {
  test('no args parses cleanly', async () => {
    const result = await parseArgv(configPathParams, []);
    assert.equal(result['scope'], undefined);
  });

  test('--scope user', async () => {
    const result = await parseArgv(configPathParams, ['--scope', 'user']);
    assert.equal(result['scope'], 'user');
  });

  test('--scope all', async () => {
    const result = await parseArgv(configPathParams, ['--scope', 'all']);
    assert.equal(result['scope'], 'all');
  });

  test('invalid --scope throws', async () => {
    await assert.rejects(
      () => parseArgv(configPathParams, ['--scope', 'bogus']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// sys doctor — bool presence flags
// ---------------------------------------------------------------------------

describe('sys doctor: bool presence flags', () => {
  test('no args: fix=false, remote=false, scope=undefined', async () => {
    const result = await parseArgv(sysDoctorParams, []);
    assert.equal(result['fix'], false);
    assert.equal(result['remote'], false);
    assert.equal(result['scope'], undefined);
  });

  test('--fix sets fix=true', async () => {
    const result = await parseArgv(sysDoctorParams, ['--fix']);
    assert.equal(result['fix'], true);
  });

  test('--remote sets remote=true', async () => {
    const result = await parseArgv(sysDoctorParams, ['--remote']);
    assert.equal(result['remote'], true);
  });

  test('--fix --remote both set', async () => {
    const result = await parseArgv(sysDoctorParams, ['--fix', '--remote']);
    assert.equal(result['fix'], true);
    assert.equal(result['remote'], true);
  });

  test('--scope user is valid', async () => {
    const result = await parseArgv(sysDoctorParams, ['--scope', 'user']);
    assert.equal(result['scope'], 'user');
  });

  test('--scope project is valid', async () => {
    const result = await parseArgv(sysDoctorParams, ['--scope', 'project']);
    assert.equal(result['scope'], 'project');
  });

  test('--scope all rejected (not in choices for doctor)', async () => {
    await assert.rejects(
      () => parseArgv(sysDoctorParams, ['--scope', 'all']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--fix=true rejected (bool takes no value)', async () => {
    await assert.rejects(
      () => parseArgv(sysDoctorParams, ['--fix=true']),
      (err: Error) => { assert.match(err.message, /takes no value/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// sys update — enum target + --check bool
// ---------------------------------------------------------------------------

describe('sys update: argv parsing', () => {
  test('no args: check=false, target=undefined', async () => {
    const result = await parseArgv(sysUpdateParams, []);
    assert.equal(result['check'], false);
    assert.equal(result['target'], undefined);
  });

  test('--check sets check=true', async () => {
    const result = await parseArgv(sysUpdateParams, ['--check']);
    assert.equal(result['check'], true);
  });

  test('--target self is valid', async () => {
    const result = await parseArgv(sysUpdateParams, ['--target', 'self']);
    assert.equal(result['target'], 'self');
  });

  test('--target content is valid', async () => {
    const result = await parseArgv(sysUpdateParams, ['--target', 'content']);
    assert.equal(result['target'], 'content');
  });

  test('--target all is valid', async () => {
    const result = await parseArgv(sysUpdateParams, ['--target', 'all']);
    assert.equal(result['target'], 'all');
  });

  test('--target bogus throws invalid_type', async () => {
    await assert.rejects(
      () => parseArgv(sysUpdateParams, ['--target', 'bogus']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--check --target self combined', async () => {
    const result = await parseArgv(sysUpdateParams, ['--check', '--target', 'self']);
    assert.equal(result['check'], true);
    assert.equal(result['target'], 'self');
  });
});
