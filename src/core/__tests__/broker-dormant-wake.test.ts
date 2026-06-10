// Run with: node --import tsx/esm --test src/core/__tests__/broker-dormant-wake.test.ts
//
// Acceptance item 3 (DORMANT) of the headless-broker migration. Split out of
// broker-lifecycle.test.ts (see its header for the full file map); the test is
// the original acceptance gate, unchanged, on its own isolated harness.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { appendInbox } from '../feed/inbox.js';
import { isPidAlive } from '../canvas/pid.js';

let h: Harness;
let root: string;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-brkdorm' });
  // An active resident root: the spawn parent AND the live node a child can hold
  // an active subscription to (so its natural stop classifies 'awaiting').
  root = h.spawnRoot('broker-dormant suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Item 3 (DORMANT) — a natural stop while awaiting a live subscription idle-
// RELEASES the broker (it exits); the daemon's second pass revives it (RESUME)
// on the next unseen inbox entry.
// ===========================================================================
test('DORMANT wake — idle-release → broker exits → daemon pass-2 reviveNode(resume) on inbox', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — dormant wake');
  const pid = h.node(id)!.pi_pid!;

  // Give the (terminal) child an ACTIVE subscription to the LIVE root, so the
  // stop-guard classifies its natural stop as 'awaiting' (a dormant orchestrator
  // awaiting a worker) → the stophook idle-releases it (paneless → no focus).
  subscribe(id, root, true);

  await h.stop(id, 'stop');

  await h.waitForStatus(id, 'idle');
  assert.equal(h.node(id)!.intent, 'idle-release', 'awaiting + unfocused → idle-release');
  await h.waitFor(() => !isPidAlive(pid), { label: 'released broker process exited' });

  // Daemon owns wake-on-message for a dormant (pi-dead) broker: an unseen inbox
  // entry + a tick → pass 2 → reviveNode(resume:true) → a fresh broker boots.
  appendInbox(id, { from: 'tester', tier: 'normal', kind: 'message', label: 'resume-me', data: { body: 'work after release' } });
  await h.tick();

  const boot2 = await h.awaitBoot(id, { minCount: 2 });
  assert.equal(boot2.resuming, true, 'the dormant revive RESUMES the saved session');
  const newPid = h.node(id)!.pi_pid!;
  assert.ok(newPid != null && isPidAlive(newPid), 'the revived broker pid is alive');
  assert.notEqual(newPid, pid, 'the revived broker is a fresh process');
});
