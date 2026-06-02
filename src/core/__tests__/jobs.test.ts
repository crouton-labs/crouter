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
  markCollected,
  recordJobPane,
  recordJobReportTo,
  cancelJob,
  jobStatus,
  recordJobFlags,
} from '../jobs.js';
import { readNodeInbox, sessionsRoot } from '../inbox.js';

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

describe('closed-pane reaping (zombie prevention)', () => {
  test('live job whose recorded pane is gone is reaped to closed on status read', () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    // A pane id that cannot exist on any tmux server.
    recordJobPane(jobId, '%999999999');

    const status = jobStatus(jobId);
    assert.equal(status.state, 'closed');
  });

  test('reaped job exposes a closed result explaining the closed pane', async () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    recordJobPane(jobId, '%999999999');

    // Trigger the reaper.
    jobStatus(jobId);

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'closed');
    assert.match(r.reason ?? '', /pane closed/);
  });

  test('job with no recorded pane is NOT reaped (stays live)', () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    const status = jobStatus(jobId);
    assert.equal(status.state, 'live');
  });

  test('already-submitted job is never overwritten by the reaper', async () => {
    const { jobId } = createJob('prompt', { cwd: '/tmp' });
    recordJobPane(jobId, '%999999999');
    writeMarkdownResult(jobId, '**done**\n', 'done');

    jobStatus(jobId);

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'done');
    assert.equal(r.result_md, '**done**\n');
  });
});

