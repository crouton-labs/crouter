// Tests for the canvas-node inbox watcher pi extension.
//
// Run with: node --import tsx/esm --test src/core/__tests__/canvas-inbox-watcher.test.ts
//
// Focus: a finished node (push final → InboxEntry kind 'final') must STEER a
// mid-stream subscriber, not queue behind its current turn as a follow-up.
// Part 2 — the refresh-yield HOLD path and idle delivery — lives in
// canvas-inbox-watcher-hold.test.ts (split for node:test file-level parallelism).

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerCanvasInboxWatcher from '../../pi-extensions/canvas-inbox-watcher.js';
import { appendInbox } from '../feed/inbox.js';

// Drive the watcher's injectable cadence seam (CRTR_WATCHER_TICK_MS /
// CRTR_WATCHER_DEBOUNCE_MS) at a fast tempo so the test sleeps milliseconds, not
// seconds. SETTLE_MS still allows a resolve+seed tick, a read tick, and the
// debounce window before asserting, exactly as against the real 800/1000 cadence.
const TICK_MS = 20;
const DEBOUNCE_MS = 25;
const SETTLE_MS = TICK_MS * 2 + DEBOUNCE_MS + 30;

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

let origTick: string | undefined;
let origDebounce: string | undefined;

before(() => {
  origHome = process.env['CRTR_HOME'];
  origNode = process.env['CRTR_NODE_ID'];
  origTick = process.env['CRTR_WATCHER_TICK_MS'];
  origDebounce = process.env['CRTR_WATCHER_DEBOUNCE_MS'];
  process.env['CRTR_WATCHER_TICK_MS'] = String(TICK_MS);
  process.env['CRTR_WATCHER_DEBOUNCE_MS'] = String(DEBOUNCE_MS);
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

after(() => {
  if (origHome === undefined) delete process.env['CRTR_HOME']; else process.env['CRTR_HOME'] = origHome;
  if (origNode === undefined) delete process.env['CRTR_NODE_ID']; else process.env['CRTR_NODE_ID'] = origNode;
  if (origTick === undefined) delete process.env['CRTR_WATCHER_TICK_MS']; else process.env['CRTR_WATCHER_TICK_MS'] = origTick;
  if (origDebounce === undefined) delete process.env['CRTR_WATCHER_DEBOUNCE_MS']; else process.env['CRTR_WATCHER_DEBOUNCE_MS'] = origDebounce;
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* noop */ } }
});

describe('canvas inbox watcher — finished-node delivery', () => {
  test('mid-stream: a finished node (kind final) steers the subscriber', async () => {
    freshNode('node-final');
    const pi = makeFakePi();
    disposers.push(registerCanvasInboxWatcher(pi as any));
    // Subscriber is actively streaming when the worker finishes.
    pi.fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
    await wait(TICK_MS + 100);
    appendInbox('node-final', { from: 'child-1', tier: 'normal', kind: 'final', label: 'all done' });
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1, 'one coalesced injection');
    assert.equal(pi.injected[0]!.deliverAs, 'steer', 'a finished node steers, not follows up');
  });

  test('mid-stream: a routine update still follows up', async () => {
    freshNode('node-update');
    const pi = makeFakePi();
    disposers.push(registerCanvasInboxWatcher(pi as any));
    pi.fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
    await wait(TICK_MS + 100);
    appendInbox('node-update', { from: 'child-2', tier: 'normal', kind: 'update', label: 'still working' });
    await wait(SETTLE_MS);
    assert.equal(pi.injected.length, 1);
    assert.equal(pi.injected[0]!.deliverAs, 'followUp', 'a normal update is not urgent → followUp');
  });
});
