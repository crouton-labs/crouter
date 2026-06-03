// End-to-end tests for passive subscriptions:
//   1. A passive subscriber's pushes land in passive.jsonl, NOT inbox.jsonl
//      (so the inbox-watcher never wakes it); an active subscriber's land in
//      inbox.jsonl as before.
//   2. drainPassive reads + clears the accumulator (surfaces exactly once).
//   3. canvas-passive-context formats drained entries as timestamped XML and
//      transforms an `input` event into pre-text + the original message.
//
// Run: node --import tsx/esm --test src/core/__tests__/passive-subscription.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { inboxPath, passivePath } from '../canvas/paths.js';
import { push } from '../feed/feed.js';
import { appendPassive, readPassive, drainPassive } from '../feed/passive.js';
import { readInboxSince } from '../feed/inbox.js';
import registerCanvasPassiveContext, { formatPassive } from '../../pi-extensions/canvas-passive-context.js';
import type { NodeMeta } from '../canvas/types.js';
import type { InboxEntry } from '../feed/inbox.js';

let home: string;

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

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-passive-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  delete process.env['CRTR_NODE_ID'];
});

test('passive push accumulates in passive.jsonl, not inbox.jsonl', async () => {
  createNode(node('pub'));
  createNode(node('observer'));
  subscribe('observer', 'pub', false); // PASSIVE

  await push('pub', { kind: 'update', body: 'first observation\nmore detail' });

  // No inbox entry → the inbox-watcher would never see it → no wake.
  assert.equal(existsSync(inboxPath('observer')), false);
  assert.equal(readInboxSince('observer').length, 0);

  // It landed in the passive accumulator instead.
  const acc = readPassive('observer');
  assert.equal(acc.length, 1);
  assert.equal(acc[0]!.from, 'pub');
  assert.equal(acc[0]!.label, 'first observation');
  assert.ok(acc[0]!.ref && acc[0]!.ref.endsWith('-update.md'));
});

test('active push still lands in inbox.jsonl (wakes)', async () => {
  createNode(node('pub'));
  createNode(node('worker-mgr'));
  subscribe('worker-mgr', 'pub', true); // ACTIVE

  await push('pub', { kind: 'update', body: 'active report' });

  assert.equal(existsSync(passivePath('worker-mgr')), false);
  const inbox = readInboxSince('worker-mgr');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.from, 'pub');
});

test('mixed active + passive subscribers route to their own stores', async () => {
  createNode(node('pub'));
  createNode(node('active-sub'));
  createNode(node('passive-sub'));
  subscribe('active-sub', 'pub', true);
  subscribe('passive-sub', 'pub', false);

  const res = await push('pub', { kind: 'urgent', body: 'something happened' });
  assert.deepEqual(new Set(res.deliveredTo), new Set(['active-sub', 'passive-sub']));

  assert.equal(readInboxSince('active-sub').length, 1);
  assert.equal(existsSync(passivePath('active-sub')), false);

  assert.equal(readPassive('passive-sub').length, 1);
  assert.equal(existsSync(inboxPath('passive-sub')), false);
});

test('drainPassive reads then clears (surfaces exactly once)', () => {
  createNode(node('observer'));
  appendPassive('observer', { from: 'a', tier: 'normal', kind: 'update', label: 'one' });
  appendPassive('observer', { from: 'b', tier: 'normal', kind: 'update', label: 'two' });

  const drained = drainPassive('observer');
  assert.equal(drained.length, 2);
  assert.deepEqual(drained.map((e) => e.label), ['one', 'two']); // oldest first

  // Cleared — a second drain is empty.
  assert.equal(drainPassive('observer').length, 0);
  assert.equal(readPassive('observer').length, 0);
});

test('formatPassive renders timestamped XML update blocks', () => {
  const entries: InboxEntry[] = [
    { ts: '2026-06-03T12:00:00.000Z', from: 'pub-a', tier: 'normal', kind: 'update', label: 'alpha happened' },
    { ts: '2026-06-03T12:05:00.000Z', from: 'pub-b', tier: 'urgent', kind: 'final', label: 'beta done' },
  ];
  const xml = formatPassive(entries);
  assert.match(xml, /<passive-subscription-backlog count="2"/);
  assert.match(xml, /<update from="pub-a" kind="update" at="2026-06-03T12:00:00.000Z">/);
  assert.match(xml, /alpha happened/);
  assert.match(xml, /<update from="pub-b" kind="final" at="2026-06-03T12:05:00.000Z">/);
  assert.match(xml, /<\/passive-subscription-backlog>/);
});

// Minimal fake pi that captures the single `input` handler and lets us fire it.
interface FakePi {
  handler?: (ev: any) => any;
  on: (e: string, h: (ev: any) => any) => void;
}
function makeFakePi(): FakePi {
  return { on(e, h) { if (e === 'input') this.handler = h; } };
}

test('input handler injects drained backlog as pre-text, then clears it', async () => {
  createNode(node('pub'));
  createNode(node('observer'));
  subscribe('observer', 'pub', false);
  await push('pub', { kind: 'update', body: 'the body of the report\nsecond line' });

  process.env['CRTR_NODE_ID'] = 'observer';
  const pi = makeFakePi();
  registerCanvasPassiveContext(pi as any);
  assert.ok(pi.handler, 'input handler registered');

  // First message → backlog drains in as pre-text before the user's text.
  const out = pi.handler!({ type: 'input', text: 'hey what happened', source: 'interactive' });
  assert.equal(out.action, 'transform');
  assert.match(out.text, /<passive-subscription-backlog/);
  assert.match(out.text, /the body of the report/); // dereferenced report body
  assert.match(out.text, /hey what happened$/);     // original message preserved at the end

  // Second message → nothing accumulated → left untouched.
  const out2 = pi.handler!({ type: 'input', text: 'still there?', source: 'interactive' });
  assert.ok(out2 === undefined || out2.action === 'continue');
});

test('input handler is inert when nothing is accumulated', () => {
  createNode(node('observer'));
  process.env['CRTR_NODE_ID'] = 'observer';
  const pi = makeFakePi();
  registerCanvasPassiveContext(pi as any);
  const out = pi.handler!({ type: 'input', text: 'plain message', source: 'interactive' });
  assert.ok(out === undefined || out.action === 'continue');
});
