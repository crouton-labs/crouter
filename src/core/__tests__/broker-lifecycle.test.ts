// Run with: node --import tsx/esm --test src/core/__tests__/broker-lifecycle.test.ts
//
// The broker-backed lifecycle suite — the acceptance-gate proof of the headless-
// broker migration (plan T11). It drives the REAL `crtr` CLI into an isolated
// REAL tmux session and spawns `--headless` nodes onto the REAL headless broker
// host (host.ts), which boots a REAL detached broker PROCESS (broker.ts) per
// node. The broker hosts a fake SDK engine (fixtures/fake-engine.ts) loaded via
// the CRTR_BROKER_ENGINE seam — NOTHING in the broker, the host, the stophook,
// the inbox-watcher, the stop-guard, or the daemon (superviseTick) is mocked.
// Every assertion reads straight off the canvas data layer.
//
// The suite is SPLIT across sibling files (one isolated harness each) so
// node:test's file-level parallelism applies — the tests themselves are the
// original acceptance gate, unchanged:
//   THIS FILE                        — items 1–2 + 3 (LIVE): spawn, LIVE wake
//   broker-dormant-wake.test.ts      — item 3 (DORMANT): idle-release → daemon revive
//   broker-crash-teardown.test.ts    — items 4–6 + M-1/M-2: crash, teardown, boot failure
//   broker-dialogs.test.ts           — §5.4 C2 + gates G5/G5b/G6 (dialogs)
//   broker-attach-stream.test.ts     — gates G1/G1b/G2/G3 (drive + relay + snapshot)
//   broker-attach-limits.test.ts     — gates G4/G7/G8/G9 (arbitration + caps + one-writer)
//
// Acceptance items (plan §4) → the asserting test:
//   1 spawn --headless → host_kind='broker', null placement, live broker pid     → "spawn"
//   2 supervised by broker-pid signal-0 (stophook recordPid = broker pid)         → "spawn"
//   3 inbox wakes LIVE (in-broker watcher) AND DORMANT (idle-release → daemon)    → "live wake" here + "dormant wake" (broker-dormant-wake.test.ts)
//   7 tmux stays default — the existing suite passes UNMODIFIED (this split only
//     MOVES tests between files + extracts harness wiring; nothing is rewritten).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { appendInbox } from '../feed/inbox.js';
import { isPidAlive } from '../canvas/pid.js';

let h: Harness;
let root: string;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-broker' });
  root = h.spawnRoot('broker-suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Item 1 + 2 — spawn --headless: broker host, NULL placement, a live broker pid
// that IS the daemon's supervision signal (stophook recordPid(process.pid)).
// ===========================================================================
test('spawn --headless → broker host_kind, null placement, live broker pid; daemon leaves a healthy broker', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — spawn');
  const node = h.node(id)!;

  // Item 1: the broker host + a paneless placement.
  assert.equal(node.host_kind, 'broker', "host_kind === 'broker'");
  assert.equal(node.window ?? null, null, 'window is NULL (paneless broker)');
  assert.equal(node.pane ?? null, null, 'pane is NULL (paneless broker)');
  assert.equal(node.tmux_session ?? null, null, 'tmux_session is NULL (paneless broker)');
  assert.ok(node.pi_pid != null, 'a broker pid was recorded as pi_pid');
  assert.equal(isPidAlive(node.pi_pid), true, 'the broker pid is alive');

  // Item 2: the supervision signal IS the broker pid — the stophook recorded
  // process.pid (the broker's own pid) on session_start, == the boot proof pid.
  const boot = await h.awaitBoot(id);
  assert.equal(boot.pid, node.pi_pid, 'boot-proof pid (broker process.pid) === supervised pi_pid');

  // The daemon supervises it by that pid alone: a healthy broker is left untouched.
  const before = h.bootCount(id);
  await h.tick();
  assert.equal(h.status(id), 'active', 'a healthy broker stays active across a daemon tick');
  assert.equal(h.node(id)!.pi_pid, node.pi_pid, 'pid unchanged — not revived');
  assert.equal(h.bootCount(id), before, 'no reboot');
  assert.equal(isPidAlive(node.pi_pid), true, 'broker still alive');
});

// ===========================================================================
// Item 3 (LIVE) — the in-broker inbox-watcher delivers an inbox push WITHOUT an
// exit or revive (the broker stays alive; pi.sendUserMessage → injected).
// ===========================================================================
test('LIVE wake — in-broker watcher injects an inbox push with no exit/revive', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — live wake');
  const pid = h.node(id)!.pi_pid!;
  const boots = h.bootCount(id);

  appendInbox(id, { from: 'tester', tier: 'normal', kind: 'message', label: 'live-wake', data: { body: 'do this live' } });

  // The REAL in-broker watcher (800ms poll + 1000ms debounce) delivers via
  // pi.sendUserMessage → fake-pi.injected.jsonl.
  await h.awaitWake(id, { match: /do this live/, timeoutMs: 15_000 });

  // No exit, no revive: same broker pid, still alive, no new boot.
  assert.equal(h.bootCount(id), boots, 'no new boot — the live broker was not revived');
  assert.equal(h.node(id)!.pi_pid, pid, 'pi_pid unchanged — the broker never exited');
  assert.equal(isPidAlive(pid), true, 'the broker is still alive after the live wake');
});

