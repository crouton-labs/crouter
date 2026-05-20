// Tests for jobs.ts result-file storage (markdown vs json paths).
//
// Run with: node --import tsx/esm --test src/core/__tests__/jobs.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJob,
  writeResult,
  writeMarkdownResult,
  readResult,
} from '../jobs.js';

let stateDir: string;
let origXdg: string | undefined;

before(() => {
  stateDir = join(tmpdir(), `crtr-jobs-test-${Date.now()}`);
  mkdirSync(stateDir, { recursive: true });
  origXdg = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = stateDir;
});

after(() => {
  if (origXdg === undefined) {
    delete process.env['XDG_STATE_HOME'];
  } else {
    process.env['XDG_STATE_HOME'] = origXdg;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe('writeMarkdownResult + readResult round-trip', () => {
  test('done with body writes result.md, parses frontmatter back', async () => {
    const { jobId, dir } = createJob('prompt', { cwd: '/tmp' });
    const body = '**Summary:** all good\n\nMore details on the next line.\n';
    writeMarkdownResult(jobId, body, 'done');

    assert.ok(existsSync(join(dir, 'result.md')), 'result.md should exist');
    assert.ok(!existsSync(join(dir, 'result.json')), 'result.json should NOT exist on md path');

    const raw = readFileSync(join(dir, 'result.md'), 'utf8');
    assert.match(raw, /^---\nstatus: done\nwritten_at: \d{4}-\d{2}-\d{2}T/);
    assert.ok(raw.endsWith(body), 'body preserved at end of file');

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'done');
    assert.equal(r.result_md, body);
    assert.equal(r.reason, undefined);
    assert.equal(r.result, undefined);
  });

  test('failed with reason writes reason into frontmatter and reads it back', async () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    writeMarkdownResult(jobId, '', 'failed', 'broke: had "quoted" parts and a\nnewline');

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'failed');
    assert.equal(r.result_md, '');
    assert.equal(r.reason, 'broke: had "quoted" parts and a\nnewline');
  });

  test('writeResult (JSON) writes result.json and read still works', async () => {
    const { jobId, dir } = createJob('prompt', { cwd: '/tmp' });
    writeResult(jobId, { feedback: 'approved', n: 3 }, 'done');

    assert.ok(existsSync(join(dir, 'result.json')));
    assert.ok(!existsSync(join(dir, 'result.md')));

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'done');
    assert.deepEqual(r.result, { feedback: 'approved', n: 3 });
    assert.equal(r.result_md, undefined);
  });

  test('readResult with no result file and waitMs=0 returns timeout', async () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'timeout');
  });
});