describe('report_to completion notification (R2)', () => {
  // Notifications write to ~/.crouter/<mangled-cwd>/sessions/<sid>/inboxes/.
  // Use a unique cwd per test and clean up the resulting sessions root.
  const cwds: string[] = [];
  function freshCwd(): string {
    const cwd = join(tmpdir(), `crtr-notif-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwds.push(cwd);
    return cwd;
  }
  after(() => {
    for (const cwd of cwds) {
      try { rmSync(sessionsRoot(cwd), { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  test('writeMarkdownResult delivers exactly one completed event to each report_to target', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['parent-node'], sessionId: 'sess-1', name: 'scout' });
    writeMarkdownResult(jobId, 'result body', 'done');

    const events = readNodeInbox('sess-1', 'parent-node', {}, cwd);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'completed');
    assert.equal(events[0]!.from, jobId);
    assert.equal((events[0]!.data as any).status, 'done');
    assert.equal((events[0]!.data as any).name, 'scout');
    assert.equal((events[0]!.data as any).delivery, 'followUp');
  });

  test('steer delivery hint is carried into the event', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['p'], sessionId: 'sess-steer', delivery: 'steer' });
    writeMarkdownResult(jobId, '', 'done');
    const events = readNodeInbox('sess-steer', 'p', {}, cwd);
    assert.equal((events[0]!.data as any).delivery, 'steer');
  });

  test('writeResult (programmatic) also notifies', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('human', { cwd });
    recordJobReportTo(jobId, { reportTo: ['host'], sessionId: 'sess-2' });
    writeResult(jobId, { approved: true }, 'done');
    const events = readNodeInbox('sess-2', 'host', {}, cwd);
    assert.equal(events.length, 1);
    assert.equal((events[0]!.data as any).status, 'done');
  });

  test('no double-notify when a second terminal write follows (notified guard)', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['n'], sessionId: 'sess-3' });
    writeMarkdownResult(jobId, '', 'done');
    // A second terminal write (e.g. a stray _fail path) must not re-notify.
    writeMarkdownResult(jobId, '', 'failed', 'late');
    const events = readNodeInbox('sess-3', 'n', {}, cwd);
    assert.equal(events.length, 1, 'exactly one notice despite two terminal writes');
  });

  test('readResult is PURE: reading a result writes NO collected tombstone (the ack is the command layer\'s job)', async () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['collector'], sessionId: 'sess-coll' });
    writeMarkdownResult(jobId, 'body', 'done'); // completed event
    await readResult(jobId, { waitMs: 0 });
    await readResult(jobId, { waitMs: 5 });

    const events = readNodeInbox('sess-coll', 'collector', {}, cwd);
    assert.equal(events.filter((e) => e.event === 'completed').length, 1, 'one completed');
    assert.equal(events.filter((e) => e.event === 'collected').length, 0, 'a read must not tombstone');
  });

  test('regression: an abandoned/canceled --wait that resolves later writes NO tombstone (notice survives)', async () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['parent'], sessionId: 'sess-orphan' });
    // Caller abandons the wait (turn canceled); the promise is left to resolve.
    const orphan = readResult(jobId, { waitMs: 10_000 });
    orphan.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    writeMarkdownResult(jobId, 'hi', 'done'); // job finishes -> completed event
    await orphan; // the orphaned wait resolves
    const events = readNodeInbox('sess-orphan', 'parent', {}, cwd);
    assert.equal(events.filter((e) => e.event === 'collected').length, 0, 'orphaned wait must not suppress the notice');
  });

  test('markCollected writes exactly one collected tombstone (idempotent) and only with report_to', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['collector'], sessionId: 'sess-mark' });
    markCollected(jobId);
    markCollected(jobId); // second call must be a no-op (meta.collected guard)
    const events = readNodeInbox('sess-mark', 'collector', {}, cwd);
    const collected = events.filter((e) => e.event === 'collected');
    assert.equal(collected.length, 1, 'exactly one tombstone despite two calls');
    assert.equal(collected[0]!.from, jobId);
    assert.equal((collected[0]!.data as any).job_id, jobId);
  });

  test('cancelJob notifies the report_to parent', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['c'], sessionId: 'sess-4' });
    cancelJob(jobId);
    const events = readNodeInbox('sess-4', 'c', {}, cwd);
    assert.equal(events.length, 1);
    assert.equal((events[0]!.data as any).status, 'canceled');
  });

  test('no report_to / no session_id → no notification, no crash', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('general', { cwd });
    // No recordJobReportTo at all.
    writeMarkdownResult(jobId, 'x', 'done');
    // Nothing should have been written under this cwd's sessions root.
    assert.equal(existsSync(sessionsRoot(cwd)), false);
  });
});

describe('lifecycle fields (Phase 1)', () => {  
  test('createJob persists lifecycle when provided', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp', lifecycle: 'persistent' });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.lifecycle, 'persistent');
  });

  test('createJob persists root and forward when provided', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp', root: true, forward: false });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.root, true);
    assert.equal(raw.forward, false);
  });

  test('createJob with absent lifecycle reads back without the field (worker-equivalent)', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp' });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.lifecycle, undefined);
  });

  test('recordJobFlags merges partial fields without overwriting unset ones', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp', lifecycle: 'persistent' });
    recordJobFlags(jobId, { root: true });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.lifecycle, 'persistent'); // untouched
    assert.equal(raw.root, true);              // set
    assert.equal(raw.forward, undefined);      // not touched
  });

  test('recordJobFlags sets all four flag fields', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp' });
    recordJobFlags(jobId, { lifecycle: 'worker', root: false, forward: false, superseded: true });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.lifecycle, 'worker');
    assert.equal(raw.root, false);
    assert.equal(raw.forward, false);
    assert.equal(raw.superseded, true);
  });

  test('recordJobFlags can promote lifecycle worker→persistent', () => {
    const { jobId, dir } = createJob('general', { cwd: '/tmp', lifecycle: 'worker' });
    recordJobFlags(jobId, { lifecycle: 'persistent' });
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(raw.lifecycle, 'persistent');
  });
});

describe('Phase 2: forward flag + superseded status', () => {
  const cwds: string[] = [];
  function freshCwd(): string {
    const cwd = join(tmpdir(), `crtr-p2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwds.push(cwd);
    return cwd;
  }
  after(() => {
    for (const cwd of cwds) {
      try { rmSync(sessionsRoot(cwd), { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  test('writeMarkdownResult with meta.forward:false writes result.md but NO inbox event', () => {
    const cwd = freshCwd();
    const { jobId, dir } = createJob('subagent', { cwd, forward: false });
    recordJobReportTo(jobId, { reportTo: ['parent-node'], sessionId: 'sess-fwd', name: 'scout' });
    writeMarkdownResult(jobId, 'result body', 'done');

    // result.md must exist
    assert.ok(existsSync(join(dir, 'result.md')), 'result.md should be written');

    // inbox must be empty/absent — no completed event
    const events = readNodeInbox('sess-fwd', 'parent-node', {}, cwd);
    assert.equal(events.length, 0, 'no inbox event when forward:false');
  });

  test('meta.superseded:true + done-submit records status superseded in frontmatter', async () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobFlags(jobId, { superseded: true });
    writeMarkdownResult(jobId, 'last message', 'done');

    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'superseded', 'done-submit with superseded:true should record superseded');
    assert.equal(r.result_md, 'last message');
  });

  test('meta.superseded:true + done-submit with forward:false writes superseded but no inbox event', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd, forward: false });
    recordJobReportTo(jobId, { reportTo: ['parent'], sessionId: 'sess-sup', name: 'stepped' });
    recordJobFlags(jobId, { superseded: true });
    writeMarkdownResult(jobId, 'last msg', 'done');

    const events = readNodeInbox('sess-sup', 'parent', {}, cwd);
    assert.equal(events.length, 0, 'no inbox event for superseded + forward:false');
  });

  test('writeResult (JSON) with forward:false writes result.json but NO inbox event', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('human', { cwd, forward: false });
    recordJobReportTo(jobId, { reportTo: ['host'], sessionId: 'sess-json-fwd' });
    writeResult(jobId, { approved: true }, 'done');

    const events = readNodeInbox('sess-json-fwd', 'host', {}, cwd);
    assert.equal(events.length, 0, 'no inbox event for writeResult with forward:false');
  });

  test('cancelJob with forward:false writes canceled but NO inbox event', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd, forward: false });
    recordJobReportTo(jobId, { reportTo: ['c'], sessionId: 'sess-cancel-fwd' });
    cancelJob(jobId);

    const events = readNodeInbox('sess-cancel-fwd', 'c', {}, cwd);
    assert.equal(events.length, 0, 'no inbox event for cancelJob with forward:false');
  });

  test('failed-status submit with forward:true (default) still notifies', () => {
    const cwd = freshCwd();
    const { jobId } = createJob('subagent', { cwd });
    recordJobReportTo(jobId, { reportTo: ['p'], sessionId: 'sess-fwd-default' });
    writeMarkdownResult(jobId, '', 'failed', 'oops');

    const events = readNodeInbox('sess-fwd-default', 'p', {}, cwd);
    assert.equal(events.length, 1, 'notify still fires when forward is absent (default true)');
    assert.equal((events[0]!.data as any).status, 'failed');
  });
});

