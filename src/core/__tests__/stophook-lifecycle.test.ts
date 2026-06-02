// Tests for agent-stophook.ts lifecycle gating (Phase 1.4).
//
// Run with: node --import tsx/esm --test src/core/__tests__/stophook-lifecycle.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testing } from '../../pi-extensions/agent-stophook.js';

const { registerHandlers } = __testing;

// ---------------------------------------------------------------------------
// Fake pi
// ---------------------------------------------------------------------------

interface FakePi {
  on: (e: string, h: (ev: any, ctx: any) => void) => void;
  fire: (e: string, ev: any, ctx: any) => void;
}

function makeFakePi(): FakePi {
  const handlers: Record<string, (ev: any, ctx: any) => void> = {};
  return {
    on(e, h) { handlers[e] = h; },
    fire(e, ev, ctx) { handlers[e]?.(ev, ctx); },
  };
}

// ---------------------------------------------------------------------------
// Fake spawn deps
// ---------------------------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: any;
}

function makeSpawnDeps() {
  const calls: SpawnCall[] = [];
  const spawnSyncFn = (cmd: string, args: string[], opts: any): any => {
    calls.push({ cmd, args: args ?? [], opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  const spawnFn = (cmd: string, args: string[], _opts: any): any => {
    calls.push({ cmd, args: args ?? [], opts: _opts });
    return { on: () => {}, unref: () => {} };
  };
  return { calls, spawnSyncFn, spawnFn };
}

// ---------------------------------------------------------------------------
// Fixtures: a minimal assistant message with a natural stop
// ---------------------------------------------------------------------------

function assistantMessage(text: string, stopReason = 'stop') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    usage: { input: 10, output: 20 },
    model: 'test-model',
  };
}

// ---------------------------------------------------------------------------
// Helpers: write meta.json at the expected XDG path
// ---------------------------------------------------------------------------

let stateDir: string;
let origXdg: string | undefined;
let origJobId: string | undefined;
let origLifecycle: string | undefined;

before(() => {
  stateDir = join(tmpdir(), `crtr-stophook-test-${Date.now()}`);
  mkdirSync(stateDir, { recursive: true });
  origXdg = process.env['XDG_STATE_HOME'];
  origJobId = process.env['CRTR_JOB_ID'];
  origLifecycle = process.env['CRTR_JOB_LIFECYCLE'];
  process.env['XDG_STATE_HOME'] = stateDir;
});

after(() => {
  if (origXdg === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = origXdg;
  if (origJobId === undefined) delete process.env['CRTR_JOB_ID'];
  else process.env['CRTR_JOB_ID'] = origJobId;
  if (origLifecycle === undefined) delete process.env['CRTR_JOB_LIFECYCLE'];
  else process.env['CRTR_JOB_LIFECYCLE'] = origLifecycle;
  rmSync(stateDir, { recursive: true, force: true });
});

function writeJobMeta(jobId: string, lifecycle?: string): void {
  const dir = join(stateDir, 'crtr', 'jobs', jobId);
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = {
    job_id: jobId,
    kind: 'general',
    created_at: new Date().toISOString(),
    cwd: '/tmp',
    status: 'live',
  };
  if (lifecycle !== undefined) meta['lifecycle'] = lifecycle;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-stophook lifecycle gating', () => {
  test('worker lifecycle: agent_end with natural stop calls crtr job submit and shutdown', () => {
    const jobId = 'test-worker-job';
    writeJobMeta(jobId, 'worker');
    delete process.env['CRTR_JOB_LIFECYCLE'];

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('final result text');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 1, 'worker must call crtr job submit exactly once');
    assert.equal(shutdownCalled.length, 1, 'worker must call ctx.shutdown()');
  });

  test('persistent lifecycle: agent_end does NOT call crtr job submit or shutdown', () => {
    const jobId = 'test-persistent-job';
    writeJobMeta(jobId, 'persistent');
    delete process.env['CRTR_JOB_LIFECYCLE'];

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('some work done');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 0, 'persistent must NOT call crtr job submit');
    assert.equal(shutdownCalled.length, 0, 'persistent must NOT call ctx.shutdown()');

    // Telemetry IS pushed for persistent agents.
    const telemetryCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'telemetry');
    assert.equal(telemetryCalls.length, 1, 'persistent must still push telemetry');
  });

  test('persistent: env var fallback when meta.json is absent (no file)', () => {
    const jobId = 'test-no-meta-job';
    // Do NOT write meta.json — simulate missing file.
    process.env['CRTR_JOB_LIFECYCLE'] = 'persistent';

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('text');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 0, 'env fallback: persistent must not submit');
    assert.equal(shutdownCalled.length, 0, 'env fallback: persistent must not shutdown');

    delete process.env['CRTR_JOB_LIFECYCLE'];
  });

  test('worker default when no meta and no env (absent lifecycle = worker-equivalent)', () => {
    const jobId = 'test-default-worker-job';
    // No meta.json, no env → defaults to 'worker'.
    delete process.env['CRTR_JOB_LIFECYCLE'];

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('default text');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 1, 'default (no meta/env) must behave as worker and submit');
    assert.equal(shutdownCalled.length, 1, 'default must call shutdown');
  });

  test('meta lifecycle takes precedence over env var', () => {
    const jobId = 'test-meta-over-env-job';
    // meta says worker, env says persistent — meta wins.
    writeJobMeta(jobId, 'worker');
    process.env['CRTR_JOB_LIFECYCLE'] = 'persistent';

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('meta wins text');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 1, 'meta=worker must submit despite env=persistent');
    assert.equal(shutdownCalled.length, 1, 'meta=worker must shutdown');

    delete process.env['CRTR_JOB_LIFECYCLE'];
  });

  test('non-natural stopReason aborted: no submit, no shutdown regardless of lifecycle', () => {
    const jobId = 'test-aborted-job';
    writeJobMeta(jobId, 'worker');

    const pi = makeFakePi();
    const { calls, spawnSyncFn, spawnFn } = makeSpawnDeps();
    const shutdownCalled: boolean[] = [];

    registerHandlers(pi as any, jobId, { spawnSyncFn: spawnSyncFn as any, spawnFn: spawnFn as any });

    const msg = assistantMessage('partial', 'aborted');
    pi.fire('agent_end', { messages: [msg] }, { shutdown: () => { shutdownCalled.push(true); } });

    const submitCalls = calls.filter((c) => c.cmd === 'crtr' && c.args[0] === 'job' && c.args[1] === 'submit');
    assert.equal(submitCalls.length, 0, 'aborted reason: must not submit');
    assert.equal(shutdownCalled.length, 0, 'aborted reason: must not shutdown');
  });
});
