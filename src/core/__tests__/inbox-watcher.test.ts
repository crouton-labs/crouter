// Tests for the parent-side inbox watcher pi extension.
//
// Run with: node --import tsx/esm --test src/core/__tests__/inbox-watcher.test.ts

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentInboxWatcher, { __testing } from '../../pi-extensions/agent-inbox-watcher.js';
import { appendNodeEvent, sessionsRoot, sessionDir, sessionMetaPath, inboxPath } from '../inbox.js';

const { TICK_MS, DEBOUNCE_MS } = __testing;
// Long enough for a resolve tick + at least one read tick + the debounce window.
const SETTLE_MS = TICK_MS * 2 + DEBOUNCE_MS + 400;

let cwd: string;
let origCwd: string;
let origSession: string | undefined;
let origJob: string | undefined;
let origPane: string | undefined;
let origSessionCwd: string | undefined;
let origPi: string | undefined;
const disposers: (() => void)[] = [];

/** Write a session.json with a given created timestamp so the watcher can seed
 *  its cursor from session-creation time. Pass `piSessionId` to model a
 *  top-level session bound to a pi conversation (host node `pi:<id>`). */
function writeSessionMeta(
  sessionId: string,
  created: string,
  ns?: string,
  rootPane = '%0',
  piSessionId?: string,
): void {
  mkdirSync(sessionDir(sessionId, ns), { recursive: true });
  const rec: Record<string, unknown> = { session_id: sessionId, created, root_pane: rootPane, nodes: [], agents: [] };
  if (piSessionId !== undefined) rec['pi_session_id'] = piSessionId;
  writeFileSync(sessionMetaPath(sessionId, ns), JSON.stringify(rec), 'utf8');
}

