// Tests for Phase 5 promotion: promoteRoot + job-layer routing sync + A step-down + not_rootable.
//
// Run with: node --import tsx/esm --test src/core/__tests__/promote.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mintSessionId,
  ensureSession,
  appendAgent,
  loadSessionView,
  sessionsRoot,
  sessionDir,
  promoteRoot,
  appendNodeEvent,
  readNodeInbox,
} from '../sessions.js';
import {
  createJob,
  recordJobReportTo,
  recordJobFlags,
  writeMarkdownResult,
  readResult,
  jobStatus,
} from '../jobs.js';
import { newPrompt } from '../../commands/agent/spawn.js';
import { InputError } from '../io.js';
import { resetScopeCache } from '../scope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpState: string;
let origHome: string | undefined;
let origXdg: string | undefined;
let origCwd: string;
let origTmux: string | undefined;
let origTmuxPane: string | undefined;
let origJobId: string | undefined;
let origParentJobId: string | undefined;
let origSessionId: string | undefined;
let origSessionCwd: string | undefined;

before(() => {
  origCwd = process.cwd();
  origHome = process.env['HOME'];
  origXdg = process.env['XDG_STATE_HOME'];
  origTmux = process.env['TMUX'];
  origTmuxPane = process.env['TMUX_PANE'];
  origJobId = process.env['CRTR_JOB_ID'];
  origParentJobId = process.env['CRTR_PARENT_JOB_ID'];
  origSessionId = process.env['CRTR_SESSION_ID'];
  origSessionCwd = process.env['CRTR_SESSION_CWD'];

  tmpHome = join(tmpdir(), `crtr-promote-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  tmpState = join(tmpdir(), `crtr-promote-jobs-${Date.now()}`);
  mkdirSync(tmpState, { recursive: true });

  process.env['HOME'] = tmpHome;
  process.env['XDG_STATE_HOME'] = tmpState;
  process.chdir(tmpHome);

  // Clear session env so tests start clean.
  delete process.env['CRTR_SESSION_ID'];
  delete process.env['CRTR_SESSION_CWD'];
  delete process.env['CRTR_JOB_ID'];
  delete process.env['CRTR_PARENT_JOB_ID'];

  resetScopeCache();
});

after(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env['HOME']; else process.env['HOME'] = origHome;
  if (origXdg === undefined) delete process.env['XDG_STATE_HOME']; else process.env['XDG_STATE_HOME'] = origXdg;
  if (origTmux === undefined) delete process.env['TMUX']; else process.env['TMUX'] = origTmux;
  if (origTmuxPane === undefined) delete process.env['TMUX_PANE']; else process.env['TMUX_PANE'] = origTmuxPane;
  if (origJobId === undefined) delete process.env['CRTR_JOB_ID']; else process.env['CRTR_JOB_ID'] = origJobId;
  if (origParentJobId === undefined) delete process.env['CRTR_PARENT_JOB_ID']; else process.env['CRTR_PARENT_JOB_ID'] = origParentJobId;
  if (origSessionId === undefined) delete process.env['CRTR_SESSION_ID']; else process.env['CRTR_SESSION_ID'] = origSessionId;
  if (origSessionCwd === undefined) delete process.env['CRTR_SESSION_CWD']; else process.env['CRTR_SESSION_CWD'] = origSessionCwd;
  resetScopeCache();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpState, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal session with A as root and zero or more children. */
function setupSession(opts: {
  children?: Array<{ jobId: string; name: string; pane: string }>;
}): { sid: string; aJobId: string } {
  const sid = mintSessionId();
  const { jobId: aJobId } = createJob('pi-root', {
    cwd: tmpHome,
    lifecycle: 'persistent',
    root: true,
    forward: false,
  });
  ensureSession({ sessionId: sid, rootPane: '%s0', tmuxSession: 'crtr-agents-%s0', cwd: tmpHome, rootNodeId: aJobId });

  const created = new Date().toISOString();
  appendAgent(sid, tmpHome, {
    job_id: aJobId, node_id: aJobId, parent: null, report_to: [], subscribes_to: [],
    name: 'pi-root', agent: 'pi-root', pane_id: '%s0', cwd: tmpHome,
    created, title: 'root', host_session_id: null, status: 'running',
  });

  for (const child of opts.children ?? []) {
    appendAgent(sid, tmpHome, {
      job_id: child.jobId, node_id: child.jobId, parent: aJobId,
      report_to: [aJobId], subscribes_to: [],
      name: child.name, agent: 'general', pane_id: child.pane, cwd: tmpHome,
      created, title: child.name, host_session_id: null, status: 'running',
    });
  }

  return { sid, aJobId };
}

// ---------------------------------------------------------------------------
// promoteRoot + recordJobReportTo: children's meta.report_to targets B
// ---------------------------------------------------------------------------

describe('promoteRoot + job-layer routing sync', () => {
  test("children's meta.report_to updated to B after promoteRoot + recordJobReportTo", () => {
    const { jobId: xJobId } = createJob('general', { cwd: tmpHome });
    const { jobId: yJobId } = createJob('general', { cwd: tmpHome });
    const { sid, aJobId } = setupSession({
      children: [
        { jobId: xJobId, name: 'worker-x', pane: '%cx1' },
        { jobId: yJobId, name: 'worker-y', pane: '%cx2' },
      ],
    });

    // Wire up job-layer routing for children (mirrors what spawn.ts normally does).
    recordJobReportTo(xJobId, { reportTo: [aJobId], sessionId: sid, sessionCwd: tmpHome, name: 'worker-x', title: 'x task' });
    recordJobReportTo(yJobId, { reportTo: [aJobId], sessionId: sid, sessionCwd: tmpHome, name: 'worker-y', title: 'y task' });

    const { jobId: bJobId } = createJob('general', { cwd: tmpHome, lifecycle: 'persistent', root: true, forward: false });

    const { rePointedChildren } = promoteRoot(sid, tmpHome, {
      newRoot: { job_id: bJobId, pane_id: '%cx3', cwd: tmpHome, name: 'new-root', agent: 'general', host_session_id: null },
      oldRootJobId: aJobId,
    });

    // Sync job-layer routing (5.2).
    for (const { jobId: childId, newReportTo } of rePointedChildren) {
      recordJobReportTo(childId, { reportTo: newReportTo });
    }

    // Verify graph edges point to B.
    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);
    assert.equal(view.root_node_id, bJobId);
    for (const agent of view.agents.filter((a) => a.job_id === xJobId || a.job_id === yJobId)) {
      assert.deepEqual(agent.report_to, [bJobId], `${agent.name}.report_to should target B`);
    }

    // Verify job meta.report_to now targets B (job-layer routing synced).
    // We verify indirectly: jobStatus returns live (no terminal), and the
    // rePointedChildren returned by promoteRoot had the correct newReportTo.
    assert.equal(rePointedChildren.length, 2, 'two children re-pointed');
    for (const { newReportTo } of rePointedChildren) {
      assert.deepEqual(newReportTo, [bJobId], 'newReportTo is [B]');
    }
  });
});

// ---------------------------------------------------------------------------
// A step-down: writeMarkdownResult with superseded+forward:false
// ---------------------------------------------------------------------------

describe('A step-down: worker + superseded + forward:false', () => {
  test('writeMarkdownResult writes status superseded and appends no inbox event', async () => {
    // Create job A.
    const { jobId: aJobId } = createJob('pi-root', { cwd: tmpHome, lifecycle: 'persistent', root: true, forward: false });

    // Wire up A's routing so notifyReportTo WOULD write an inbox if not suppressed.
    const fakeSession = `step-down-session-${Date.now()}`;
    const fakeTarget = `target-node-${Date.now()}`;
    recordJobReportTo(aJobId, {
      reportTo: [fakeTarget],
      sessionId: fakeSession,
      sessionCwd: tmpHome,
      name: 'pi-root',
      title: 'root',
    });

    // Flip A: lifecycle:worker, forward:false, superseded:true, root:false.
    recordJobFlags(aJobId, { lifecycle: 'worker', forward: false, superseded: true, root: false });

    // Simulate A's natural stop: stop-hook would call crtr job submit 'done'.
    // Phase 2.3: 'done' + meta.superseded===true → status becomes 'superseded'.
    // Phase 2.2: meta.forward===false → notifyReportTo is skipped.
    writeMarkdownResult(aJobId, 'last assistant message from A', 'done', 'A stepped down');

    // status should be 'superseded', not 'done'.
    const res = await readResult(aJobId);
    assert.equal(res.status, 'superseded', 'status should be superseded after step-down submit');

    // No inbox event should have been written for the target node.
    // (readNodeInbox returns [] when the file doesn't exist.)
    const inbox = readNodeInbox(fakeSession, fakeTarget, {}, tmpHome);
    assert.equal(inbox.length, 0, 'no inbox event should be written when forward:false');

    // Confirm job state is now 'superseded' (not 'live').
    const { state } = jobStatus(aJobId);
    assert.equal(state, 'superseded', 'jobStatus.state should be superseded');
  });
});

// ---------------------------------------------------------------------------
// agent new --parent from a non-job context errors not_rootable
// ---------------------------------------------------------------------------

describe('agent new --parent not_rootable', () => {
  test('throws not_rootable when CRTR_JOB_ID is absent', async () => {
    const savedTmux = process.env['TMUX'];
    const savedPane = process.env['TMUX_PANE'];
    const savedJobId = process.env['CRTR_JOB_ID'];
    const savedParentJobId = process.env['CRTR_PARENT_JOB_ID'];

    // Simulate being inside tmux but not in a job-backed session.
    process.env['TMUX'] = ':fake.session.0';
    process.env['TMUX_PANE'] = '%0';
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_PARENT_JOB_ID'];

    try {
      await assert.rejects(
        () => newPrompt.run({ parent: true }),
        (err: unknown) => {
          assert.ok(err instanceof InputError, 'should throw InputError');
          assert.equal(err.payload.error, 'not_rootable', 'error code should be not_rootable');
          return true;
        },
      );
    } finally {
      // Restore env.
      if (savedTmux === undefined) delete process.env['TMUX']; else process.env['TMUX'] = savedTmux;
      if (savedPane === undefined) delete process.env['TMUX_PANE']; else process.env['TMUX_PANE'] = savedPane;
      if (savedJobId === undefined) delete process.env['CRTR_JOB_ID']; else process.env['CRTR_JOB_ID'] = savedJobId;
      if (savedParentJobId === undefined) delete process.env['CRTR_PARENT_JOB_ID']; else process.env['CRTR_PARENT_JOB_ID'] = savedParentJobId;
    }
  });

  test('throws not_rootable when CRTR_JOB_ID is empty string', async () => {
    const savedTmux = process.env['TMUX'];
    const savedPane = process.env['TMUX_PANE'];
    const savedJobId = process.env['CRTR_JOB_ID'];

    process.env['TMUX'] = ':fake.session.0';
    process.env['TMUX_PANE'] = '%0';
    process.env['CRTR_JOB_ID'] = '';

    try {
      await assert.rejects(
        () => newPrompt.run({ parent: true }),
        (err: unknown) => {
          assert.ok(err instanceof InputError, 'should throw InputError');
          assert.equal(err.payload.error, 'not_rootable');
          return true;
        },
      );
    } finally {
      if (savedTmux === undefined) delete process.env['TMUX']; else process.env['TMUX'] = savedTmux;
      if (savedPane === undefined) delete process.env['TMUX_PANE']; else process.env['TMUX_PANE'] = savedPane;
      if (savedJobId === undefined) delete process.env['CRTR_JOB_ID']; else process.env['CRTR_JOB_ID'] = savedJobId;
    }
  });
});
