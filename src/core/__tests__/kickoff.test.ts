// Run with: node --import tsx/esm --test src/core/__tests__/kickoff.test.ts
//
// The fresh-revive kickoff split (runtime/kickoff.ts). drainBearings is the ONE
// consuming step (consume the yield note, advance the feed cursor); after it,
// buildReviveKickoff is a PURE string assembler — calling it twice produces the
// same string and mutates NOTHING (note stays gone, cursor stays put). This is
// the regression guard for the old "build had hidden side effects" smell.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, subscribe } from '../canvas/canvas.js';
import { reportsDir } from '../canvas/paths.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta } from '../canvas/types.js';
import {
  drainBearings,
  buildReviveKickoff,
  writeYieldMessage,
  yieldMessagePath,
} from '../runtime/kickoff.js';
import { appendInbox, readCursor } from '../feed/inbox.js';

let home: string;

function node(id: string): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-kickoff-'));
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
});

test('drainBearings consumes the yield note + advances the cursor exactly once', () => {
  const id = 'n1';
  const meta = createNode(node(id));
  writeYieldMessage(id, 'on wake, finish step 3');
  appendInbox(id, { from: 'w1', tier: 'normal', kind: 'update', label: 'first', ref: '/tmp/a.md' });
  const last = appendInbox(id, { from: 'w1', tier: 'normal', kind: 'update', label: 'second', ref: '/tmp/b.md' });

  // First drain: captures the note + digests the unread feed.
  const b1 = drainBearings(meta);
  assert.equal(b1.yieldMsg?.trim(), 'on wake, finish step 3');
  assert.ok(b1.unreadDigest !== null && b1.unreadDigest.length > 0);
  assert.equal(existsSync(yieldMessagePath(id)), false, 'yield note deleted on read');
  assert.equal(readCursor(id), last.ts, 'cursor advanced to the last unread entry');

  // Second drain: the note is gone and the cursor is past the feed → nothing left.
  const b2 = drainBearings(meta);
  assert.equal(b2.yieldMsg, null);
  assert.equal(b2.unreadDigest, null);
});

test('the feed block frames awaiting workers as alive + auto-waking, so a fresh revive has no reason to peek', () => {
  const parent = createNode(node('p1'));
  const child = createNode(node('c1')); // status 'active' by default
  subscribe(parent.node_id, child.node_id); // parent awaits child

  const msg = buildReviveKickoff(parent, drainBearings(parent));

  // The roster names the live child...
  assert.ok(msg.includes(child.node_id), 'awaiting roster lists the live child');
  // ...and asserts aliveness + the automatic wake at the source, so the node
  // does not burn a turn confirming with `feed read`/`feed peek`.
  assert.ok(/alive and running/.test(msg), 'states the worker is alive and running');
  assert.ok(/wake you the moment/.test(msg), 'states the wake is automatic on push');
  assert.ok(/still working, not stalled/.test(msg), 'frames the empty feed as expected, not a problem');
});

test('a fresh revive is pointed at its subscriptions\' on-disk report history (catch-up bug)', () => {
  // Regression for the fresh-revive catch-up bug: on a refresh-yield
  // (resume:false) the old conversation is gone AND the inbox cursor has already
  // advanced past everything drained pre-yield, so the revived node loses sight
  // of reports its subscriptions pushed BEFORE the yield. The bodies persist
  // forever at reports/<ts>-<kind>.md; the kickoff must point the node at those
  // existing paths so it can catch up. Asserts the paths are rendered.
  const parent = createNode(node('p1'));
  const worker = createNode(node('w1'));
  subscribe(parent.node_id, worker.node_id);

  // The worker pushed two reports BEFORE the parent's refresh-yield.
  const dir = reportsDir(worker.node_id);
  mkdirSync(dir, { recursive: true });
  const older = join(dir, '20260608T120000-update.md');
  const newer = join(dir, '20260608T130000-final.md');
  writeFileSync(older, '---\n---\nearly progress', 'utf8');
  writeFileSync(newer, '---\n---\nthe result', 'utf8');

  const msg = buildReviveKickoff(parent, drainBearings(parent));

  // Both existing report PATHS surface (most recent first), so the revived node
  // can dereference the history its advanced cursor would otherwise hide.
  assert.ok(msg.includes(older), 'older report path surfaced');
  assert.ok(msg.includes(newer), 'newer report path surfaced');
  assert.ok(msg.indexOf(newer) < msg.indexOf(older), 'most recent report listed first');
  // ...and the hint that the full inbox history is replayable cursor-independently.
  assert.ok(/feed read --all/.test(msg), 'points at the cursor-independent full-history replay');
});

test('buildReviveKickoff is pure — building twice eats nothing', () => {
  const id = 'n2';
  const meta = createNode(node(id));
  writeYieldMessage(id, 'remember the invariant');
  const last = appendInbox(id, { from: 'w', tier: 'normal', kind: 'update', label: 'r', ref: '/tmp/r.md' });

  // Drain once (the consuming step), then build twice off the same bearings.
  const bearings = drainBearings(meta);
  const cursorAfterDrain = readCursor(id);
  assert.equal(cursorAfterDrain, last.ts);

  const s1 = buildReviveKickoff(meta, bearings);
  const s2 = buildReviveKickoff(meta, bearings);

  // Identical output, and the build mutated nothing: cursor unchanged, note gone.
  assert.equal(s1, s2);
  assert.ok(s1.includes('remember the invariant'), 'yield note surfaced in the message');
  assert.equal(readCursor(id), cursorAfterDrain, 'build does not touch the cursor');
  assert.equal(existsSync(yieldMessagePath(id)), false, 'build does not resurrect the note');
});
