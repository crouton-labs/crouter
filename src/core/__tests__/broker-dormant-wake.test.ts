// Run with: node --import tsx/esm --test src/core/__tests__/broker-dormant-wake.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.5 + §E). Acceptance item 3 (DORMANT) of
// the headless-broker migration, fabricated DIRECTLY in the canvas — no real
// tmux session, no pane chrome, and NO real broker boot. The wake decision is
// pure daemon logic, so the test never pays the ~5s SDK-boot cost.
//
// (1) BUG LOCKED — Invariant D (idle-release dormancy). A node that naturally
//     stops while awaiting a LIVE subscription idle-RELEASES its broker (the
//     broker process exits); the daemon's SECOND PASS must revive it (RESUME)
//     the moment an UNSEEN inbox entry appears. Without the second pass a dormant
//     orchestrator never wakes on a worker's message and the graph deadlocks.
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — every step is canvas/daemon state: the
//     dormant state is status=idle / intent=idle-release / pi_pid dead (a
//     released broker is a dead pid, the headless analog of a closed pane), and
//     superviseTick's second pass gates on status===idle && intent===idle-release
//     && !isPidAlive(pi_pid) && readInboxSince>cursor → reviveNode(resume). No
//     pane is read anywhere; a broker is supervised purely by pid, so a
//     fabricated row reproduces the exact dormant state with no process at all.
//
// (3) HOW THE FABRICATED DRIVE STILL FAILS IF THE BUG REGRESSES — pass 1: a tick
//     with NO unseen inbox must NOT revive (cycles unchanged) — the idle-release
//     early-return. Then we appendInbox an unseen entry and tick again; pass 2's
//     reviveNode bumps cycles + transition('revive') BEFORE the (detached,
//     unawaited) broker spawn, so the wake is observable instantly via cycles +
//     status. If the second-pass reviveNode is removed, the post-inbox tick never
//     bumps cycles → the "revived" asserts go RED. Verified by commenting the
//     second-pass reviveNode(resume) call (see bug-injection report).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, type Harness } from './helpers/harness.js';
import { appendInbox } from '../feed/inbox.js';

let h: Harness;

before(async () => {
  h = await createHarness({ headless: true, sessionPrefix: 'crtr-brkdorm' });
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// A pid that is reaped (dead) by the time spawnSync returns — a released
// broker's exited process.
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

// ===========================================================================
// Item 3 (DORMANT) — a node idle-RELEASED (its broker exited) is NOT revived by
// a bare tick, but the daemon's second pass revives it (RESUME) on the next
// unseen inbox entry.
// ===========================================================================
test('DORMANT wake — idle-release broker (pi dead) → daemon pass-2 reviveNode(resume) on unseen inbox', async () => {
  // Fabricate the post-release dormant state directly: status=idle,
  // intent=idle-release, a DEAD supervised pid, pi_session_id set (so the revive
  // RESUMES the saved session). No boot, no stop, no pane.
  const id = h.fabricateBrokerNode({
    status: 'idle',
    intent: 'idle-release',
    pi_pid: deadPid(),
    pi_session_id: 'sess-dorm',
  });
  {
    const n = h.node(id)!;
    assert.equal(n.host_kind, 'broker', 'broker-hosted (paneless)');
    assert.equal(n.status, 'idle', 'idle (released)');
    assert.equal(n.intent, 'idle-release', 'intent=idle-release');
    assert.equal(n.cycles ?? 0, 0, 'no revive yet');
  }

  // PASS 1 — a tick with NO unseen inbox must NOT revive: idle-release is
  // dormancy by choice; the daemon leaves it until an inbox entry arrives.
  await h.tick();
  assert.equal(h.node(id)!.cycles ?? 0, 0, 'no unseen inbox → NOT revived (idle-release left dormant)');
  assert.equal(h.node(id)!.status, 'idle', 'still idle after the empty tick');

  // PASS 2 — an unseen inbox entry + a tick → the daemon owns wake-on-message for
  // a dormant (pi-dead) broker: second pass → reviveNode(resume:true).
  appendInbox(id, { from: 'tester', tier: 'normal', kind: 'message', label: 'resume-me', data: { body: 'work after release' } });
  await h.tick();

  // reviveNode bumps cycles + transition('revive') BEFORE the (detached,
  // unawaited) broker spawn, so the wake is observable instantly.
  {
    const n = h.node(id)!;
    assert.equal(n.cycles ?? 0, 1, 'unseen inbox + tick → daemon pass-2 REVIVED (cycles bumped to 1)');
    assert.equal(n.status, 'active', 'revive → active (transition(revive))');
    assert.equal(n.intent ?? null, null, 'intent cleared by the revive');
  }
});
