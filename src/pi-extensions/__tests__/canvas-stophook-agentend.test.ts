// Run with: node --import tsx/esm --test src/pi-extensions/__tests__/canvas-stophook-agentend.test.ts
//
// The stophook's agent_end routing no longer auto-pushes anything: a node
// reaches its subscribers ONLY through its own explicit `crtr push` calls.
// These tests pin that on the three stop outcomes:
//   • natural stop while awaiting a live worker → idle-release, NO push
//   • refresh-yield (intent='refresh')          → re-exec/shutdown, NO push
//   • stalled leaf (nothing live, no final)      → reprompt still fires
// Every assertion is on DB / disk effects (report files, inbox pointers) plus
// the captured sendUserMessage — tmux is unavailable here, so the focus/respawn
// helpers no-op (TMUX_PANE is cleared) and we drive a clean shutdown path.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import registerCanvasStophook from '../canvas-stophook.js';
import { createNode, subscribe, getNode, setStatus } from '../../core/canvas/canvas.js';
import { openFocusRow, getFocusByNode, getFocusById, listFocuses } from '../../core/canvas/focuses.js';
import { closeDb } from '../../core/canvas/db.js';
import { reportsDir } from '../../core/canvas/paths.js';
import { readInboxSince } from '../../core/feed/inbox.js';
import { STALL_REPROMPT } from '../../core/runtime/stop-guard.js';
import type { NodeMeta } from '../../core/canvas/types.js';

let home: string;
let origNode: string | undefined;
let origPane: string | undefined;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

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

/** A natural-stop agent_end event carrying one assistant text block. */
function stopEvent(text: string): { messages: any[] } {
  return { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] };
}

/** Count of report files written under a node's reports/ dir (0 when none). */
function reportCount(id: string): number {
  const dir = reportsDir(id);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0;
}

before(() => {
  origNode = process.env['CRTR_NODE_ID'];
  origPane = process.env['TMUX_PANE'];
});

beforeEach(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'crtr-stophook-end-'));
  process.env['CRTR_HOME'] = home;
  // Force the clean-shutdown path (no in-place respawn) so the refresh test is
  // deterministic even when the suite runs inside a tmux pane.
  delete process.env['TMUX_PANE'];
});

after(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  if (origNode === undefined) delete process.env['CRTR_NODE_ID']; else process.env['CRTR_NODE_ID'] = origNode;
  if (origPane === undefined) delete process.env['TMUX_PANE']; else process.env['TMUX_PANE'] = origPane;
});

test('natural stop while awaiting a live worker → idle-release with NO push (no report, no inbox pointer)', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('mgr', { parent: 'root', lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('worker', { parent: 'mgr', lifecycle: 'terminal', status: 'active' }));
  subscribe('root', 'mgr', true);   // root would receive any push mgr emits
  subscribe('mgr', 'worker', true); // mgr holds an active live subscription → "awaiting"

  process.env['CRTR_NODE_ID'] = 'mgr';
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('still waiting on the worker'), { shutdown: () => { shutdown = true; } });

  const m = getNode('mgr');
  assert.equal(m?.intent, 'idle-release', 'mgr idle-released');
  assert.equal(m?.status, 'idle', 'mgr marked idle');
  assert.equal(shutdown, true, 'pi shut down');
  assert.equal(reportCount('mgr'), 0, 'NO report file written');
  assert.equal(readInboxSince('root').length, 0, 'NO inbox pointer fanned to subscriber');
  assert.equal(pi.injected.length, 0, 'no reprompt on a legitimate idle-release');
  // §5.1 case 6 (awaiting + UNFOCUSED → idle-release, no focus): the awaiting
  // branch must never create/touch a focus row. Non-vacuous: an impl that ran
  // the done-branch handoff/openFocus on an idle-release would leave a row here.
  assert.equal(listFocuses().length, 0, 'awaiting+unfocused leaves the focuses table empty');
});

// ---------------------------------------------------------------------------
// §5.1 — the §1.7 agent_end branch map on the focuses table. Every assertion is
// on the canvas focuses/runtime rows after firing agent_end (TMUX_PANE is
// cleared in beforeEach). NOTE (broker-host cut): the placement read `focusOf`
// used by the handler now GC-prunes a viewer row whose pane is not a LIVE tmux
// pane (liveOrPrune → paneExists), so a fabricated '%pane' id is pruned on the
// first read. To drive the handler's focus path deterministically in the
// tmux-free fast tier we register viewer rows with a NULL pane (a registered-
// but-not-yet-realized viewer, which liveOrPrune passes through). status='done'
// is reached by setting the runtime row directly (the branch reads
// getNode(nodeId).status).
// ---------------------------------------------------------------------------

