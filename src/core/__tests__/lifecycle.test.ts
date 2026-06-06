// Run with: node --import tsx/esm --test src/core/__tests__/lifecycle.test.ts
//
// The status×intent state machine (runtime/lifecycle.ts). Every LEGAL event
// from every valid from-status lands the documented (status, intent), and every
// ILLEGAL move throws — illegal states are unrepresentable. This IS the old
// markCleanExitDone guard + the dozen scattered setStatus/setIntent pairs, now
// table-driven. All assertions read back through getNode() (the hydrated view).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, setStatus, setIntent } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { transition } from '../runtime/lifecycle.js';
import type { NodeMeta, NodeStatus, ExitIntent } from '../canvas/types.js';

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

/** Create a node forced into a precise (status, intent) start state. */
function mk(id: string, status: NodeStatus, intent: ExitIntent = null): void {
  createNode(node(id));
  setStatus(id, status);
  setIntent(id, intent);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-lifecycle-'));
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

const ALL: NodeStatus[] = ['active', 'idle', 'done', 'dead', 'canceled'];
const LIVE: NodeStatus[] = ['active', 'idle'];
const TERMINAL: NodeStatus[] = ['done', 'dead', 'canceled'];

// ---------------------------------------------------------------------------
// finalize → done + intent='done', legal only from active|idle
// ---------------------------------------------------------------------------
test('finalize: active|idle → done + intent=done', () => {
  for (const from of LIVE) {
    mk(`n_${from}`, from, 'refresh');
    const m = transition(`n_${from}`, 'finalize');
    assert.equal(m.status, 'done', `finalize from ${from}`);
    assert.equal(m.intent, 'done', `finalize from ${from} sets intent=done`);
  }
});
test('finalize: illegal from done|dead|canceled → throws, status untouched', () => {
  for (const from of TERMINAL) {
    mk(`n_${from}`, from);
    assert.throws(() => transition(`n_${from}`, 'finalize'), /illegal lifecycle transition/);
    assert.equal(getNode(`n_${from}`)?.status, from, `${from} unchanged on illegal finalize`);
  }
});

// ---------------------------------------------------------------------------
// reap → done + intent cleared, legal from ANY status (forced teardown)
// ---------------------------------------------------------------------------
test('reap: any status → done + intent cleared', () => {
  for (const from of ALL) {
    mk(`n_${from}`, from, 'refresh');
    const m = transition(`n_${from}`, 'reap');
    assert.equal(m.status, 'done', `reap from ${from}`);
    assert.equal(m.intent, null, `reap from ${from} clears intent`);
  }
});

// ---------------------------------------------------------------------------
// cancel → canceled + intent cleared, legal from ANY status
// ---------------------------------------------------------------------------
test('cancel: any status → canceled + intent cleared', () => {
  for (const from of ALL) {
    mk(`n_${from}`, from, 'idle-release');
    const m = transition(`n_${from}`, 'cancel');
    assert.equal(m.status, 'canceled', `cancel from ${from}`);
    assert.equal(m.intent, null, `cancel from ${from} clears intent`);
  }
});

// ---------------------------------------------------------------------------
// crash → dead, intent UNCHANGED, legal only from active|idle
// ---------------------------------------------------------------------------
test('crash: active|idle → dead, intent preserved', () => {
  for (const from of LIVE) {
    mk(`n_${from}`, from, 'refresh');
    const m = transition(`n_${from}`, 'crash');
    assert.equal(m.status, 'dead', `crash from ${from}`);
    assert.equal(m.intent, 'refresh', `crash from ${from} leaves intent untouched`);
  }
});
test('crash: illegal from done|dead|canceled → throws', () => {
  for (const from of TERMINAL) {
    mk(`n_${from}`, from);
    assert.throws(() => transition(`n_${from}`, 'crash'), /illegal lifecycle transition/);
  }
});

// ---------------------------------------------------------------------------
// yield → intent='refresh', status UNCHANGED, legal only from active|idle
// ---------------------------------------------------------------------------
test('yield: active|idle → intent=refresh, status preserved', () => {
  for (const from of LIVE) {
    mk(`n_${from}`, from);
    const m = transition(`n_${from}`, 'yield');
    assert.equal(m.status, from, `yield from ${from} keeps status`);
    assert.equal(m.intent, 'refresh', `yield from ${from} sets intent=refresh`);
  }
});
test('yield: illegal from done|dead|canceled → throws', () => {
  for (const from of TERMINAL) {
    mk(`n_${from}`, from);
    assert.throws(() => transition(`n_${from}`, 'yield'), /illegal lifecycle transition/);
  }
});

// ---------------------------------------------------------------------------
// release → idle + intent='idle-release', legal only from active|idle
// ---------------------------------------------------------------------------
test('release: active|idle → idle + intent=idle-release', () => {
  for (const from of LIVE) {
    mk(`n_${from}`, from);
    const m = transition(`n_${from}`, 'release');
    assert.equal(m.status, 'idle', `release from ${from}`);
    assert.equal(m.intent, 'idle-release', `release from ${from} sets intent=idle-release`);
  }
});
test('release: illegal from done|dead|canceled → throws', () => {
  for (const from of TERMINAL) {
    mk(`n_${from}`, from);
    assert.throws(() => transition(`n_${from}`, 'release'), /illegal lifecycle transition/);
  }
});

// ---------------------------------------------------------------------------
// revive → active + intent cleared, legal from ANY status (the universal "back")
// ---------------------------------------------------------------------------
test('revive: any status → active + intent cleared', () => {
  for (const from of ALL) {
    mk(`n_${from}`, from, 'idle-release');
    const m = transition(`n_${from}`, 'revive');
    assert.equal(m.status, 'active', `revive from ${from}`);
    assert.equal(m.intent, null, `revive from ${from} clears intent`);
  }
});

// ---------------------------------------------------------------------------
// boot → active, intent UNCHANGED (reviveInPlace keeps the refresh safety net),
// legal only from active|idle
// ---------------------------------------------------------------------------
test('boot: active|idle → active, intent preserved (refresh net survives)', () => {
  for (const from of LIVE) {
    mk(`n_${from}`, from, 'refresh');
    const m = transition(`n_${from}`, 'boot');
    assert.equal(m.status, 'active', `boot from ${from}`);
    assert.equal(m.intent, 'refresh', `boot from ${from} keeps intent (proof-of-boot net)`);
  }
});
test('boot: illegal from done|dead|canceled → throws', () => {
  for (const from of TERMINAL) {
    mk(`n_${from}`, from);
    assert.throws(() => transition(`n_${from}`, 'boot'), /illegal lifecycle transition/);
  }
});

// ---------------------------------------------------------------------------
// unknown node → throws for every event
// ---------------------------------------------------------------------------
test('transition on an unknown node throws', () => {
  for (const ev of ['finalize', 'reap', 'cancel', 'crash', 'yield', 'release', 'revive', 'boot'] as const) {
    assert.throws(() => transition('ghost', ev), /unknown node/);
  }
});
