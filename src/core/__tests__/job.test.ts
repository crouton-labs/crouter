// Tests for the job subtree (monitoring) and agent new * (spawning) argv
// migration. Exercises parseArgv against each leaf's param schema directly —
// no subprocess, no tmux, no filesystem side-effects from the handler.
//
// Run with: node --import tsx/esm --test src/core/__tests__/job.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../command.js';
import type { InputParam } from '../help.js';

// ---------------------------------------------------------------------------
// Param schemas extracted from each leaf (mirrors job.ts exactly)
// ---------------------------------------------------------------------------

const startPromptParams: InputParam[] = [
  { kind: 'stdin', name: 'prompt', required: true, constraint: '' },
  { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
];

const startForkParams: InputParam[] = [
  { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
];

const startPlannerParams: InputParam[] = [
  { kind: 'positional', name: 'spec_path', type: 'path', required: true, constraint: '' },
  { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
];

const startImplementerParams: InputParam[] = [
  { kind: 'positional', name: 'plan_path', type: 'path', required: true, constraint: '' },
  { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
];

const startReviewerParams: InputParam[] = [
  { kind: 'positional', name: 'artifact_path', type: 'path', required: true, constraint: '' },
  { kind: 'flag', name: 'kind', type: 'enum', choices: ['plan', 'spec'], required: true, constraint: '' },
  { kind: 'flag', name: 'spec-path', type: 'path', required: false, constraint: '' },
  { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
];

const readListParams: InputParam[] = [
  { kind: 'flag', name: 'limit', type: 'int', required: false, default: 20, constraint: '' },
  { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: '' },
];

const readStatusParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
];

const readResultParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
  { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: '' },
];

const readLogsParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
  { kind: 'flag', name: 'since', type: 'string', required: false, constraint: '' },
  { kind: 'flag', name: 'until', type: 'string', required: false, constraint: '' },
  { kind: 'flag', name: 'level', type: 'enum', choices: ['debug', 'info', 'warn', 'error'], required: false, default: 'info', constraint: '' },
  { kind: 'flag', name: 'follow', type: 'bool', required: false, constraint: '' },
];

// NOTE: the real leaf also declares a `stdin` param for `body`. We omit it
// from the test schema because parseArgv reads stdin to EOF whenever a stdin
// param is declared — and under `node --test`, stdin is piped with no EOF, so
// the call hangs forever. The body-required-on-status=done check lives in the
// leaf's `run` handler, not in parseArgv, so the schema tests below cover
// everything parseArgv can see without needing stdin.
const submitParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
  { kind: 'flag', name: 'status', type: 'enum', choices: ['done', 'failed'], required: false, default: 'done', constraint: '' },
  { kind: 'flag', name: 'reason', type: 'string', required: false, constraint: '' },
  { kind: 'flag', name: 'kill-pane', type: 'bool', required: false, constraint: '' },
];

const cancelParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
];

const failParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
];

// ---------------------------------------------------------------------------
// agent new prompt (formerly job start prompt)
// ---------------------------------------------------------------------------

describe('agent new prompt', () => {
  // stdin is handled by readStdinRaw() which requires actual stdin — we only
  // test the non-stdin flag parsing here.
  test('--cwd flag parsed as string', async () => {
    // stdin param will be read but we can't pipe here — skip stdin assertion,
    // test that cwd parses correctly alongside other tokens.
    // We test the flag-only shape: no stdin params in isolation.
    const flagOnlyParams: InputParam[] = [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
    ];
    const result = await parseArgv(flagOnlyParams, ['--cwd', '/tmp/mydir']);
    assert.equal(result['cwd'], '/tmp/mydir');
  });

  test('cwd absent → undefined', async () => {
    const flagOnlyParams: InputParam[] = [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: '' },
    ];
    const result = await parseArgv(flagOnlyParams, []);
    assert.equal(result['cwd'], undefined);
  });
});

// ---------------------------------------------------------------------------
// agent new fork (formerly job start fork)
// ---------------------------------------------------------------------------