test('§5.1.1 truly-done + focused → focus row CLOSED, NO manager takeover (broker cut deleted handFocusToManager)', () => {
  // Regression guard for the broker-host cut: the engine is now a detached
  // broker, not a pane, so there is no engine to hand to a manager. The old
  // "dormant idle-release manager takes over the finished node's focus row"
  // path (handFocusToManager) is DELETED — a truly-done focused node just
  // tearDownNode's its own viewer and shuts down, EVEN when a dormant
  // idle-release manager exists (the exact case that used to trigger takeover).
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('mgr', { parent: 'root', lifecycle: 'terminal', mode: 'orchestrator', status: 'idle', intent: 'idle-release' }));
  // M starts WITH a recorded LOCATION so the done-path presence-null is observable.
  createNode(node('M', { parent: 'mgr', lifecycle: 'terminal', pane: '%m', tmux_session: 'Suser', window: '@wm' }));
  subscribe('mgr', 'M', true);
  openFocusRow('fM', null, 'Suser', 'M'); // null pane → focusOf returns it → drives tearDownNode

  process.env['CRTR_NODE_ID'] = 'M';
  setStatus('M', 'done'); // pushed final this turn
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('done — pushed final'), { shutdown: () => { shutdown = true; } });

  // The done branch: focusOf('M') != null → tearDownNode('M') CLOSES fM. The
  // manager is NOT handed anything (takeover deleted). Non-vacuous: a takeover
  // impl would leave getFocusByNode('mgr').focus_id === 'fM'.
  assert.equal(getFocusByNode('mgr'), null, 'the manager is NOT handed the finished node\'s focus (takeover deleted)');
  assert.equal(getFocusById('fM'), null, 'the finished node\'s viewer focus row is closed');
  assert.equal(getFocusByNode('M'), null, 'the finished node no longer occupies any focus');
  assert.equal(shutdown, true, 'pi shut down after teardown');
  // The done node's own presence is nulled (setPresence(null) on the done path).
  assert.equal(getNode('M')?.pane ?? null, null, 'the finished node\'s own LOCATION pane is nulled');
  assert.equal(getNode('M')?.window ?? null, null, 'the finished node\'s window presence is nulled too');
});

test('§5.1.2 truly-done + focused + NO manager (root) → focus row CLOSED (Q1)', () => {
  // R carries a LOCATION so the close-path presence-null is observable.
  createNode(node('R', { parent: null, lifecycle: 'terminal', pane: '%r', tmux_session: 'Suser', window: '@wr' }));
  openFocusRow('fR', '%r', 'Suser', 'R');

  process.env['CRTR_NODE_ID'] = 'R';
  setStatus('R', 'done');
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);
  pi.fire('agent_end', stopEvent('root done'), { shutdown: () => { /* swallow */ } });

  // managerId = R.parent(null) ?? subscribersOf(R)[0](none) = null →
  // handFocusToManager returns false → the close path: closeFocusRow(fR) +
  // setRemainOnExit(%r's window, false) (return-to-shell) + null R's presence.
  // Non-vacuous: a takeover-instead-of-close impl would leave the row present;
  // an impl that skips the MINOR presence-null leaves getNode('R').pane === '%r'.
  assert.equal(getFocusById('fR'), null, 'a manager-less finished focus is closed, not handed off');
  assert.equal(listFocuses().length, 0, 'no focus rows survive');
  assert.equal(getNode('R')?.pane ?? null, null, 'the finished root\'s own LOCATION pane is nulled (close path reaps)');
});

test('§5.1.3 truly-done + focused + manager ALREADY focused elsewhere → focus CLOSED, manager UNMOVED', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('mgr', { parent: 'root', lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('M', { parent: 'mgr', lifecycle: 'terminal', pane: '%m', tmux_session: 'Sa', window: '@wm' }));
  subscribe('mgr', 'M', true);
  openFocusRow('fOther', '%o', 'Sb', 'mgr'); // mgr already on its OWN viewport
  openFocusRow('fM', '%m', 'Sa', 'M');

  process.env['CRTR_NODE_ID'] = 'M';
  setStatus('M', 'done');
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);
  pi.fire('agent_end', stopEvent('M done'), { shutdown: () => { /* swallow */ } });

  // handFocusToManager sees getFocusByNode('mgr') != null → returns false →
  // closeFocusRow(fM). Non-vacuous: moving mgr would either repoint its focus_id
  // to fM (and a wrong impl that didn't close fM would leave it present) or throw
  // UNIQUE(node_id); this pins mgr's OTHER focus untouched and M's focus gone.
  assert.equal(getFocusById('fM'), null, "M's focus is closed");
  assert.equal(getFocusByNode('mgr')?.focus_id, 'fOther', "the manager's other viewport is NOT stolen");
  // MINOR: M (done) is reaped on the close path — its own presence nulled.
  // Non-vacuous: an impl that skips the done-path setPresence-null leaves
  // getNode('M').pane === '%m'.
  assert.equal(getNode('M')?.pane ?? null, null, "the finished node's own LOCATION pane is nulled");
});

