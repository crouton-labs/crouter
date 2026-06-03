// Framework tests for the argv parser and help renderer (inputModel: 'argv').
// Run with: node --import tsx/esm --test src/core/__tests__/argv-parser.test.ts
// These tests exercise parseArgv and renderLeafArgv directly — no process.argv
// mutation, no subprocess spawning.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../command.js';
import { renderLeafArgv } from '../help.js';
import { defineLeaf } from '../command.js';
import type { InputParam, LeafHelp } from '../help.js';

// ---------------------------------------------------------------------------
// parseArgv — flags
// ---------------------------------------------------------------------------

describe('parseArgv: flags', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'plan-id', type: 'string', required: true, constraint: 'Plan id.' },
    { kind: 'flag', name: 'limit', type: 'int', required: false, constraint: 'Max results.', default: 20 },
    { kind: 'flag', name: 'follow', type: 'bool', required: false, constraint: 'Stream.' },
    { kind: 'flag', name: 'status', type: 'enum', choices: ['draft', 'done'], required: false, constraint: 'Filter.' },
  ];

  test('parses --flag value form', async () => {
    const result = await parseArgv(params, ['--plan-id', 'abc123']);
    assert.equal(result['planId'], 'abc123');
  });

  test('parses --flag=value form', async () => {
    const result = await parseArgv(params, ['--plan-id=abc123']);
    assert.equal(result['planId'], 'abc123');
  });

  test('parses int flag', async () => {
    const result = await parseArgv(params, ['--plan-id', 'x', '--limit', '42']);
    assert.equal(result['limit'], 42);
  });

  test('rejects non-integer for int flag', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--plan-id', 'x', '--limit', 'notanint']),
      (err: Error) => { assert.match(err.message, /must be an integer/); return true; },
    );
  });

  test('bool flag: presence = true', async () => {
    const result = await parseArgv(params, ['--plan-id', 'x', '--follow']);
    assert.equal(result['follow'], true);
  });

  test('bool flag: absence = default false', async () => {
    const result = await parseArgv(params, ['--plan-id', 'x']);
    assert.equal(result['follow'], false);
  });

  test('bool flag rejects --flag=value', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--plan-id', 'x', '--follow=true']),
      (err: Error) => { assert.match(err.message, /takes no value/); return true; },
    );
  });

  test('enum flag: valid value passes', async () => {
    const result = await parseArgv(params, ['--plan-id', 'x', '--status', 'draft']);
    assert.equal(result['status'], 'draft');
  });

  test('enum flag: invalid value throws invalid_type', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--plan-id', 'x', '--status', 'unknown']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('int flag default applied when absent', async () => {
    const result = await parseArgv(params, ['--plan-id', 'x']);
    assert.equal(result['limit'], 20);
  });

  test('unknown flag throws unknown_flag', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--plan-id', 'x', '--bogus', 'y']),
      (err: Error) => { assert.match(err.message, /unknown flag/); return true; },
    );
  });

  test('missing required flag throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('kebab-case flag name becomes camelCase key', async () => {
    const result = await parseArgv(params, ['--plan-id', 'abc']);
    assert.ok('planId' in result);
    assert.ok(!('plan-id' in result));
  });
});

// ---------------------------------------------------------------------------
// parseArgv — positional
// ---------------------------------------------------------------------------

