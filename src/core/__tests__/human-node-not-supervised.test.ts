// Run with: node --import tsx/esm --test src/core/__tests__/human-node-not-supervised.test.ts
//
// BUG REGRESSION (issue #2 — "Headless node can't reach human-ask: human-kind
// TUI dies at boot"): a headless orchestrator's every `crtr human ask` node died
// at boot with "pi vehicle exited before the session came up".
//
// ROOT CAUSE: a kind:'human' row is NOT a broker-hosted agent node — it is a
// bookkeeping row for the `crtr human` bridge. Its decision/review TUI runs in a
// detached `crtr human _run` pane (NOT a pi engine), and the row's lifecycle is
// driven entirely by that worker's `pushFinal` (or `human cancel`). So it never
// records a `pi_pid` or `pi_session_id`. After the headless hard-cut made the
// broker the universal node host, superviseTick supervised EVERY active|idle row
// as a broker engine: it read the human row (pid==null, session==null) as a
// never-booted broker, waited out the boot grace, then crash'd it and fired
// surfaceBootFailure up the spine — killing the human prompt before the person
// could ever answer.
//
// THE FIX: superviseTick drops kind:'human' rows from all three passes. This
// drives the REAL daemon decision pass against a human row fabricated directly in
// an isolated home — two ticks spanning well past the boot grace, which is
// exactly what crashed it before the fix.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { superviseTick } from '../../daemon/crtrd.js';
import type { NodeMeta } from '../canvas/types.js';

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
  home = mkdtempSync(join(tmpdir(), 'crtr-human-not-supervised-'));
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

test('a kind:"human" bridge row is NEVER boot-failed by the daemon (it has no broker engine)', async () => {
  // The exact shape spawnNode({kind:'human'}) mints: active, host_kind broker,
  // but NO pi engine ever booted — so pi_pid and pi_session_id stay null.
  createNode(node('HUMAN', {
    kind: 'human',
    lifecycle: 'terminal',
    host_kind: 'broker',
    pi_pid: null,
    pi_session_id: null,
    intent: null,
  }));
  // The asking node is auto-subscribed to its human bridge node at spawn, so a
  // surfaceBootFailure (pushUrgent) would land in ASKER's inbox. Give it a booted
  // session so the daemon leaves IT alone — it is only here to catch a push.
  createNode(node('ASKER', { status: 'active', pi_session_id: 'booted' }));
  subscribe('ASKER', 'HUMAN', true);

  // Two ticks spanning WELL past the boot grace (REVIVE_GRACE_MS): tick 1 would
  // arm the boot-grace clock, tick 2 (far in the future) would fire the crash +
  // surfaceBootFailure. This is the precise sequence that killed every human-ask
  // node before the fix.
  const t0 = Date.now();
  await superviseTick(t0);
  await superviseTick(t0 + 10_000_000);

  assert.equal(getNode('HUMAN')!.status, 'active', 'human bridge row stays alive — never crash-reaped as a dead broker');
  assert.equal(
    readInboxSince('ASKER').length,
    0,
    'no surfaceBootFailure urgent push — the asker is never told its human prompt "never started"',
  );
});