describe('Phase 3: pi-root job behavior', () => {
  test('pi-root job with no pid is NOT marked failed by jobStatus', () => {
    // No pid recorded → the pid-alive check does not apply → state stays live.
    const { jobId } = createJob('pi-root', {
      cwd: '/tmp',
      lifecycle: 'persistent',
      root: true,
      forward: false,
    });
    // DO NOT call recordJobPid or recordJobPane.
    const { state } = jobStatus(jobId);
    assert.equal(state, 'live', 'pi-root job with no pid must stay live, not failed');
  });

  test('pi-root job with no pid and no pane stays live (reapIfPaneDead skips it)', () => {
    const { jobId } = createJob('pi-root', { cwd: '/tmp', lifecycle: 'persistent', root: true, forward: false });
    // No pane recorded → reapIfPaneDead returns false immediately.
    const { state } = jobStatus(jobId);
    assert.equal(state, 'live');
  });

  test('pi-root job with a dead pane is reaped to closed by jobStatus', () => {
    const { jobId } = createJob('pi-root', { cwd: '/tmp', lifecycle: 'persistent', root: true, forward: false });
    // Record a pane that cannot exist on any tmux server.
    recordJobPane(jobId, '%pi-root-dead-999');
    const { state } = jobStatus(jobId);
    assert.equal(state, 'closed', 'reapIfPaneDead must write closed when pane is absent');
  });

  test('pi-root job with dead pane exposes closed result', async () => {
    const { jobId } = createJob('pi-root', { cwd: '/tmp', lifecycle: 'persistent', root: true, forward: false });
    recordJobPane(jobId, '%pi-root-dead-888');
    // Trigger reap via jobStatus
    jobStatus(jobId);
    const r = await readResult(jobId, { waitMs: 0 });
    assert.equal(r.status, 'closed');
  });
});