test('§5.1.4 truly-done + UNFOCUSED → no focus row created/touched, shuts down (Invariant P)', () => {
  createNode(node('mgr', { parent: null, lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('M', { parent: 'mgr', lifecycle: 'terminal' }));
  subscribe('mgr', 'M', true);

  process.env['CRTR_NODE_ID'] = 'M';
  setStatus('M', 'done');
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('done, never had a viewport'), { shutdown: () => { shutdown = true; } });

  // focusOf(M) is null → the focus block is skipped entirely → just shutdown.
  // Non-vacuous: an impl that created or handed off a focus row would leave
  // listFocuses non-empty.
  assert.equal(shutdown, true, 'an unfocused done node shuts down');
  assert.equal(listFocuses().length, 0, 'no focus row was created or touched');
});

test('§5.1.5 awaiting + FOCUSED → STAY ALIVE: pi keeps running (no release), focus row untouched (F3)', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('mgr', { parent: 'root', lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('worker', { parent: 'mgr', lifecycle: 'terminal', status: 'active' }));
  subscribe('root', 'mgr', true);
  subscribe('mgr', 'worker', true); // mgr awaits a live worker → would idle-release if UNfocused
  // null pane (broker cut): focusOf passes a null-pane viewer row through, so the
  // handler reads mgr as FOCUSED in the tmux-free fast tier (a fabricated %pane
  // would be GC-pruned by liveOrPrune and the node would wrongly release).
  openFocusRow('fMgr', null, 'Suser', 'mgr');

  process.env['CRTR_NODE_ID'] = 'mgr';
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('still waiting on the worker'), { shutdown: () => { shutdown = true; } });

  // A FOCUSED awaiting node holds the user's viewport, so the awaiting branch
  // keeps pi LIVE and dormant (the in-process inbox-watcher wakes it) instead of
  // releasing + shutting down. It must NOT release, NOT shut down, and NOT touch
  // the focus row. Non-vacuous: the old freeze impl flipped intent→idle-release
  // and shut pi down; this pins all three as untouched.
  assert.equal(getNode('mgr')?.status, 'active', 'a focused awaiting node stays active (not released)');
  assert.equal(getNode('mgr')?.intent ?? null, null, 'no idle-release intent while focused');
  assert.equal(shutdown, false, 'a focused awaiting node is NOT shut down — pi stays live');
  assert.equal(getFocusByNode('mgr')?.focus_id, 'fMgr', 'the focus row is UNCHANGED — not closed, not handed off');
});

test('§5.1.7 resident attended (no live subs) → nothing happens; focus + status survive', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  openFocusRow('fR', '%r', 'Suser', 'root');

  process.env['CRTR_NODE_ID'] = 'root';
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('I have wrapped up'), { shutdown: () => { shutdown = true; } });

  // evaluateStop on a resident → reason 'dormant' (NOT 'awaiting'), so the
  // awaiting branch is skipped and the handler does nothing: no release, no
  // shutdown, no focus touch. Non-vacuous: an impl that idle-released a resident
  // would flip status→idle / intent→idle-release; one that touched focus would
  // change/remove fR.
  assert.equal(getNode('root')?.status, 'active', 'a resident is never forced dormant');
  assert.equal(getNode('root')?.intent ?? null, null, 'no idle-release intent on a resident');
  assert.equal(getFocusByNode('root')?.focus_id, 'fR', 'focus row survives untouched');
  assert.equal(shutdown, false, 'a resident attended node is not shut down');
});

test('refresh-yield (intent=refresh) writes NO push — silent to subscribers', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident' }));
  createNode(node('orch', { parent: 'root', lifecycle: 'terminal', mode: 'orchestrator', intent: 'refresh' }));
  subscribe('root', 'orch', true);

  process.env['CRTR_NODE_ID'] = 'orch';
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('checkpoint before refreshing'), { shutdown: () => { shutdown = true; } });

  assert.equal(shutdown, true, 'pi shut down (no tmux pane → clean shutdown)');
  assert.equal(reportCount('orch'), 0, 'a yield is silent: NO report file');
  assert.equal(readInboxSince('root').length, 0, 'a yield is silent: NO inbox pointer');
  assert.equal(pi.injected.length, 0, 'no reprompt on a refresh-yield');
});

test('stalled leaf (nothing live to await, no final) is still reprompted', () => {
  createNode(node('mgr', { parent: null, lifecycle: 'terminal', mode: 'orchestrator' }));
  createNode(node('leaf', { parent: 'mgr', lifecycle: 'terminal', status: 'active' }));
  subscribe('mgr', 'leaf', true); // mgr subscribes to leaf; leaf itself awaits nothing

  process.env['CRTR_NODE_ID'] = 'leaf';
  const pi = makeFakePi();
  registerCanvasStophook(pi as any);

  let shutdown = false;
  pi.fire('agent_end', stopEvent('I think I am basically done here'), { shutdown: () => { shutdown = true; } });

  assert.equal(pi.injected.length, 1, 'the stall reprompt fired');
  assert.equal(pi.injected[0]!.content, STALL_REPROMPT, 'reprompt carries the stall nudge to push final / ask');
  assert.equal(pi.injected[0]!.deliverAs, 'followUp', 'reprompt delivered as a followUp');
  assert.equal(shutdown, false, 'a stalled leaf is NOT shut down — it is re-prompted to finish');
  assert.notEqual(getNode('leaf')?.intent, 'idle-release', 'a stalled leaf does not idle-release');
  assert.equal(reportCount('leaf'), 0, 'NO report file written on a stall');
  assert.equal(readInboxSince('mgr').length, 0, 'NO inbox pointer fanned on a stall');
});