before(() => {
  origCwd = process.cwd();
  origSession = process.env['CRTR_SESSION_ID'];
  origJob = process.env['CRTR_JOB_ID'];
  origPane = process.env['TMUX_PANE'];
  origSessionCwd = process.env['CRTR_SESSION_CWD'];
  origPi = process.env['CRTR_PI_SESSION_ID'];
  cwd = join(tmpdir(), `crtr-watcher-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  process.chdir(cwd);
  // Canonicalize: the watcher resolves paths from process.cwd(), which on macOS
  // resolves the /var -> /private/var symlink. Match it so the inbox file the
  // test writes is the one the watcher reads.
  cwd = process.cwd();
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
  // Prevent a top-level pi id from leaking into the next test.
  delete process.env['CRTR_PI_SESSION_ID'];
});

after(() => {
  process.chdir(origCwd);
  for (const [k, v] of [['CRTR_SESSION_ID', origSession], ['CRTR_JOB_ID', origJob], ['TMUX_PANE', origPane], ['CRTR_SESSION_CWD', origSessionCwd], ['CRTR_PI_SESSION_ID', origPi]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { rmSync(sessionsRoot(cwd), { recursive: true, force: true }); } catch { /* noop */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ }
});

interface FakePi {
  injected: { content: string; deliverAs?: string }[];
  on: (e: string, h: (ev: any, ctx: any) => void) => void;
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void;
  fire: (e: string, ev: any, ctx: any) => void;
}

function makeFakePi(): FakePi {
  const handlers: Record<string, (ev: any, ctx: any) => void> = {};
  return {
    injected: [],
    on(e, h) { handlers[e] = h; },
    sendUserMessage(content, options) { this.injected.push({ content, deliverAs: options?.deliverAs }); },
    fire(e, ev, ctx) { handlers[e]?.(ev, ctx); },
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('agentInboxWatcher (spawned-agent context)', () => {
  test('inert when no crtr session resolves (R8)', async () => {
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['TMUX_PANE'];
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0);
  });

  test('idle parent: a completed event injects a notice with no deliverAs (triggers turn)', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-idle';
    process.env['CRTR_JOB_ID'] = 'wnode-idle';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    // Let the watcher resolve + set its cursor first, THEN emit the completion.
    await wait(TICK_MS + 100);
    appendNodeEvent('wsess-idle', 'wnode-idle', { from: 'child-job-1', event: 'completed', data: { status: 'done', name: 'scout' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'one injection');
    assert.match(pi.injected[0]!.content, /child-job-1/);
    assert.match(pi.injected[0]!.content, /scout/);
    assert.equal(pi.injected[0]!.deliverAs, undefined, 'idle → triggers a turn, no deliverAs');
  });

  test('mid-stream parent: completion delivered as followUp', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-mid';
    process.env['CRTR_JOB_ID'] = 'wnode-mid';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    pi.fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
    await wait(TICK_MS + 100);
    appendNodeEvent('wsess-mid', 'wnode-mid', { from: 'child-job-2', event: 'completed', data: { status: 'done' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1);
    assert.equal(pi.injected[0]!.deliverAs, 'followUp');
  });

  test('burst coalesces into a single injection (R5)', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-burst';
    process.env['CRTR_JOB_ID'] = 'wnode-burst';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    appendNodeEvent('wsess-burst', 'wnode-burst', { from: 'job-a', event: 'completed', data: { status: 'done' } }, cwd);
    appendNodeEvent('wsess-burst', 'wnode-burst', { from: 'job-b', event: 'completed', data: { status: 'failed' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'two completions → one coalesced notice');
    assert.match(pi.injected[0]!.content, /job-a/);
    assert.match(pi.injected[0]!.content, /job-b/);
  });

  test('steer delivery hint delivers as steer when mid-stream', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-steer';
    process.env['CRTR_JOB_ID'] = 'wnode-steer';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    pi.fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
    await wait(TICK_MS + 100);
    appendNodeEvent('wsess-steer', 'wnode-steer', { from: 'job-s', event: 'completed', data: { status: 'done', delivery: 'steer' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1);
    assert.equal(pi.injected[0]!.deliverAs, 'steer');
  });

  test('collected tombstone in the same scan suppresses the completion notice', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-coll';
    process.env['CRTR_JOB_ID'] = 'wnode-coll';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    // Pull path collected the result out-of-band: both events land before a tick.
    appendNodeEvent('wsess-coll', 'wnode-coll', { from: 'pulled-job', event: 'completed', data: { status: 'done' } }, cwd);
    appendNodeEvent('wsess-coll', 'wnode-coll', { from: 'pulled-job', event: 'collected', data: { job_id: 'pulled-job' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0, 'completion already collected via pull path → no push notice');
  });

  test('collected tombstone cancels a completion still in the debounce buffer', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-cancel';
    process.env['CRTR_JOB_ID'] = 'wnode-cancel';
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    appendNodeEvent('wsess-cancel', 'wnode-cancel', { from: 'late-job', event: 'completed', data: { status: 'done' } }, cwd);
    // Collected arrives shortly after, still well within the debounce window
    // (before the completion can flush) → cancel.
    await wait(200);
    appendNodeEvent('wsess-cancel', 'wnode-cancel', { from: 'late-job', event: 'collected', data: { job_id: 'late-job' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0, 'collected within debounce cancels the pending notice');
  });
});

describe('agentInboxWatcher (startup race + cwd identity)', () => {
  test('startup race: a completion that arrived BEFORE the watcher resolved is still delivered (acceptance #9)', async () => {
    // Seed a session created in the past, then write the completion BEFORE the
    // watcher ever runs. A `cursor = now` reset would drop it; seeding from
    // session-creation time delivers it.
    process.env['CRTR_SESSION_ID'] = 'wsess-race';
    process.env['CRTR_JOB_ID'] = 'wnode-race';
    const past = new Date(Date.now() - 60_000).toISOString();
    writeSessionMeta('wsess-race', past);
    appendNodeEvent('wsess-race', 'wnode-race', { from: 'early-job', event: 'completed', data: { status: 'done', name: 'early' } }, cwd);
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'pre-resolution completion is delivered');
    assert.match(pi.injected[0]!.content, /early-job/);
  });

  test('no history replay: an event older than session creation is NOT delivered', async () => {
    process.env['CRTR_SESSION_ID'] = 'wsess-hist';
    process.env['CRTR_JOB_ID'] = 'wnode-hist';
    const created = new Date(Date.now() - 30_000).toISOString();
    writeSessionMeta('wsess-hist', created);
    // Hand-write an inbox line with a ts BEFORE the session was created.
    const ancient = new Date(Date.now() - 120_000).toISOString();
    const p = inboxPath('wsess-hist', 'wnode-hist', cwd);
    mkdirSync(join(sessionDir('wsess-hist', cwd), 'inboxes'), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: ancient, to: 'wnode-hist', from: 'old-job', event: 'completed', data: { status: 'done' } }) + '\n', 'utf8');
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0, 'pre-session-creation event is not replayed');
  });

  test('session_start publishes the pi conversation id into process.env for child subprocesses', () => {
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_PI_SESSION_ID'];
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    pi.fire('session_start', { type: 'session_start', reason: 'new' }, {
      sessionManager: { getSessionId: () => 'pi-published' },
    });
    assert.equal(process.env['CRTR_PI_SESSION_ID'], 'pi-published');
  });

  test('top-level: resolves the session bound to THIS pi conversation and delivers its completion', async () => {
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_CWD'];
    const pane = '%777';
    process.env['TMUX_PANE'] = pane;
    const piId = 'pi-conv-A';
    process.env['CRTR_PI_SESSION_ID'] = piId;
    const node = `pi:${piId}`;
    const created = new Date(Date.now() - 60_000).toISOString();
    writeSessionMeta('top-A', created, undefined, pane, piId);
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    appendNodeEvent('top-A', node, { from: 'live-job', event: 'completed', data: { status: 'done', name: 'waiter' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'the live completion fires');
    assert.match(pi.injected[0]!.content, /live-job/);
  });

  test('cross-conversation isolation: a completion in ANOTHER conversation\'s session on the SAME pane is never delivered', async () => {
    // The pane-reuse bleed bug: two conversations share root_pane %778. The
    // watcher is bound to pi id A; conversation B's session holds a completion.
    // It must NOT bleed into A.
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_CWD'];
    const pane = '%778';
    process.env['TMUX_PANE'] = pane;
    process.env['CRTR_PI_SESSION_ID'] = 'pi-A';
    // Conversation B (a PRIOR conversation on the reused pane) with a completion.
    const bCreated = new Date(Date.now() - 120_000).toISOString();
    writeSessionMeta('sess-B', bCreated, undefined, pane, 'pi-B');
    const bNode = 'pi:pi-B';
    const bInbox = inboxPath('sess-B', bNode, cwd);
    mkdirSync(join(sessionDir('sess-B', cwd), 'inboxes'), { recursive: true });
    appendFileSync(bInbox, JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), to: bNode, from: 'B-job', event: 'completed', data: { status: 'done' } }) + '\n', 'utf8');
    // Conversation A (this one) — its own session, initially no completion.
    const aCreated = new Date(Date.now() - 30_000).toISOString();
    writeSessionMeta('sess-A', aCreated, undefined, pane, 'pi-A');
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    // A live completion in A's session DOES fire; B's never does.
    appendNodeEvent('sess-A', 'pi:pi-A', { from: 'A-job', event: 'completed', data: { status: 'done' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'only this conversation\'s completion fires');
    assert.match(pi.injected[0]!.content, /A-job/);
    assert.doesNotMatch(pi.injected[0]!.content, /B-job/, 'the other conversation\'s completion never bleeds in');
  });

  test('reload persistence: a completion delivered before a watcher re-init is not re-injected (same pi id)', async () => {
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_CWD'];
    const pane = '%779';
    process.env['TMUX_PANE'] = pane;
    process.env['CRTR_PI_SESSION_ID'] = 'pi-reload';
    const node = 'pi:pi-reload';
    const created = new Date(Date.now() - 60_000).toISOString();
    writeSessionMeta('sess-reload', created, undefined, pane, 'pi-reload');
    const pi1 = makeFakePi();
    disposers.push(agentInboxWatcher(pi1 as any));
    await wait(TICK_MS + 100);
    appendNodeEvent('sess-reload', node, { from: 'reload-job', event: 'completed', data: { status: 'done' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi1.injected.length, 1, 'first watcher delivers once');
    // Re-init (a /reload re-invokes the extension factory) with the SAME pi id.
    const pi2 = makeFakePi();
    disposers.push(agentInboxWatcher(pi2 as any));
    await wait(SETTLE_MS);
    assert.equal(pi2.injected.length, 0, 'the durable per-inbox cursor prevents re-injection after reload');
  });

  test('inert at top level when no pi id is available (no buggy pane fallback)', async () => {
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_CWD'];
    delete process.env['CRTR_PI_SESSION_ID'];
    const pane = '%780';
    process.env['TMUX_PANE'] = pane;
    // A session exists on the pane, but with no pi id the watcher must stay inert.
    const created = new Date(Date.now() - 60_000).toISOString();
    writeSessionMeta('sess-nopi', created, undefined, pane, 'pi-orphan');
    appendNodeEvent('sess-nopi', 'pi:pi-orphan', { from: 'orphan-job', event: 'completed', data: { status: 'done' } }, cwd);
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0, 'no CRTR_PI_SESSION_ID → top-level watcher is inert');
  });

  test('/new closure isolation: flipping CRTR_PI_SESSION_ID mid-process delivers the new conversation without leaking the old cursor', async () => {
    // Same pi PROCESS, different conversation (a /new without factory re-init):
    // the in-memory closure carries seeded=true + a stale cursor, but the new
    // target\'s inbox file is disjoint, so its completion is still delivered.
    delete process.env['CRTR_SESSION_ID'];
    delete process.env['CRTR_JOB_ID'];
    delete process.env['CRTR_SESSION_CWD'];
    const pane = '%781';
    process.env['TMUX_PANE'] = pane;
    // Conversation A: seed + deliver one completion.
    process.env['CRTR_PI_SESSION_ID'] = 'pi-new-A';
    writeSessionMeta('new-A', new Date(Date.now() - 90_000).toISOString(), undefined, pane, 'pi-new-A');
    const pi = makeFakePi();
    disposers.push(agentInboxWatcher(pi as any));
    await wait(TICK_MS + 100);
    appendNodeEvent('new-A', 'pi:pi-new-A', { from: 'A1-job', event: 'completed', data: { status: 'done' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'conversation A delivered');
    // /new → flip to conversation B in the same process (no re-init).
    process.env['CRTR_PI_SESSION_ID'] = 'pi-new-B';
    writeSessionMeta('new-B', new Date(Date.now() - 30_000).toISOString(), undefined, pane, 'pi-new-B');
    await wait(TICK_MS + 100);
    appendNodeEvent('new-B', 'pi:pi-new-B', { from: 'B1-job', event: 'completed', data: { status: 'done' } }, cwd);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 2, 'conversation B\'s completion is delivered too');
    assert.match(pi.injected[1]!.content, /B1-job/);
  });

  test('cross-cwd: watcher reads the session namespace from CRTR_SESSION_CWD, not process.cwd() (acceptance #10)', async () => {
    // Delivery wrote the inbox under the SESSION cwd namespace; the watcher
    // runs in a DIFFERENT process.cwd() but must still find it via
    // CRTR_SESSION_CWD.
    const sessNs = join(tmpdir(), `crtr-watcher-ns-${Date.now()}`);
    mkdirSync(sessNs, { recursive: true });
    process.env['CRTR_SESSION_ID'] = 'wsess-xcwd';
    process.env['CRTR_JOB_ID'] = 'wnode-xcwd';
    process.env['CRTR_SESSION_CWD'] = sessNs;
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      writeSessionMeta('wsess-xcwd', past, sessNs);
      appendNodeEvent('wsess-xcwd', 'wnode-xcwd', { from: 'xcwd-job', event: 'completed', data: { status: 'done' } }, sessNs);
      const pi = makeFakePi();
      disposers.push(agentInboxWatcher(pi as any));
      await wait(SETTLE_MS);
      assert.equal(pi.injected.length, 1, 'completion under the session-cwd namespace is delivered');
      assert.match(pi.injected[0]!.content, /xcwd-job/);
    } finally {
      delete process.env['CRTR_SESSION_CWD'];
      try { rmSync(sessNs, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});
