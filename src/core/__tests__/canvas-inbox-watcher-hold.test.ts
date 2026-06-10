// Tests for the canvas-node inbox watcher pi extension, part 2 — the
// refresh-yield HOLD path and idle delivery. Split out of
// canvas-inbox-watcher.test.ts (see its header) so node:test's file-level
// parallelism applies; the tests and the scaffold are moved here UNCHANGED.
//
// Run with: node --import tsx/esm --test src/core/__tests__/canvas-inbox-watcher-hold.test.ts

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerCanvasInboxWatcher from '../../pi-extensions/canvas-inbox-watcher.js';
import { appendInbox } from '../feed/inbox.js';
import { createNode, setIntent } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta } from '../canvas/types.js';

// Mirror the watcher's internal cadence (TICK_MS=800, DEBOUNCE_MS=1000): allow a
// resolve+seed tick, a read tick, and the debounce window before asserting.
const TICK_MS = 800;
const DEBOUNCE_MS = 1000;
const SETTLE_MS = TICK_MS * 2 + DEBOUNCE_MS + 500;

let origHome: string | undefined;
let origNode: string | undefined;
const homes: string[] = [];
const disposers: (() => void)[] = [];

/** Point CRTR_HOME at a fresh temp canvas root and bind CRTR_NODE_ID. */
function freshNode(nodeId: string): void {
  const home = join(tmpdir(), `crtr-canvas-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  homes.push(home);
  process.env['CRTR_HOME'] = home;
  process.env['CRTR_NODE_ID'] = nodeId;
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

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

before(() => {
  origHome = process.env['CRTR_HOME'];
  origNode = process.env['CRTR_NODE_ID'];
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

after(() => {
  if (origHome === undefined) delete process.env['CRTR_HOME']; else process.env['CRTR_HOME'] = origHome;
  if (origNode === undefined) delete process.env['CRTR_NODE_ID']; else process.env['CRTR_NODE_ID'] = origNode;
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* noop */ } }
});

describe('canvas inbox watcher — hold + idle delivery', () => {
  test('refresh-yield in flight: inbox entries are HELD, then delivered once intent clears (no loss)', async () => {
    freshNode('node-refresh');
    closeDb(); // rebind the canvas db to this test's fresh home
    const meta: NodeMeta = {
      node_id: 'node-refresh', name: 'r', created: new Date().toISOString(),
      cwd: '/tmp', kind: 'general', mode: 'base', lifecycle: 'resident',
      status: 'active', intent: 'refresh',
    };
    createNode(meta);
    const pi = makeFakePi();
    disposers.push(registerCanvasInboxWatcher(pi as any));
    // Streaming (mid-turn) when a child finishes — normally this would steer.
    pi.fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
    await wait(TICK_MS + 100);
    appendInbox('node-refresh', { from: 'child-x', tier: 'urgent', kind: 'final', label: 'done' });
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 0, 'entries are held while a refresh-yield is in flight (no steer-hijack)');

    // The fresh pi clears intent on boot; the held entry must then be delivered
    // — the cursor was never advanced, so nothing is lost.
    setIntent('node-refresh', null);
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'the held entry is delivered once the refresh clears');
  });

  test('idle: a finished node triggers a fresh turn (no deliverAs)', async () => {
    freshNode('node-idle');
    const pi = makeFakePi();
    disposers.push(registerCanvasInboxWatcher(pi as any));
    // No agent_start fired → watcher treats the node as idle.
    await wait(TICK_MS + 100);
    appendInbox('node-idle', { from: 'child-3', tier: 'normal', kind: 'final', label: 'done while idle' });
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1);
    assert.equal(pi.injected[0]!.deliverAs, undefined, 'idle → sendUserMessage triggers a turn, no deliverAs');
  });
});
