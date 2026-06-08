// Run with: node --import tsx/esm --test src/core/__tests__/wake-bearings.test.ts
//
// Wake-origin self-knowledge (the <crtr-wake> provenance block). Regression
// guard for the observed gap: a node woken or BORN by a scheduled TIMER could
// not tell it came from a timer — a scheduled wake arrived indistinguishable
// from an ordinary refresh/message (the Invariant B/D anti-goal). These lock:
//   • buildWakeBearings renders the right decision-first block per wake kind /
//     cadence, and never crashes when the armer was reaped (no resolved name);
//   • the bare-wake revive kickoff carries that block (so a scheduled alarm is
//     distinguishable from a generic context-refresh), placed AFTER the kickoff
//     sentinel (goal-capture keys on it) and BEFORE the roadmap/disk bearings;
//   • an ordinary fresh revive (no wakeReason) carries NO block.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta } from '../canvas/types.js';
import { buildWakeBearings, type WakeOrigin } from '../runtime/bearings.js';
import {
  buildReviveKickoff,
  drainBearings,
  REVIVE_KICKOFF_SENTINEL,
} from '../runtime/kickoff.js';

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

const ARMED = '2026-06-08T13:30:00.000Z';

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-wake-bearings-'));
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

// --- buildWakeBearings: one per kind / cadence variant ----------------------

test('spawn one-shot: names a deferred birth + the armer, and says it does not recur', () => {
  const o: WakeOrigin = {
    kind: 'spawn',
    ownerId: 'arm-1',
    ownerName: 'release-orch',
    armedAt: ARMED,
    recur: null,
  };
  const b = buildWakeBearings(o);
  assert.ok(b.startsWith('<crtr-wake>') && b.endsWith('</crtr-wake>'));
  assert.match(b, /BORN by a scheduled wake/);
  assert.match(b, /deferred birth/);
  // Armer named ROLE-explicitly so the newborn never reads the id as its own.
  assert.match(b, /armed by node arm-1 \("release-orch"\)/);
  assert.match(b, /only run, not a recurring job/);
  assert.match(b, /Your task follows\./);
});

test('spawn cron: surfaces the cadence + frames it as one run of a standing job', () => {
  const o: WakeOrigin = {
    kind: 'spawn',
    ownerId: 'arm-1',
    ownerName: 'nightly',
    armedAt: ARMED,
    recur: JSON.stringify({ cron: '0 9 * * *', tz: 'America/New_York' }),
  };
  const b = buildWakeBearings(o);
  assert.match(b, /recurring spawn-cron armed by node arm-1 \("nightly"\)/);
  // The cadence renders via the shared cadenceDisplay (matches `wake list`).
  assert.match(b, /firing cron `0 9 \* \* \*` \(America\/New_York\)/);
  assert.match(b, /one run of a standing job, not a one-off/);
  assert.match(b, /inherit nothing from prior runs but this task/);
});

test('spawn interval cron: renders the every-N cadence', () => {
  const o: WakeOrigin = {
    kind: 'spawn',
    ownerId: 'arm-1',
    ownerName: 'poller',
    armedAt: ARMED,
    recur: JSON.stringify({ every: '6h' }),
  };
  assert.match(buildWakeBearings(o), /firing every 6h/);
});

test('spawn with a reaped armer: renders the bare id, no name, never crashes', () => {
  const o: WakeOrigin = {
    kind: 'spawn',
    ownerId: 'gone-9',
    ownerName: undefined, // armer no longer exists → no resolved name
    armedAt: ARMED,
    recur: JSON.stringify({ every: '12h' }),
  };
  const b = buildWakeBearings(o);
  assert.match(b, /armed by node gone-9 \(now gone\)/); // bare id, flagged reaped
  assert.doesNotMatch(b, /\("/); // never an empty/dangling name
});

test('bare one-shot: frames a timed re-check, NOT a new request', () => {
  const o: WakeOrigin = { kind: 'bare', ownerId: 'n1', ownerName: 'n1', armedAt: ARMED, recur: null };
  const b = buildWakeBearings(o);
  assert.match(b, /a scheduled alarm fired/);
  assert.match(b, /a timer, NOT a new message or request/);
  assert.match(b, /timed re-check, not a new task/);
  assert.match(b, /re-read your roadmap/);
  // No armer attribution on bare (could be `--node`-armed by another), no ISO.
  assert.doesNotMatch(b, /you set/);
  assert.doesNotMatch(b, new RegExp(ARMED));
});

test('bare recurring: frames one tick of a standing re-check + the cadence', () => {
  const o: WakeOrigin = {
    kind: 'bare',
    ownerId: 'n1',
    ownerName: 'n1',
    armedAt: ARMED,
    recur: JSON.stringify({ every: '6h' }),
  };
  const b = buildWakeBearings(o);
  assert.match(b, /recurring scheduled alarm fired \(every 6h\)/);
  assert.match(b, /one tick of a standing re-check/);
});

// --- the bare-wake revive seam (Seam 2) -------------------------------------

test('a bare scheduled wake makes the fresh-revive kickoff distinguishable from a refresh', () => {
  const id = 'b1';
  const meta = createNode(node(id));
  const wakeReason: WakeOrigin = {
    kind: 'bare',
    ownerId: id,
    ownerName: id,
    armedAt: ARMED,
    recur: null,
  };
  const msg = buildReviveKickoff(meta, drainBearings(meta), wakeReason);

  // The block is present, and the kickoff STILL starts with the sentinel that
  // goal-capture keys on (so the prompt is never mistaken for a user mandate).
  assert.ok(msg.startsWith(REVIVE_KICKOFF_SENTINEL), 'kickoff still leads with the sentinel');
  assert.match(msg, /<crtr-wake>/);
  assert.match(msg, /a scheduled alarm fired/);

  // Placement: sentinel < <crtr-wake> < <roadmap> — "why you woke" precedes
  // "what to rebuild from".
  const iSentinel = msg.indexOf(REVIVE_KICKOFF_SENTINEL);
  const iWake = msg.indexOf('<crtr-wake>');
  const iRoadmap = msg.indexOf('<roadmap');
  assert.ok(iSentinel === 0 && iSentinel < iWake && iWake < iRoadmap, 'block sits after sentinel, before roadmap');
});

test('an ordinary fresh revive (no wakeReason) carries NO wake block', () => {
  const id = 'b2';
  const meta = createNode(node(id));
  const msg = buildReviveKickoff(meta, drainBearings(meta));
  assert.doesNotMatch(msg, /<crtr-wake>/);
});
