// Run with: node --import tsx/esm --test src/core/__tests__/revive-all.test.ts
//
// REGRESSION LOCK — gh issue #9 (revive-all over the canvas). The heart of the
// feature is the SELECTION predicate `isDisconnected`: which nodes a one-shot
// "resume everything" sweep relaunches. Getting that wrong is the whole risk —
// too narrow strands survivors, too broad resurrects finished/closed
// conversations nobody asked to reopen, or double-spawns a live node.
//
// (1) WHY PURE, NOT TMUX — isDisconnected is a total function of (meta, isAlive
//     probe, scope): zero process, zero tmux, instant. The liveness probe is
//     injected so the alive/dead branch is exercised without a real pid. The
//     reviveAll orchestration over it is a thin select-then-reviveNode loop;
//     reviveNode is covered (double-spawn guard) by revive.test.ts.
//
// (2) THE INVARIANTS LOCKED:
//     - engine running (live pid) → NOT disconnected (never double-spawn).
//     - no resumable saved session (no pi_session_id AND no pi_session_file) →
//       NOT disconnected (nothing to resume).
//     - dead/crashed with a session → disconnected (swept by default).
//     - done/canceled (terminal-by-choice) → always excluded (no opt-in).
//     - kind:'human' (the human bridge, never a pi engine) → never disconnected.
//
// (3) HOW IT FAILS IF THE LOGIC REGRESSES — drop the terminal-by-choice guard
//     and the done/canceled exclusion asserts go RED; drop the session
//     requirement and the no-session assert goes RED; invert the liveness branch
//     and the live-pid assert goes RED.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { isDisconnected, TERMINAL_BY_CHOICE, listDisconnected } from '../runtime/revive-all.js';
import { createNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta, NodeStatus } from '../canvas/types.js';

const ALIVE = () => true;
const DEAD = () => false;

function meta(over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: 'n',
    name: 'n',
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    pi_pid: 1234,
    pi_session_id: 'uuid-1',
    pi_session_file: '/abs/sess.jsonl',
    ...over,
  };
}

// --- engine liveness branch -------------------------------------------------

test('a node whose engine is RUNNING (live pid) is NOT disconnected — never double-spawn', () => {
  assert.equal(isDisconnected(meta({ pi_pid: 1234 }), ALIVE), false);
});

test('a node whose engine is DEAD but has a saved session IS disconnected', () => {
  assert.equal(isDisconnected(meta({ pi_pid: 1234 }), DEAD), true);
});

test('a node with a null pid (never/ no longer recorded) and a session IS disconnected', () => {
  assert.equal(isDisconnected(meta({ pi_pid: null }), DEAD), true);
});

// --- resumable-session requirement -----------------------------------------

test('a dead node with NO resumable saved session is NOT disconnected', () => {
  assert.equal(
    isDisconnected(meta({ pi_session_id: null, pi_session_file: null }), DEAD),
    false,
  );
});

test('a session FILE alone (older node, no id) is enough to be disconnected', () => {
  assert.equal(isDisconnected(meta({ pi_session_id: null }), DEAD), true);
});

// --- terminal-by-choice scope ----------------------------------------------

for (const status of TERMINAL_BY_CHOICE) {
  test(`a dead-engine '${status}' node is EXCLUDED (terminal-by-choice, no opt-in)`, () => {
    assert.equal(isDisconnected(meta({ status: status as NodeStatus }), DEAD), false);
  });
}

test("a crashed 'dead' node is swept by default (a crash is involuntary, not terminal-by-choice)", () => {
  assert.equal(isDisconnected(meta({ status: 'dead' }), DEAD), true);
});

test("dormant 'idle' nodes with a saved session are swept by default", () => {
  assert.equal(isDisconnected(meta({ status: 'idle', intent: 'idle-release' }), DEAD), true);
});

// --- human-bridge carve-out -------------------------------------------------

test("kind:'human' rows (the human bridge, never a pi engine) are never disconnected", () => {
  assert.equal(isDisconnected(meta({ kind: 'human', pi_pid: null }), DEAD), false);
});

// --- listDisconnected over a live canvas (the sweep's selection) -------------
//
// Locks that the canvas-wide select returns EXACTLY the disconnected set against
// the REAL isPidAlive probe — a live-engine node (this process's pid) is kept
// out, a crashed one with a session is in, a done one is excluded. No broker is
// launched: listDisconnected is the side-effect-free preview the command gates on.

let home: string;

function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

function fabricate(id: string, over: Partial<NodeMeta>): void {
  createNode({
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    host_kind: 'broker',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    pi_session_id: 'uuid-' + id,
    ...over,
  });
  closeDb();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-revive-all-'));
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

test('listDisconnected returns EXACTLY the disconnected nodes (crashed-with-session), excluding live + done', () => {
  // disconnected: dead pid + a saved session.
  fabricate('crashed', { status: 'active', pi_pid: deadPid() });
  // connected: a LIVE engine pid (this process — read-only here) → excluded.
  fabricate('live', { status: 'active', pi_pid: process.pid });
  // terminal-by-choice: done + dead pid + session → excluded.
  fabricate('finished', { status: 'done', pi_pid: deadPid() });
  // no resumable session → excluded.
  fabricate('sessionless', { status: 'active', pi_pid: deadPid(), pi_session_id: null });

  const ids = listDisconnected().map((m) => m.node_id).sort();
  assert.deepEqual(ids, ['crashed'], 'only the crashed-with-session node is swept');
});