describe('agent new fork', () => {
  test('no args parses cleanly', async () => {
    const result = await parseArgv(startForkParams, []);
    assert.equal(result['cwd'], undefined);
  });

  test('--cwd parsed', async () => {
    const result = await parseArgv(startForkParams, ['--cwd', '/workspace']);
    assert.equal(result['cwd'], '/workspace');
  });

  test('unknown positional rejected', async () => {
    await assert.rejects(
      () => parseArgv(startForkParams, ['extra-pos']),
      (err: Error) => { assert.match(err.message, /takes no positional/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// agent new planner (formerly job start planner)
// ---------------------------------------------------------------------------

describe('agent new planner', () => {
  test('positional spec_path required', async () => {
    await assert.rejects(
      () => parseArgv(startPlannerParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional parsed as spec_path (camelCase: specPath? no — underscore stays as-is)', async () => {
    const result = await parseArgv(startPlannerParams, ['/tmp/spec.md']);
    // flagNameToKey converts kebab to camel; underscores are unaffected
    assert.equal(result['spec_path'], '/tmp/spec.md');
  });

  test('--cwd optional', async () => {
    const result = await parseArgv(startPlannerParams, ['/tmp/spec.md', '--cwd', '/src']);
    assert.equal(result['cwd'], '/src');
    assert.equal(result['spec_path'], '/tmp/spec.md');
  });
});

// ---------------------------------------------------------------------------
// agent new implementer (formerly job start implementer)
// ---------------------------------------------------------------------------

describe('agent new implementer', () => {
  test('positional plan_path required', async () => {
    await assert.rejects(
      () => parseArgv(startImplementerParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional parsed', async () => {
    const result = await parseArgv(startImplementerParams, ['/tmp/plan.md']);
    assert.equal(result['plan_path'], '/tmp/plan.md');
  });
});

// ---------------------------------------------------------------------------
// agent new reviewer (formerly job start reviewer)
// ---------------------------------------------------------------------------

describe('agent new reviewer', () => {
  test('positional + --kind required', async () => {
    await assert.rejects(
      () => parseArgv(startReviewerParams, ['/tmp/artifact.md']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('valid kind: plan', async () => {
    const result = await parseArgv(startReviewerParams, ['/tmp/artifact.md', '--kind', 'plan']);
    assert.equal(result['artifact_path'], '/tmp/artifact.md');
    assert.equal(result['kind'], 'plan');
  });

  test('valid kind: spec', async () => {
    const result = await parseArgv(startReviewerParams, ['/tmp/artifact.md', '--kind', 'spec']);
    assert.equal(result['kind'], 'spec');
  });

  test('invalid kind throws invalid_type', async () => {
    await assert.rejects(
      () => parseArgv(startReviewerParams, ['/tmp/artifact.md', '--kind', 'bad']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--spec-path optional, becomes specPath', async () => {
    const result = await parseArgv(startReviewerParams, [
      '/tmp/artifact.md', '--kind', 'plan', '--spec-path', '/tmp/spec.md',
    ]);
    assert.equal(result['specPath'], '/tmp/spec.md');
  });
});

// ---------------------------------------------------------------------------
// job read list
// ---------------------------------------------------------------------------

describe('job read list', () => {
  test('defaults: limit=20, cursor=undefined', async () => {
    const result = await parseArgv(readListParams, []);
    assert.equal(result['limit'], 20);
    assert.equal(result['cursor'], undefined);
  });

  test('--limit N parsed as int', async () => {
    const result = await parseArgv(readListParams, ['--limit', '50']);
    assert.equal(result['limit'], 50);
  });

  test('--limit with non-integer throws', async () => {
    await assert.rejects(
      () => parseArgv(readListParams, ['--limit', 'abc']),
      (err: Error) => { assert.match(err.message, /must be an integer/); return true; },
    );
  });

  test('--cursor opaque token', async () => {
    const result = await parseArgv(readListParams, ['--cursor', 'tok_abc123']);
    assert.equal(result['cursor'], 'tok_abc123');
  });

  test('--limit and --cursor together', async () => {
    const result = await parseArgv(readListParams, ['--limit', '5', '--cursor', 'next_page']);
    assert.equal(result['limit'], 5);
    assert.equal(result['cursor'], 'next_page');
  });
});

// ---------------------------------------------------------------------------
// job read status
// ---------------------------------------------------------------------------

describe('job read status', () => {
  test('positional job_id required', async () => {
    await assert.rejects(
      () => parseArgv(readStatusParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional job_id parsed', async () => {
    const result = await parseArgv(readStatusParams, ['job-abc-123']);
    assert.equal(result['job_id'], 'job-abc-123');
  });
});

// ---------------------------------------------------------------------------
// job read result
// ---------------------------------------------------------------------------

describe('job read result', () => {
  test('positional job_id required', async () => {
    await assert.rejects(
      () => parseArgv(readResultParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional job_id without --wait', async () => {
    const result = await parseArgv(readResultParams, ['job-xyz']);
    assert.equal(result['job_id'], 'job-xyz');
    assert.equal(result['wait'], false);
  });

  test('--wait presence = true', async () => {
    const result = await parseArgv(readResultParams, ['job-xyz', '--wait']);
    assert.equal(result['wait'], true);
  });

  test('--wait=value rejected (bool takes no value)', async () => {
    await assert.rejects(
      () => parseArgv(readResultParams, ['job-xyz', '--wait=true']),
      (err: Error) => { assert.match(err.message, /takes no value/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// job read logs
// ---------------------------------------------------------------------------

describe('job read logs', () => {
  test('positional job_id required', async () => {
    await assert.rejects(
      () => parseArgv(readLogsParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('defaults: level=info, follow=false', async () => {
    const result = await parseArgv(readLogsParams, ['job-abc']);
    assert.equal(result['job_id'], 'job-abc');
    assert.equal(result['level'], 'info');
    assert.equal(result['follow'], false);
  });

  test('--follow presence = true', async () => {
    const result = await parseArgv(readLogsParams, ['job-abc', '--follow']);
    assert.equal(result['follow'], true);
  });

  test('--follow=value rejected', async () => {
    await assert.rejects(
      () => parseArgv(readLogsParams, ['job-abc', '--follow=true']),
      (err: Error) => { assert.match(err.message, /takes no value/); return true; },
    );
  });

  test('--level valid enum', async () => {
    const result = await parseArgv(readLogsParams, ['job-abc', '--level', 'debug']);
    assert.equal(result['level'], 'debug');
  });

  test('--level invalid enum throws', async () => {
    await assert.rejects(
      () => parseArgv(readLogsParams, ['job-abc', '--level', 'trace']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--since and --until optional strings', async () => {
    const result = await parseArgv(readLogsParams, [
      'job-abc', '--since', '2025-01-01T00:00:00Z', '--until', '2025-01-02T00:00:00Z',
    ]);
    assert.equal(result['since'], '2025-01-01T00:00:00Z');
    assert.equal(result['until'], '2025-01-02T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// job submit
// ---------------------------------------------------------------------------

describe('job submit', () => {
  test('positional job_id + defaults: status=done, killPane=false', async () => {
    const result = await parseArgv(submitParams, ['job-abc']);
    assert.equal(result['job_id'], 'job-abc');
    assert.equal(result['status'], 'done');
    assert.equal(result['killPane'], false);
  });

  test('--status failed parsed', async () => {
    const result = await parseArgv(submitParams, ['job-abc', '--status', 'failed', '--reason', 'broken']);
    assert.equal(result['status'], 'failed');
    assert.equal(result['reason'], 'broken');
  });

  test('--status invalid enum throws', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, ['job-abc', '--status', 'bogus']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('--kill-pane presence = true, killPane key', async () => {
    const result = await parseArgv(submitParams, ['job-abc', '--kill-pane']);
    assert.equal(result['killPane'], true);
  });

  test('missing positional job_id throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('--context-file no longer accepted', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, ['job-abc', '--context-file', '/tmp/anything']),
      (err: Error) => { assert.match(err.message, /unknown flag: --context-file/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// job cancel
// ---------------------------------------------------------------------------

describe('job cancel', () => {
  test('positional job_id required', async () => {
    await assert.rejects(
      () => parseArgv(cancelParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional job_id parsed', async () => {
    const result = await parseArgv(cancelParams, ['job-abc-123']);
    assert.equal(result['job_id'], 'job-abc-123');
  });
});

// ---------------------------------------------------------------------------
// job _fail
// ---------------------------------------------------------------------------

describe('job _fail', () => {
  test('positional job_id required', async () => {
    await assert.rejects(
      () => parseArgv(failParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('positional job_id parsed', async () => {
    const result = await parseArgv(failParams, ['job-fail-001']);
    assert.equal(result['job_id'], 'job-fail-001');
  });
});
