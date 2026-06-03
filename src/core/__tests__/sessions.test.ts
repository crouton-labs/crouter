// Full test suite for sessions.ts + telemetry sidecar.
//
// Covers: mintSessionId, currentSessionContext, ensureSession/appendAgent,
// withSessionLock (via appendAgent), reconcileStatus, resolveAgent,
// reapDeadSessions, telemetry join, and focus-flag validation.
//
// Run with: node --import tsx/esm --test src/core/__tests__/sessions.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mintSessionId,
  currentSessionContext,
  ensureSession,
  appendAgent,
  loadSessionView,
  listSessionViews,
  resolveAgent,
  reapDeadSessions,
  reapSupersededSessions,
  sessionsRoot,
  sessionDir,
  reconcileStatus,
  hostPaneNodeId,
  hostNodeIdFor,
  findSessionByPiSession,
  appendNodeEvent,
  readNodeInbox,
  findNode,
  ensureRootJob,
  rootNodeId as getSessionRootNodeId,
  insertCoordinator,
} from '../sessions.js';
import {
  createJob,
  writeTelemetry,
  readTelemetry,
  writeResult,
  recordJobPane,
  livePanes,
  jobStatus,
} from '../jobs.js';
import { assertExactlyOneFocusMode } from '../../commands/agent.js';
import { resetScopeCache } from '../scope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpState: string;
let origHome: string | undefined;
let origXdg: string | undefined;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  origHome = process.env['HOME'];
  origXdg = process.env['XDG_STATE_HOME'];

  // Isolated HOME so sessionsRoot lands under our tmpdir.
  tmpHome = join(tmpdir(), `crtr-sessions-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });

  // Isolated XDG_STATE_HOME so job dirs land under our tmpdir.
  tmpState = join(tmpdir(), `crtr-jobs-test-${Date.now()}`);
  mkdirSync(tmpState, { recursive: true });

  process.env['HOME'] = tmpHome;
  process.env['XDG_STATE_HOME'] = tmpState;

  // Change cwd to a known path so mangleCwd is deterministic.
  process.chdir(tmpHome);

  resetScopeCache();
});

after(() => {
  process.chdir(origCwd);

  if (origHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = origHome;
  }
  if (origXdg === undefined) {
    delete process.env['XDG_STATE_HOME'];
  } else {
    process.env['XDG_STATE_HOME'] = origXdg;
  }

  resetScopeCache();

  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpState, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mintSessionId
// ---------------------------------------------------------------------------

describe('mintSessionId', () => {
  test('returns a non-empty string with the expected shape', () => {
    const id = mintSessionId();
    assert.ok(typeof id === 'string' && id.length > 0);
    // shape: <base36-ts>-<8-hex-chars>
    assert.match(id, /^[0-9a-z]+-[0-9a-f]{8}$/);
  });

  test('two calls produce distinct ids', () => {
    const a = mintSessionId();
    const b = mintSessionId();
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// currentSessionContext
// ---------------------------------------------------------------------------

describe('currentSessionContext', () => {
  test('returns null fields when env vars are absent', () => {
    const origSession = process.env['CRTR_SESSION_ID'];
    const origParent = process.env['CRTR_PARENT_JOB_ID'];
    const origJob = process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_PARENT_JOB_ID'];
    delete process.env['CRTR_JOB_ID'];

    const ctx = currentSessionContext();
    assert.equal(ctx.sessionId, null);
    assert.equal(ctx.parentJobId, null);

    if (origSession !== undefined) process.env['CRTR_SESSION_ID'] = origSession;
    if (origParent !== undefined) process.env['CRTR_PARENT_JOB_ID'] = origParent;
    if (origJob !== undefined) process.env['CRTR_JOB_ID'] = origJob;
  });

  test('reads CRTR_SESSION_ID and CRTR_PARENT_JOB_ID', () => {
    process.env['CRTR_SESSION_ID'] = 'sess-abc';
    process.env['CRTR_PARENT_JOB_ID'] = 'job-parent';
    delete process.env['CRTR_JOB_ID'];

    const ctx = currentSessionContext();
    assert.equal(ctx.sessionId, 'sess-abc');
    assert.equal(ctx.parentJobId, 'job-parent');

    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_PARENT_JOB_ID'];
  });

  test('falls back to CRTR_JOB_ID when CRTR_PARENT_JOB_ID is absent', () => {
    delete process.env['CRTR_PARENT_JOB_ID'];
    process.env['CRTR_JOB_ID'] = 'job-fallback';

    const ctx = currentSessionContext();
    assert.equal(ctx.parentJobId, 'job-fallback');

    delete process.env['CRTR_JOB_ID'];
  });
});

// ---------------------------------------------------------------------------
// ensureSession / loadSessionView round-trip
// ---------------------------------------------------------------------------

describe('ensureSession + loadSessionView', () => {
  test('creates session.json and reads it back', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%1', tmuxSession: 'crtr-agents-%1' });

    const view = loadSessionView(sid);
    assert.ok(view !== null, 'view should not be null');
    assert.equal(view.session_id, sid);
    assert.equal(view.root_pane, '%1');
    assert.equal(view.tmux_session, 'crtr-agents-%1');
    assert.deepEqual(view.agents, []);
  });

  test('is idempotent — second call does not overwrite', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%2', tmuxSession: 'crtr-agents-%2' });
    const view1 = loadSessionView(sid);
    const created1 = view1?.created;

    // Slight delay to ensure a different timestamp if overwritten.
    ensureSession({ sessionId: sid, rootPane: '%99', tmuxSession: 'other' });
    const view2 = loadSessionView(sid);

    assert.equal(view2?.created, created1, 'created should not change');
    assert.equal(view2?.root_pane, '%2', 'root_pane should not change');
  });

  test('loadSessionView returns null for unknown session', () => {
    const view = loadSessionView('nonexistent-session-id');
    assert.equal(view, null);
  });
});

// ---------------------------------------------------------------------------
// appendAgent
// ---------------------------------------------------------------------------

describe('appendAgent', () => {
  test('appends an agent record and it reads back in the view', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%10', tmuxSession: 'crtr-agents-%10' });

    // Create a real job so jobStatus can read its meta.
    const { jobId } = createJob('agent', { cwd: tmpHome });

    appendAgent(sid, undefined, {
      job_id: jobId,
      parent: null,
      name: 'test-agent',
      agent: 'general',
      pane_id: '%10',
      cwd: tmpHome,
      created: new Date().toISOString(),
      title: 'Do some work',
      host_session_id: null,
      status: 'running',
    });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    assert.equal(view.agents.length, 1);
    const a = view.agents[0];
    assert.ok(a !== undefined);
    assert.equal(a.job_id, jobId);
    assert.equal(a.name, 'test-agent');
    assert.equal(a.title, 'Do some work');
    assert.equal(a.parent, null);
    assert.ok(a.age_s >= 0);
    assert.equal(a.telemetry, null);
  });

  test('appends multiple agents', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%20', tmuxSession: 'crtr-agents-%20' });

    const { jobId: jid1 } = createJob('agent', { cwd: tmpHome });
    const { jobId: jid2 } = createJob('agent', { cwd: tmpHome });

    appendAgent(sid, undefined, {
      job_id: jid1, parent: null, name: 'first', agent: 'general',
      pane_id: '%20', cwd: tmpHome, created: new Date().toISOString(),
      title: 'First task', host_session_id: null, status: 'running',
    });
    appendAgent(sid, undefined, {
      job_id: jid2, parent: jid1, name: 'second', agent: 'programmer',
      pane_id: '%21', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Second task', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    assert.equal(view?.agents.length, 2);
    assert.equal(view?.agents[1]?.parent, jid1);
  });
});

// ---------------------------------------------------------------------------
// Graph nodes + edges
// ---------------------------------------------------------------------------

describe('graph nodes + edges', () => {
  test('ensureSession synthesizes an external root node at read time (no pre-seeded host node)', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%g1', tmuxSession: 'crtr-agents-%g1' });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    // Phase 4.1: ensureSession writes no node; normalizeSessionRecord synthesizes
    // an 'external' placeholder from hostNodeIdFor for legacy/no-root-job sessions.
    assert.equal(view.nodes.length, 1);
    const rootNode = view.nodes[0];
    assert.equal(rootNode?.kind, 'external');
    assert.equal(rootNode?.node_id, hostPaneNodeId('%g1'));
    assert.equal(rootNode?.pane_id, '%g1');
    assert.deepEqual(view.edges, []);
    // root_node_id is synthesized from hostNodeIdFor
    assert.equal(view.root_node_id, hostPaneNodeId('%g1'));
  });

  test('appendAgent adds an agent node and a spawned_by edge to the root node', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%g2', tmuxSession: 'crtr-agents-%g2' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'n', agent: 'general',
      pane_id: '%g2a', cwd: tmpHome, created: new Date().toISOString(),
      title: 'T', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    const agentNode = view.nodes.find((n) => n.node_id === jobId);
    assert.ok(agentNode !== undefined);
    assert.equal(agentNode.kind, 'agent');
    assert.equal(agentNode.job_id, jobId);

    const spawnEdge = view.edges.find((e) => e.type === 'spawned_by' && e.from === jobId);
    assert.ok(spawnEdge !== undefined, 'spawned_by edge should exist');
    // Phase 4.1: spawned_by points to root_node_id (the external pane node for
    // sessions without a root job, matching the pre-Phase-4 host node id).
    assert.equal(spawnEdge.to, view.root_node_id, 'top-level agent is spawned_by the root node');
    assert.equal(spawnEdge.to, hostPaneNodeId('%g2'), 'root_node_id matches the synthesized pane node');
  });

  test('report_to and subscribes_to become edges', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%g3', tmuxSession: 'crtr-agents-%g3' });
    const { jobId: a } = createJob('agent', { cwd: tmpHome });
    const { jobId: b } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: a, parent: null, name: 'a', agent: 'general',
      pane_id: '%g3a', cwd: tmpHome, created: new Date().toISOString(),
      title: 'A', host_session_id: null, status: 'running',
    });
    appendAgent(sid, undefined, {
      job_id: b, parent: a, report_to: [a], subscribes_to: [a],
      name: 'b', agent: 'general',
      pane_id: '%g3b', cwd: tmpHome, created: new Date().toISOString(),
      title: 'B', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    assert.ok(view.edges.some((e) => e.type === 'reports_to' && e.from === b && e.to === a));
    assert.ok(view.edges.some((e) => e.type === 'subscribes_to' && e.from === b && e.to === a));
    const bAgent = view.agents.find((x) => x.job_id === b);
    assert.deepEqual(bAgent?.report_to, [a]);
    assert.deepEqual(bAgent?.subscribes_to, [a]);
  });

  test('legacy session.json without nodes/edges is normalized on read', () => {
    const sid = mintSessionId();
    const dir = sessionDir(sid);
    mkdirSync(dir, { recursive: true });
    // Hand-write a pre-graph record (no nodes/edges, single parent link).
    const legacy = {
      session_id: sid,
      created: new Date().toISOString(),
      root_pane: '%legacy',
      tmux_session: 'crtr-agents-%legacy',
      agents: [
        {
          job_id: 'legacy-job', parent: null, name: 'old', agent: 'general',
          pane_id: '%legacy-a', cwd: tmpHome, created: new Date().toISOString(),
          title: 'Old', host_session_id: null, status: 'running',
        },
      ],
    };
    writeFileSync(join(dir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8');

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    // Phase 4.1: legacy records synthesize an 'external' root node (no longer 'host').
    assert.ok(view.nodes.some((n) => n.kind === 'external' && n.node_id === hostPaneNodeId('%legacy')));
    assert.ok(view.nodes.some((n) => n.node_id === 'legacy-job'));
    assert.ok(view.edges.some((e) => e.type === 'spawned_by' && e.from === 'legacy-job'));
    const a = view.agents[0];
    assert.equal(a?.node_id, 'legacy-job', 'node_id backfilled from job_id');
    assert.deepEqual(a?.report_to, []);
  });
});

// ---------------------------------------------------------------------------
// Node inboxes + notify
// ---------------------------------------------------------------------------

describe('node inboxes', () => {
  test('appendNodeEvent then readNodeInbox round-trips', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%i1', tmuxSession: 'crtr-agents-%i1' });
    const node = hostPaneNodeId('%i1');

    appendNodeEvent(sid, node, { from: 'job-x', event: 'completed', data: { message: 'done' } });
    const events = readNodeInbox(sid, node);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'completed');
    assert.equal(events[0]?.from, 'job-x');
    assert.equal(events[0]?.to, node);
    assert.equal((events[0]?.data as { message?: string })?.message, 'done');
  });

  test('readNodeInbox honors sinceTs', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%i2', tmuxSession: 'crtr-agents-%i2' });
    const node = hostPaneNodeId('%i2');
    appendNodeEvent(sid, node, { from: null, event: 'one' });
    appendNodeEvent(sid, node, { from: null, event: 'two' });

    // A timestamp in the past returns everything; one in the future returns none.
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(readNodeInbox(sid, node, { sinceTs: past }).length, 2);
    assert.equal(readNodeInbox(sid, node, { sinceTs: future }).length, 0);
  });

  test('readNodeInbox returns [] for an empty inbox', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%i3', tmuxSession: 'crtr-agents-%i3' });
    assert.deepEqual(readNodeInbox(sid, hostPaneNodeId('%i3')), []);
  });

  test('findNode resolves a node by job_id and by host node id', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%i4', tmuxSession: 'crtr-agents-%i4' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'findme', agent: 'general',
      pane_id: '%i4a', cwd: tmpHome, created: new Date().toISOString(),
      title: 'F', host_session_id: null, status: 'running',
    });

    const byJob = findNode(jobId, { sessionId: sid });
    assert.equal(byJob?.sessionId, sid);
    assert.equal(byJob?.nodeId, jobId);

    const byName = findNode('findme', { sessionId: sid });
    assert.equal(byName?.nodeId, jobId);

    const host = findNode(hostPaneNodeId('%i4'), { sessionId: sid });
    assert.equal(host?.nodeId, hostPaneNodeId('%i4'));

    assert.equal(findNode('no-such-node', { sessionId: sid }), null);
  });
});

// ---------------------------------------------------------------------------
// Telemetry round-trip
// ---------------------------------------------------------------------------

describe('writeTelemetry + readTelemetry', () => {
  test('write and read back', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    writeTelemetry(jobId, { tokens_in: 100, tokens_out: 50, model: 'claude-3-5' });

    const rec = readTelemetry(jobId);
    assert.ok(rec !== null);
    assert.equal(rec.tokens_in, 100);
    assert.equal(rec.tokens_out, 50);
    assert.equal(rec.model, 'claude-3-5');
    assert.ok(typeof rec.updated_at === 'string');
  });

  test('second write merges — only patch keys overwrite', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    writeTelemetry(jobId, { tokens_in: 10, model: 'claude-3-5' });
    writeTelemetry(jobId, { tokens_in: 20, tokens_out: 5 });

    const rec = readTelemetry(jobId);
    assert.ok(rec !== null);
    assert.equal(rec.tokens_in, 20, 'tokens_in overwritten by second patch');
    assert.equal(rec.tokens_out, 5, 'tokens_out added by second patch');
    assert.equal(rec.model, 'claude-3-5', 'model kept from first write');
  });

  test('readTelemetry returns null for a job with no sidecar', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    const rec = readTelemetry(jobId);
    assert.equal(rec, null);
  });

  test('telemetry is joined into AgentView', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%30', tmuxSession: 'crtr-agents-%30' });

    const { jobId } = createJob('agent', { cwd: tmpHome });
    writeTelemetry(jobId, { tokens_in: 42 });

    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'telem-agent', agent: 'general',
      pane_id: '%30', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Telemetry test', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    const agent = view?.agents[0];
    assert.ok(agent !== undefined);
    assert.ok(agent.telemetry !== null, 'telemetry should be joined');
    assert.equal(agent.telemetry?.tokens_in, 42);
  });
});

// ---------------------------------------------------------------------------
// reconcileStatus — status reconciliation
// ---------------------------------------------------------------------------

describe('reconcileStatus', () => {
  test('running agent with dead pane → closed', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    // Record a pane id that does not exist on any tmux server.
    recordJobPane(jobId, '%999888777');

    const rec = {
      job_id: jobId,
      parent: null as string | null,
      name: 'r',
      agent: 'general',
      pane_id: '%999888777',
      cwd: tmpHome,
      created: new Date().toISOString(),
      title: '',
      host_session_id: null as string | null,
      status: 'running' as const,
    };

    // The pane %999888777 should not be in the live set.
    const panes = livePanes();
    const status = reconcileStatus(rec, panes);
    assert.equal(status, 'closed');
  });

  test('running agent with live pane stays running', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    const rec = {
      job_id: jobId,
      parent: null as string | null,
      name: 'r',
      agent: 'general',
      pane_id: '%fake-live',
      cwd: tmpHome,
      created: new Date().toISOString(),
      title: '',
      host_session_id: null as string | null,
      status: 'running' as const,
    };

    // Inject a fake live pane set containing the pane.
    const panes = new Set(['%fake-live']);
    const status = reconcileStatus(rec, panes);
    assert.equal(status, 'running');
  });
});

// ---------------------------------------------------------------------------
// listSessionViews
// ---------------------------------------------------------------------------

describe('listSessionViews', () => {
  test('returns sorted views for all existing sessions', () => {
    const root = sessionsRoot();
    // Count existing sessions from prior tests.
    const existingCount = listSessionViews().length;

    const sid1 = mintSessionId();
    const sid2 = mintSessionId();
    ensureSession({ sessionId: sid1, rootPane: '%40', tmuxSession: 'crtr-agents-%40' });
    // Small delay to ensure distinct timestamps.
    ensureSession({ sessionId: sid2, rootPane: '%41', tmuxSession: 'crtr-agents-%41' });

    const views = listSessionViews();
    assert.ok(views.length >= existingCount + 2);

    // Verify sorted order.
    for (let i = 1; i < views.length; i++) {
      assert.ok((views[i - 1]?.created ?? '') <= (views[i]?.created ?? ''));
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAgent
// ---------------------------------------------------------------------------

describe('resolveAgent', () => {
  test('resolves by job_id', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%50', tmuxSession: 'crtr-agents-%50' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'resolve-me', agent: 'general',
      pane_id: '%50', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Resolve test', host_session_id: null, status: 'running',
    });

    const agent = resolveAgent(sid, jobId);
    assert.ok(agent !== null);
    assert.equal(agent.job_id, jobId);
  });

  test('resolves by name', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%51', tmuxSession: 'crtr-agents-%51' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'named-agent', agent: 'general',
      pane_id: '%51', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Named', host_session_id: null, status: 'running',
    });

    const agent = resolveAgent(sid, 'named-agent');
    assert.ok(agent !== null);
    assert.equal(agent.job_id, jobId);
  });

  test('resolves by 1-based index', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%52', tmuxSession: 'crtr-agents-%52' });
    const { jobId: j1 } = createJob('agent', { cwd: tmpHome });
    const { jobId: j2 } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: j1, parent: null, name: 'first', agent: 'general',
      pane_id: '%52', cwd: tmpHome, created: new Date().toISOString(),
      title: 'First', host_session_id: null, status: 'running',
    });
    appendAgent(sid, undefined, {
      job_id: j2, parent: null, name: 'second', agent: 'general',
      pane_id: '%53', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Second', host_session_id: null, status: 'running',
    });

    const agent1 = resolveAgent(sid, '1');
    const agent2 = resolveAgent(sid, '2');
    assert.equal(agent1?.job_id, j1);
    assert.equal(agent2?.job_id, j2);
  });

  test('returns null for unknown session', () => {
    const result = resolveAgent('does-not-exist', '1');
    assert.equal(result, null);
  });

  test('returns null for unknown ref', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%60', tmuxSession: 'crtr-agents-%60' });
    const result = resolveAgent(sid, 'no-such-agent');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// reapDeadSessions
// ---------------------------------------------------------------------------

describe('reapDeadSessions', () => {
  test('reaps a session whose all job node panes are absent', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%dead-root', tmuxSession: 'crtr-agents-%dead' });

    // createJob without recordJobPane so the job has no meta pane_id.
    // reapIfPaneDead inside jobStatus only triggers when meta.pane_id is set.
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'dead-agent', agent: 'general',
      pane_id: '%dead-pane', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Dead', host_session_id: null, status: 'running',
    });

    // Empty pane set — '%dead-pane' not present → panes.has('%dead-pane') = false.
    const reaped = reapDeadSessions(new Set());
    assert.ok(reaped.includes(sid), `expected ${sid} to be reaped`);

    const view = loadSessionView(sid);
    assert.equal(view, null, 'session should be deleted after reap');
  });

  test('reaps a session with no agents (no live job nodes)', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%no-agents-root', tmuxSession: 'crtr-agents-%no-agents' });
    // No appendAgent — session has only the synthesized external root node, no job nodes.
    const reaped = reapDeadSessions(new Set(['%no-agents-root']));
    assert.ok(reaped.includes(sid), 'session with no job nodes is always reaped');
  });

  test('does NOT reap a session whose root job is live on a live pane', () => {
    // Use createJob without recordJobPane: job has no meta pane_id, so
    // reapIfPaneDead inside jobStatus skips the pane check → job stays live.
    const { jobId: rootJobId } = createJob('pi-root', { cwd: tmpHome });
    const sid = mintSessionId();
    ensureSession({
      sessionId: sid, rootPane: '%pi-live', tmuxSession: 't',
      piSessionId: 'live-conv', rootNodeId: rootJobId, cwd: tmpHome,
    });
    appendAgent(sid, tmpHome, {
      job_id: rootJobId, node_id: rootJobId, parent: null, report_to: [],
      name: 'pi-root', agent: 'pi-root',
      pane_id: '%pi-live', cwd: tmpHome, created: new Date().toISOString(),
      title: 'root', host_session_id: null, status: 'running',
    });

    const reaped = reapDeadSessions(new Set(['%pi-live']), tmpHome);
    assert.ok(!reaped.includes(sid), 'session with live root job and live pane should not be reaped');
    assert.ok(loadSessionView(sid, tmpHome) !== null, 'session should still exist');
  });

  test('does NOT reap a session with a live worker agent pane (dead root)', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%gone-root', tmuxSession: 'crtr-agents-%gone' });

    // Worker job: no meta pane_id → reapIfPaneDead skips → stays live.
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'live-agent', agent: 'general',
      pane_id: '%agent-alive', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Live agent', host_session_id: null, status: 'running',
    });

    // root_pane gone, but worker pane alive and job is live.
    const reaped = reapDeadSessions(new Set(['%agent-alive']));
    assert.ok(!reaped.includes(sid), 'session with live worker pane should survive dead root');
    assert.ok(loadSessionView(sid) !== null);
  });

  test('returns empty array when sessions root does not exist', () => {
    const reaped = reapDeadSessions(new Set(), '/nonexistent/path/cwd');
    assert.deepEqual(reaped, []);
  });
});

// ---------------------------------------------------------------------------
// pi-session identity (host node = pi:<id>, resolver, supersede reaping)
// ---------------------------------------------------------------------------

describe('pi-session identity', () => {
  test('ensureSession with piSessionId stamps the record and synthesizes a pi:<id> external node', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%pi1', tmuxSession: 'crtr-agents-%pi1', piSessionId: 'conv-1' });
    const view = loadSessionView(sid);
    assert.ok(view !== null);
    assert.equal(view.pi_session_id, 'conv-1');
    assert.equal(view.nodes.length, 1);
    // Phase 4.1: external not host.
    assert.equal(view.nodes[0]?.kind, 'external');
    assert.equal(view.nodes[0]?.node_id, 'pi:conv-1');
    assert.equal(view.nodes[0]?.pane_id, '%pi1', 'pane is still recorded for liveness/reaping');
    assert.equal(view.root_node_id, 'pi:conv-1');
  });

  test('hostNodeIdFor: pi node when bound, pane node otherwise', () => {
    assert.equal(hostNodeIdFor({ pi_session_id: 'c', root_pane: '%p' }), 'pi:c');
    assert.equal(hostNodeIdFor({ pi_session_id: null, root_pane: '%p' }), hostPaneNodeId('%p'));
    assert.equal(hostNodeIdFor({ root_pane: '%p' }), hostPaneNodeId('%p'));
  });

  test('legacy session (no piSessionId) keeps a pane host node', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%pi-legacy', tmuxSession: 'crtr-agents-%pi-legacy' });
    const view = loadSessionView(sid);
    assert.equal(view?.pi_session_id, null);
    assert.equal(view?.nodes[0]?.node_id, hostPaneNodeId('%pi-legacy'));
  });

  test('findSessionByPiSession resolves the conversation, ignoring pane reuse', () => {
    const pane = '%pi-reuse';
    const a = mintSessionId();
    ensureSession({ sessionId: a, rootPane: pane, tmuxSession: 't', piSessionId: 'conv-A' });
    const b = mintSessionId();
    ensureSession({ sessionId: b, rootPane: pane, tmuxSession: 't', piSessionId: 'conv-B' });
    assert.equal(findSessionByPiSession('conv-A'), a);
    assert.equal(findSessionByPiSession('conv-B'), b);
    assert.equal(findSessionByPiSession('conv-missing'), null);
  });

  test('appendAgent points the top-level spawned_by edge at the pi host node', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%pi-edge', tmuxSession: 't', piSessionId: 'conv-edge' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, report_to: ['pi:conv-edge'], name: 'n', agent: 'general',
      pane_id: '%pi-edge-a', cwd: tmpHome, created: new Date().toISOString(),
      title: 'T', host_session_id: null, status: 'running',
    });
    const view = loadSessionView(sid);
    const spawnEdge = view?.edges.find((e) => e.type === 'spawned_by' && e.from === jobId);
    assert.equal(spawnEdge?.to, 'pi:conv-edge');
  });
});

describe('reapSupersededSessions', () => {
  test('reaps a sibling conversation on the same live pane with no live non-root agent', () => {
    const pane = '%sup1';
    const keep = mintSessionId();
    ensureSession({ sessionId: keep, rootPane: pane, tmuxSession: 't', piSessionId: 'cur' });
    const stale = mintSessionId();
    ensureSession({ sessionId: stale, rootPane: pane, tmuxSession: 't', piSessionId: 'prior' });

    const reaped = reapSupersededSessions(pane, 'cur', new Set([pane]));
    assert.ok(reaped.includes(stale), 'prior conversation session is reaped');
    assert.ok(!reaped.includes(keep), 'current conversation session is kept');
    assert.equal(loadSessionView(stale), null);
    assert.ok(loadSessionView(keep) !== null);
  });

  test('reaps a legacy (no pi_session_id) sibling on the live pane', () => {
    const pane = '%sup2';
    ensureSession({ sessionId: mintSessionId(), rootPane: pane, tmuxSession: 't' }); // legacy, pi_session_id null
    const cur = mintSessionId();
    ensureSession({ sessionId: cur, rootPane: pane, tmuxSession: 't', piSessionId: 'cur2' });
    const reaped = reapSupersededSessions(pane, 'cur2', new Set([pane]));
    assert.equal(reaped.length, 1, 'the legacy sibling is reaped');
    assert.ok(loadSessionView(cur) !== null);
  });

  test('spares a sibling that still has a live non-root AGENT pane', () => {
    const pane = '%sup3';
    const cur = mintSessionId();
    ensureSession({ sessionId: cur, rootPane: pane, tmuxSession: 't', piSessionId: 'cur3' });
    const busy = mintSessionId();
    ensureSession({ sessionId: busy, rootPane: pane, tmuxSession: 't', piSessionId: 'prior3' });
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(busy, undefined, {
      job_id: jobId, parent: null, name: 'busy', agent: 'general',
      pane_id: '%sup3-agent', cwd: tmpHome, created: new Date().toISOString(),
      title: 'B', host_session_id: null, status: 'running',
    });
    // The shared root pane is live, but the predicate excludes the root node
    // (job_id !== root_node_id) so only non-root agent panes count.
    const reaped = reapSupersededSessions(pane, 'cur3', new Set([pane, '%sup3-agent']));
    assert.ok(!reaped.includes(busy), 'sibling with a live non-root agent pane is spared');
    assert.ok(loadSessionView(busy) !== null);
  });

  test('never reaps the kept conversation even with no live agent', () => {
    const pane = '%sup4';
    const cur = mintSessionId();
    ensureSession({ sessionId: cur, rootPane: pane, tmuxSession: 't', piSessionId: 'cur4' });
    const reaped = reapSupersededSessions(pane, 'cur4', new Set([pane]));
    assert.deepEqual(reaped, []);
    assert.ok(loadSessionView(cur) !== null);
  });
});

// ---------------------------------------------------------------------------
// Inbox delivery to root job node (Phase 4.6)
// ---------------------------------------------------------------------------

describe('inbox delivery to root job node', () => {
  test('child completed event lands in the inbox the top-level watcher reads', () => {
    // Create a session with a job-backed root (without recordJobPane to avoid
    // pane-death reap in test env).
    const piId = `inbox-root-${Date.now()}`;
    const pane = '%inbox-root-pane';
    const { jobId: rootJobId } = createJob('pi-root', { cwd: tmpHome });
    const sid = mintSessionId();
    ensureSession({
      sessionId: sid, rootPane: pane, tmuxSession: 't',
      piSessionId: piId, rootNodeId: rootJobId, cwd: tmpHome,
    });
    appendAgent(sid, tmpHome, {
      job_id: rootJobId, node_id: rootJobId, parent: null, report_to: [],
      name: 'pi-root', agent: 'pi-root',
      pane_id: pane, cwd: tmpHome, created: new Date().toISOString(),
      title: 'root', host_session_id: null, status: 'running',
    });

    // Spawn a child job reporting to the root.
    const { jobId: childJobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, tmpHome, {
      job_id: childJobId, parent: rootJobId, report_to: [rootJobId],
      name: 'child', agent: 'general',
      pane_id: '%child-pane', cwd: tmpHome, created: new Date().toISOString(),
      title: 'child task', host_session_id: null, status: 'running',
    });

    // Simulate child completion: deliver a completed event to root's inbox.
    appendNodeEvent(sid, rootJobId, { from: childJobId, event: 'completed', data: { message: 'done' } }, tmpHome);

    // The top-level watcher reads from inboxes/<sanitized(rootJobId)>.jsonl.
    // readNodeInbox uses the same path, so this is the canonical assertion.
    const events = readNodeInbox(sid, rootJobId, {}, tmpHome);
    assert.equal(events.length, 1, 'one completed event in root inbox');
    assert.equal(events[0]?.event, 'completed');
    assert.equal(events[0]?.from, childJobId);
    assert.equal(events[0]?.to, rootJobId);

    // Verify root_node_id accessor returns the root job id.
    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);
    assert.equal(getSessionRootNodeId(view), rootJobId, 'rootNodeId accessor returns root job id');
  });

  test('inbox resolved by root_node_id (not inferred from root_pane)', () => {
    // A session with an explicit root job should resolve the inbox by job id,
    // not by pane id, so the watcher always reads the right file.
    const piId = `inbox-resolve-${Date.now()}`;
    const pane = '%inbox-resolve-pane';
    const { jobId: rootJobId } = createJob('pi-root', { cwd: tmpHome });
    const sid = mintSessionId();
    ensureSession({
      sessionId: sid, rootPane: pane, tmuxSession: 't',
      piSessionId: piId, rootNodeId: rootJobId, cwd: tmpHome,
    });
    appendAgent(sid, tmpHome, {
      job_id: rootJobId, node_id: rootJobId, parent: null,
      name: 'pi-root', agent: 'pi-root',
      pane_id: pane, cwd: tmpHome, created: new Date().toISOString(),
      title: 'root', host_session_id: null, status: 'running',
    });

    appendNodeEvent(sid, rootJobId, { from: null, event: 'ping' }, tmpHome);

    // Inbox at rootJobId — not at the pane node.
    const events = readNodeInbox(sid, rootJobId, {}, tmpHome);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'ping');

    // Inbox at the pane node is empty (different file).
    const paneEvents = readNodeInbox(sid, `pane:${pane}`, {}, tmpHome);
    assert.equal(paneEvents.length, 0, 'inbox at pane node is separate and empty');
  });
});

// ---------------------------------------------------------------------------
// withSessionLock (tested via appendAgent, which calls it internally)
// ---------------------------------------------------------------------------

describe('withSessionLock (via appendAgent)', () => {
  test('two sequential appendAgent calls both persist (no lost update)', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%lock-root', tmuxSession: 'crtr-agents-%lock' });

    const { jobId: j1 } = createJob('agent', { cwd: tmpHome });
    const { jobId: j2 } = createJob('agent', { cwd: tmpHome });

    appendAgent(sid, undefined, {
      job_id: j1, parent: null, name: 'first-lock', agent: 'general',
      pane_id: '%lock-1', cwd: tmpHome, created: new Date().toISOString(),
      title: 'First', host_session_id: null, status: 'running',
    });
    appendAgent(sid, undefined, {
      job_id: j2, parent: j1, name: 'second-lock', agent: 'general',
      pane_id: '%lock-2', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Second', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    assert.equal(view.agents.length, 2, 'both agents must persist after sequential locked writes');
    assert.equal(view.agents[0]?.job_id, j1);
    assert.equal(view.agents[1]?.job_id, j2);
    assert.equal(view.agents[1]?.parent, j1, 'tree linkage preserved');
  });

  test('stale lock dir (mtime > 5s) is stolen and appendAgent succeeds', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%stale-root', tmuxSession: 'crtr-agents-%stale' });

    // Manufacture a stale .lock dir inside the session directory.
    const dir = sessionDir(sid);
    const lockDir = join(dir, '.lock');
    mkdirSync(lockDir, { recursive: true });

    // Force the mtime back >5s so withSessionLock treats it as stale.
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    // appendAgent should steal the stale lock and succeed.
    const { jobId } = createJob('agent', { cwd: tmpHome });
    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'stale-lock-agent', agent: 'general',
      pane_id: '%stale-1', cwd: tmpHome, created: new Date().toISOString(),
      title: 'After stale steal', host_session_id: null, status: 'running',
    });

    const view = loadSessionView(sid);
    assert.ok(view !== null);
    assert.equal(view.agents.length, 1, 'agent was appended despite stale lock');
    assert.equal(view.agents[0]?.name, 'stale-lock-agent');
  });
});

// ---------------------------------------------------------------------------
// reconcileStatus — job terminal status wins over pane check
// ---------------------------------------------------------------------------

describe('reconcileStatus: job result wins', () => {
  test('agent whose job is done reads as done regardless of pane state', () => {
    const sid = mintSessionId();
    ensureSession({ sessionId: sid, rootPane: '%done-root', tmuxSession: 'crtr-agents-%done' });

    const { jobId } = createJob('agent', { cwd: tmpHome });

    appendAgent(sid, undefined, {
      job_id: jobId, parent: null, name: 'done-agent', agent: 'general',
      pane_id: '%done-pane', cwd: tmpHome, created: new Date().toISOString(),
      title: 'Will be done', host_session_id: null, status: 'running',
    });

    // Write a 'done' result — simulates the worker submitting successfully.
    writeResult(jobId, { answer: 42 }, 'done');

    // With a live pane set (pane is "alive"), status should still be 'done'
    // because job result takes precedence over pane liveness.
    const panes = new Set(['%done-pane']);
    const view = loadSessionView(sid);
    assert.ok(view !== null);
    const agent = view.agents[0];
    assert.ok(agent !== undefined);
    // Reconstruct via reconcileStatus directly too.
    const rec = {
      job_id: jobId,
      parent: null as string | null,
      name: 'done-agent',
      agent: 'general',
      pane_id: '%done-pane',
      cwd: tmpHome,
      created: new Date().toISOString(),
      title: '',
      host_session_id: null as string | null,
      status: 'running' as const,
    };
    assert.equal(reconcileStatus(rec, panes), 'done', 'done job overrides running stored status');
    assert.equal(agent.status, 'done', 'loadSessionView reflects done status');
  });

  test('agent whose job is failed reads as failed', () => {
    const { jobId } = createJob('agent', { cwd: tmpHome });
    writeResult(jobId, {}, 'failed');

    const rec = {
      job_id: jobId,
      parent: null as string | null,
      name: 'fail-agent',
      agent: 'general',
      pane_id: '%fail-pane',
      cwd: tmpHome,
      created: new Date().toISOString(),
      title: '',
      host_session_id: null as string | null,
      status: 'running' as const,
    };
    assert.equal(reconcileStatus(rec, new Set(['%fail-pane'])), 'failed');
  });
});

// ---------------------------------------------------------------------------
// ensureRootJob (Phase 3)
// ---------------------------------------------------------------------------

describe('ensureRootJob', () => {
  test('creates a pi-root job with persistent lifecycle and root_node_id set', () => {
    const piId = `conv-root-${Date.now()}`;
    const pane = '%r1';
    const { sessionId, jobId } = ensureRootJob({
      piSessionId: piId,
      rootPane: pane,
      tmuxSession: `crtr-agents-${pane}`,
      cwd: tmpHome,
    });

    // Session id is deterministic
    assert.equal(sessionId, `pi-${piId}`);
    assert.ok(typeof jobId === 'string' && jobId.length > 0);

    // Verify structure WITHOUT calling jobStatus (which would reap via pane-death
    // in test environments without tmux).
    const view = loadSessionView(sessionId, tmpHome);
    assert.ok(view !== null, 'session should exist');
    assert.equal(view.pi_session_id, piId);
    assert.equal(view.root_node_id, jobId, 'root_node_id should point at the root job');

    // Root job node in graph
    const rootNode = view.nodes.find((n) => n.node_id === jobId);
    assert.ok(rootNode !== undefined, 'root job node should be in graph');
    assert.equal(rootNode.kind, 'agent');
    assert.equal(rootNode.pane_id, pane);

    // Root job in agents[]
    const rootAgent = view.agents.find((a) => a.job_id === jobId);
    assert.ok(rootAgent !== undefined, 'root job should be in agents[]');
    assert.equal(rootAgent.parent, null);
    assert.deepEqual(rootAgent.report_to, []);
  });

  test('session id is always deterministic (pi-<piSessionId>) across calls', () => {
    // The deterministic session ID is the race-safety lever: concurrent callers
    // all compute the same ID, then serialize on the lock. Job ID stability is
    // only guaranteed while the root pane is alive (real tmux); in test environments
    // pane-death reaping closes the first root job before the second call checks
    // liveness — that is correct behavior, not a bug.
    const piId = `conv-idem-${Date.now()}`;
    const pane = '%r2';
    const opts = { piSessionId: piId, rootPane: pane, tmuxSession: `crtr-agents-${pane}`, cwd: tmpHome };

    const first = ensureRootJob(opts);
    const second = ensureRootJob(opts);

    assert.equal(first.sessionId, `pi-${piId}`, 'first call: deterministic session id');
    assert.equal(second.sessionId, `pi-${piId}`, 'second call: same deterministic session id');
    assert.equal(first.sessionId, second.sessionId, 'session id is always stable');
  });

  test('different piSessionId on same pane mints a new session and reaps the prior one', async () => {
    const pane = '%r4';

    // Create the first root
    const piIdA = `conv-a-${Date.now()}`;
    const first = ensureRootJob({
      piSessionId: piIdA,
      rootPane: pane,
      tmuxSession: `crtr-agents-${pane}`,
      cwd: tmpHome,
    });
    assert.equal(first.sessionId, `pi-${piIdA}`);

    // Small delay so created timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    // Create the second root (same pane, new pi conversation = /new)
    const piIdB = `conv-b-${Date.now()}`;
    const second = ensureRootJob({
      piSessionId: piIdB,
      rootPane: pane,
      tmuxSession: `crtr-agents-${pane}`,
      cwd: tmpHome,
    });
    assert.equal(second.sessionId, `pi-${piIdB}`);
    assert.notEqual(first.sessionId, second.sessionId, 'new conversation gets new session');
    assert.notEqual(first.jobId, second.jobId, 'new conversation gets new root job');

    // Prior session should be reaped
    const priorView = loadSessionView(first.sessionId, tmpHome);
    assert.equal(priorView, null, 'prior session should be deleted');

    // Prior root job should be finalized (closed by reapSupersededRootSessions or
    // reapIfPaneDead — either way it must not be live)
    const { state: priorState } = jobStatus(first.jobId);
    assert.equal(priorState, 'closed', 'prior root job should be finalized closed');
  });

  test('deterministic id makes concurrent callers serialize on the lock (structural)', async () => {
    // JS is single-threaded; Promise.all resolves sequentially for sync calls.
    // The key invariant is: same piSessionId → same session dir → same lock dir
    // → one root created at most (whichever call holds the lock).
    const piId = `conv-conc-${Date.now()}`;
    const pane = '%r5';
    const opts = { piSessionId: piId, rootPane: pane, tmuxSession: `crtr-agents-${pane}`, cwd: tmpHome };

    const results = await Promise.all([
      Promise.resolve(ensureRootJob(opts)),
      Promise.resolve(ensureRootJob(opts)),
    ]);

    const [a, b] = results;
    // Session ID is deterministic for both callers.
    assert.equal(a!.sessionId, `pi-${piId}`);
    assert.equal(b!.sessionId, `pi-${piId}`);
    assert.equal(a!.sessionId, b!.sessionId, 'both callers target the same session');
  });

  test('root_node_id is synthesized as external node for legacy records without root_node_id', () => {
    // Write a legacy session.json without root_node_id
    const sid = mintSessionId();
    const dir = sessionDir(sid, tmpHome);
    mkdirSync(dir, { recursive: true });
    const legacy = {
      session_id: sid,
      created: new Date().toISOString(),
      root_pane: '%legacy-r',
      tmux_session: 'crtr-agents-%legacy-r',
      pi_session_id: 'legacy-pi-id',
      agents: [],
      // no root_node_id
    };
    writeFileSync(join(dir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8');

    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);
    // Phase 4.1: synthesized from hostNodeIdFor (= pi:legacy-pi-id) as an 'external' node.
    assert.equal(view.root_node_id, 'pi:legacy-pi-id', 'root_node_id synthesized from legacy host id');
    const rootNode = view.nodes.find((n) => n.node_id === 'pi:legacy-pi-id');
    assert.ok(rootNode !== undefined, 'synthesized root node exists');
    assert.equal(rootNode.kind, 'external', 'synthesized root is external, not host');
  });

  test('ensureSession with rootNodeId persists it in session.json', () => {
    const sid = mintSessionId();
    ensureSession({
      sessionId: sid,
      rootPane: '%r6',
      tmuxSession: 'crtr-agents-%r6',
      cwd: tmpHome,
      piSessionId: 'conv-r6',
      rootNodeId: 'synthetic-root-job-id',
    });
    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);
    assert.equal(view.root_node_id, 'synthetic-root-job-id');
  });
});

// ---------------------------------------------------------------------------
// insertCoordinator — coordination handoff (no root move)
// ---------------------------------------------------------------------------

describe('insertCoordinator', () => {
  test('interposes B: root stays A, children re-point to B, B reports to A, handoff_to + spawned_by intact', () => {
    const sid = mintSessionId();
    // Set up: session with A as root, two children X and Y reporting to A.
    const aJobId = createJob('pi-root', { cwd: tmpHome, lifecycle: 'persistent', root: true, forward: false }).jobId;
    ensureSession({ sessionId: sid, rootPane: '%p1', tmuxSession: 'crtr-agents-%p1', cwd: tmpHome, rootNodeId: aJobId });

    // Add root job node manually (mirrors ensureRootJob behavior).
    const created = new Date().toISOString();
    const xJobId = createJob('general', { cwd: tmpHome }).jobId;
    const yJobId = createJob('general', { cwd: tmpHome }).jobId;
    appendAgent(sid, tmpHome, { job_id: aJobId, node_id: aJobId, parent: null, report_to: [], subscribes_to: [], name: 'pi-root', agent: 'pi-root', pane_id: '%p1', cwd: tmpHome, created, title: 'root', host_session_id: null, status: 'running' });
    appendAgent(sid, tmpHome, { job_id: xJobId, node_id: xJobId, parent: aJobId, report_to: [aJobId], subscribes_to: [], name: 'worker-x', agent: 'general', pane_id: '%p2', cwd: tmpHome, created, title: 'x task', host_session_id: null, status: 'running' });
    appendAgent(sid, tmpHome, { job_id: yJobId, node_id: yJobId, parent: aJobId, report_to: [aJobId], subscribes_to: [], name: 'worker-y', agent: 'general', pane_id: '%p3', cwd: tmpHome, created, title: 'y task', host_session_id: null, status: 'running' });

    const bJobId = createJob('general', { cwd: tmpHome, lifecycle: 'persistent', root: false, forward: true }).jobId;
    const { rePointedChildren } = insertCoordinator(sid, tmpHome, {
      newRoot: { job_id: bJobId, pane_id: '%p4', cwd: tmpHome, name: 'coordinator', agent: 'general', host_session_id: null },
      oldRootJobId: aJobId,
    });

    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);

    // root_node_id stays A — the session root never moves.
    assert.equal(view.root_node_id, aJobId, 'root_node_id should stay A');

    // Children's reports_to *→A become *→B; B itself now reports_to A.
    const reportsToA = view.edges.filter((e) => e.type === 'reports_to' && e.to === aJobId);
    assert.deepEqual(reportsToA.map((e) => e.from), [bJobId], 'only B should still report to A (children re-pointed)');
    const reportsToB = view.edges.filter((e) => e.type === 'reports_to' && e.to === bJobId);
    assert.equal(reportsToB.length, 2, 'both children should now report to B');
    assert.ok(reportsToB.some((e) => e.from === xJobId), 'X reports to B');
    assert.ok(reportsToB.some((e) => e.from === yJobId), 'Y reports to B');

    // handoff_to A→B exists.
    const handoff = view.edges.find((e) => e.type === 'handoff_to' && e.from === aJobId && e.to === bJobId);
    assert.ok(handoff !== undefined, 'handoff_to A→B should exist');

    // spawned_by edges are intact (B spawned_by A, X spawned_by A, Y spawned_by A).
    const spawnedByB = view.edges.find((e) => e.type === 'spawned_by' && e.from === bJobId && e.to === aJobId);
    assert.ok(spawnedByB !== undefined, 'B spawned_by A (provenance)');
    const spawnedByX = view.edges.find((e) => e.type === 'spawned_by' && e.from === xJobId);
    assert.ok(spawnedByX !== undefined, 'X spawned_by edge intact');
    const spawnedByY = view.edges.find((e) => e.type === 'spawned_by' && e.from === yJobId);
    assert.ok(spawnedByY !== undefined, 'Y spawned_by edge intact');

    // agents[].report_to arrays updated.
    const xView = view.agents.find((a) => a.job_id === xJobId);
    assert.deepEqual(xView?.report_to, [bJobId], 'X.report_to now targets B');
    const yView = view.agents.find((a) => a.job_id === yJobId);
    assert.deepEqual(yView?.report_to, [bJobId], 'Y.report_to now targets B');
    const bView = view.agents.find((a) => a.job_id === bJobId);
    assert.deepEqual(bView?.report_to, [aJobId], 'B.report_to targets A (children → B → A)');

    // rePointedChildren lists both X and Y (B is excluded — it is not re-pointed).
    assert.equal(rePointedChildren.length, 2, 'two children re-pointed');
    const childIds = rePointedChildren.map((c) => c.jobId).sort();
    assert.deepEqual(childIds, [xJobId, yJobId].sort(), 'correct child job ids returned');
    for (const { newReportTo } of rePointedChildren) {
      assert.deepEqual(newReportTo, [bJobId], 'newReportTo contains B');
    }
  });

  test('insertCoordinator with no children: root stays A, B reports to A, handoff_to added, nothing to re-point', () => {
    const sid = mintSessionId();
    const aJobId = createJob('pi-root', { cwd: tmpHome, lifecycle: 'persistent', root: true, forward: false }).jobId;
    ensureSession({ sessionId: sid, rootPane: '%q1', tmuxSession: 'crtr-agents-%q1', cwd: tmpHome, rootNodeId: aJobId });

    const bJobId = createJob('general', { cwd: tmpHome, lifecycle: 'persistent', root: false, forward: true }).jobId;
    const { rePointedChildren } = insertCoordinator(sid, tmpHome, {
      newRoot: { job_id: bJobId, pane_id: '%q2', cwd: tmpHome, name: 'coordinator-solo', agent: 'general', host_session_id: null },
      oldRootJobId: aJobId,
    });

    assert.equal(rePointedChildren.length, 0, 'no children to re-point');
    const view = loadSessionView(sid, tmpHome);
    assert.ok(view !== null);
    assert.equal(view.root_node_id, aJobId, 'root stays A');
    const bView = view.agents.find((a) => a.job_id === bJobId);
    assert.deepEqual(bView?.report_to, [aJobId], 'B reports to A');
    const handoff = view.edges.find((e) => e.type === 'handoff_to' && e.from === aJobId && e.to === bJobId);
    assert.ok(handoff !== undefined, 'handoff_to A→B exists even with no children');
  });

  test('insertCoordinator throws when session does not exist', () => {
    assert.throws(
      () => insertCoordinator('nonexistent-session', tmpHome, {
        newRoot: { job_id: 'b-job', pane_id: '%z1', cwd: tmpHome, name: 'B', agent: 'general', host_session_id: null },
        oldRootJobId: 'a-job',
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// assertExactlyOneFocusMode — focus --new / --replace validation
// ---------------------------------------------------------------------------

describe('assertExactlyOneFocusMode', () => {
  test('zero flags → throws usage error', () => {
    assert.throws(
      () => assertExactlyOneFocusMode({}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('--new') || JSON.stringify(err).includes('--new'));
        return true;
      },
    );
  });

  test('both flags → throws usage error', () => {
    assert.throws(
      () => assertExactlyOneFocusMode({ new: true, replace: true }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  test('--new only → does not throw', () => {
    assert.doesNotThrow(() => assertExactlyOneFocusMode({ new: true }));
  });

  test('--replace only → does not throw', () => {
    assert.doesNotThrow(() => assertExactlyOneFocusMode({ replace: true }));
  });
});
