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
import { createNode, subscribe, getNode } from '../../core/canvas/canvas.js';
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
