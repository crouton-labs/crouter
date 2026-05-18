// Tests for the job subtree argv migration.
// Exercises parseArgv against each leaf's param schema directly — no subprocess,
// no tmux, no filesystem side-effects from the handler.
//
// Run with: node --import tsx/esm --test src/core/__tests__/job.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const submitParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
  { kind: 'context-file', name: 'result', required: true, constraint: '' },
  { kind: 'flag', name: 'kill-pane', type: 'bool', required: false, constraint: '' },
];

const cancelParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
];

const failParams: InputParam[] = [
  { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: '' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): void {
  tmpDir = join(tmpdir(), `crtr-job-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
}

function teardown(): void {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeTmpJson(name: string, obj: unknown): string {
  const p = join(tmpDir, name);
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// job start prompt
// ---------------------------------------------------------------------------

describe('job start prompt', () => {
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
// job start fork
// ---------------------------------------------------------------------------

describe('job start fork', () => {
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
// job start planner
// ---------------------------------------------------------------------------

describe('job start planner', () => {
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
// job start implementer
// ---------------------------------------------------------------------------

describe('job start implementer', () => {
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
// job start reviewer
// ---------------------------------------------------------------------------

describe('job start reviewer', () => {
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
  // setup/teardown wraps tests via explicit calls since node:test lacks
  // per-describe lifecycle hooks in older versions.
  test('--context-file with valid JSON object', async () => {
    setup();
    try {
      const p = writeTmpJson('result.json', { status: 'done', summary: 'all good' });
      const result = await parseArgv(submitParams, ['job-abc', '--context-file', p]);
      assert.equal(result['job_id'], 'job-abc');
      assert.deepEqual(result['result'], { status: 'done', summary: 'all good' });
      assert.equal(result['killPane'], false);
    } finally {
      teardown();
    }
  });

  test('--kill-pane presence = true, killPane key', async () => {
    setup();
    try {
      const p = writeTmpJson('result.json', { status: 'done' });
      const result = await parseArgv(submitParams, ['job-abc', '--context-file', p, '--kill-pane']);
      assert.equal(result['killPane'], true);
    } finally {
      teardown();
    }
  });

  test('missing --context-file throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, ['job-abc']),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('missing positional job_id throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('--context-file with non-existent file throws invalid_type', async () => {
    await assert.rejects(
      () => parseArgv(submitParams, ['job-abc', '--context-file', '/no/such/file.json']),
      (err: Error) => { assert.match(err.message, /cannot read file/); return true; },
    );
  });

  test('--context-file with invalid JSON throws invalid_type', async () => {
    setup();
    try {
      const p = join(tmpDir, 'bad.json');
      writeFileSync(p, 'not json', 'utf8');
      await assert.rejects(
        () => parseArgv(submitParams, ['job-abc', '--context-file', p]),
        (err: Error) => { assert.match(err.message, /not valid JSON/); return true; },
      );
    } finally {
      teardown();
    }
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