describe('parseArgv: positional', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'job-id', required: true, constraint: 'Job id.' },
    { kind: 'flag', name: 'follow', type: 'bool', required: false, constraint: '' },
  ];

  test('parses single positional before flags', async () => {
    const result = await parseArgv(params, ['job-abc', '--follow']);
    assert.equal(result['jobId'], 'job-abc');
    assert.equal(result['follow'], true);
  });

  test('parses single positional after flags', async () => {
    const result = await parseArgv(params, ['--follow', 'job-abc']);
    assert.equal(result['jobId'], 'job-abc');
  });

  test('parses positional after bare --', async () => {
    const result = await parseArgv(params, ['--', 'job-abc']);
    assert.equal(result['jobId'], 'job-abc');
  });

  test('two positionals throws bad_invocation', async () => {
    await assert.rejects(
      () => parseArgv(params, ['job-abc', 'extra']),
      (err: Error) => { assert.match(err.message, /unexpected extra positional/); return true; },
    );
  });

  test('missing required positional throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional when none declared throws bad_invocation', async () => {
    const noPos: InputParam[] = [
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: '' },
    ];
    await assert.rejects(
      () => parseArgv(noPos, ['somevalue']),
      (err: Error) => { assert.match(err.message, /takes no positional/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// parseArgv — stdin satisfied by a positional argument
// ---------------------------------------------------------------------------

describe('parseArgv: stdin-as-positional', () => {
  const params: InputParam[] = [
    { kind: 'stdin', name: 'prompt', required: true, constraint: 'Task.' },
    { kind: 'flag', name: 'agent', type: 'string', required: false, default: 'general', constraint: '' },
  ];

  test('a positional token satisfies a stdin param', async () => {
    const result = await parseArgv(params, ['--agent', 'general', 'Say hi']);
    assert.equal(result['prompt'], 'Say hi');
    assert.equal(result['agent'], 'general');
  });

  test('positional-as-stdin works with the positional before flags', async () => {
    const result = await parseArgv(params, ['Say hi', '--agent', 'general']);
    assert.equal(result['prompt'], 'Say hi');
  });
});

// ---------------------------------------------------------------------------
// parseArgv — context-file
// ---------------------------------------------------------------------------

describe('parseArgv: context-file', () => {
  test('unknown --context-file when not declared throws unknown_flag', async () => {
    const params: InputParam[] = [];
    await assert.rejects(
      () => parseArgv(params, ['--context-file', '/some/path']),
      (err: Error) => { assert.match(err.message, /unknown flag: --context-file/); return true; },
    );
  });

  test('--context-file missing PATH throws missing_parameter', async () => {
    const params: InputParam[] = [
      { kind: 'context-file', name: 'context', required: false, constraint: '' },
    ];
    await assert.rejects(
      () => parseArgv(params, ['--context-file']),
      (err: Error) => { assert.match(err.message, /requires a PATH/); return true; },
    );
  });

  test('--context-file with nonexistent file throws invalid_type', async () => {
    const params: InputParam[] = [
      { kind: 'context-file', name: 'context', required: false, constraint: '' },
    ];
    await assert.rejects(
      () => parseArgv(params, ['--context-file', '/no/such/file/xyz.json']),
      (err: Error) => { assert.match(err.message, /cannot read file/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// renderLeafArgv — help format
// ---------------------------------------------------------------------------

describe('renderLeafArgv: help format', () => {
  const help: LeafHelp = {
    name: 'task claim',
    summary: 'claim a draft task and spawn a worker',
    params: [
      { kind: 'positional', name: 'task-id', required: true, constraint: 'Task in draft state.' },
      { kind: 'flag', name: 'worker', type: 'string', required: false, constraint: 'Worker template.' },
      { kind: 'flag', name: 'follow', type: 'bool', required: false, constraint: 'Stream output.' },
      { kind: 'context-file', name: 'context', required: false, constraint: 'Extra facts for the worker.', shape: '{key: string}' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with crtr job logs.' },
    ],
    outputKind: 'object',
    effects: ['Marks task claimed.'],
  };

  test('starts with name: summary', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.startsWith('task claim: claim a draft task and spawn a worker.'));
  });

  test('contains Input section', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('Input'));
  });

  test('positional shown as TASK_ID', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('TASK-ID'));
  });

  test('bool flag shown without VALUE placeholder', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('--follow'));
    assert.ok(!out.includes('--follow FOLLOW'));
  });

  test('string flag shown with VALUE placeholder', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('--worker WORKER'));
  });

  test('context-file shown as --context-file PATH', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('--context-file PATH'));
  });

  test('contains Output section', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('Output (fields carried in the rendered result)'));
  });

  test('contains Effects section', () => {
    const out = renderLeafArgv(help);
    assert.ok(out.includes('Effects'));
    assert.ok(out.includes('Marks task claimed.'));
  });
});

// ---------------------------------------------------------------------------
// defineLeaf
// ---------------------------------------------------------------------------

describe('defineLeaf', () => {
  test('builds a leaf with the declared params', () => {
    const leaf = defineLeaf({
      name: 'test',
      help: {
        name: 'test',
        summary: 'test leaf',
        params: [],
        output: [],
        outputKind: 'object',
        effects: [],
      },
      run: async () => {},
    });
    assert.equal(leaf.kind, 'leaf');
    assert.equal(leaf.name, 'test');
    assert.deepEqual(leaf.help.params, []);
  });
});
