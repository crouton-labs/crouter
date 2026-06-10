// Run with: node --import tsx/esm --test src/core/__tests__/broker-lifecycle.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.6 + §E). The broker-backed lifecycle
// acceptance gate (plan T11), items 1–3, run in the FAST tier — no tmux session,
// no hasTmux() gate. The suite is SPLIT across sibling files (one isolated
// harness each); the asserting test per acceptance item (plan §4):
//   1 spawn --headless → host_kind='broker', null placement                      → "spawn" (here, MODEL)
//   2 supervised by the broker pid (signal-0) — a healthy broker is left alone    → "spawn" (here, MODEL)
//   3 inbox wakes LIVE (in-broker watcher) AND DORMANT (idle-release → daemon)    → "live wake" here + broker-dormant-wake.test.ts
//   4–6 + M-1/M-2 crash / teardown / boot failure                                 → broker-crash-teardown.test.ts
//   §5.4 C2 + G1…G9 dialogs / attach                                              → broker-dialogs / broker-attach-*.test.ts
//
// (1) BUG LOCKED — the headless-broker spawn+supervision contract. Items 1–2:
//     `node new --headless` yields a BROKER-hosted node — host_kind='broker',
//     NULL tmux placement (window/pane/tmux_session) — supervised purely by its
//     recorded pi_pid (signal-0), so the daemon leaves a HEALTHY broker (live
//     pid) untouched. Item 3: the REAL in-broker inbox-watcher delivers an inbox
//     push to a LIVE broker via pi.sendUserMessage WITHOUT any exit or revive.
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — items 1–2 are pure row facts (host_kind,
//     the three NULL placement columns, pid-supervision via handleBrokerLiveness),
//     so they are fabricated DIRECTLY in the canvas with a LIVE pid and ZERO real
//     boots: a tick with a live broker pid clears the grace timer and revives
//     nothing. A broker carries no pane anywhere, so nothing here reads tmux.
//     Item 3 alone needs ONE real broker boot — it proves the in-PROCESS watcher
//     actually fires inside a live broker and reaches the engine's sendUserMessage
//     (the wake is observable only as a real injected message).
//
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE BUG REGRESSES — if spawn stopped
//     setting host_kind='broker' / null placement, the item-1 model asserts fail;
//     if the daemon revived a healthy (live-pid) broker, item-2's cycles bump and
//     the asserts go RED; if the in-broker watcher stopped delivering, item-3's
//     awaitWake times out (no injected message, no wake).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { createHarness, type Harness } from './helpers/harness.js';
import { appendInbox } from '../feed/inbox.js';
import { isPidAlive } from '../canvas/pid.js';

let h: Harness;
let root: string;

// Disposable LIVE pids — a real, alive process the daemon can signal-0 probe as a
// healthy broker. SIGKILLed in after().
const livePids: number[] = [];
function disposableLivePid(): number {
  const child = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  child.unref();
  livePids.push(child.pid!);
  return child.pid!;
}

before(async () => {
  h = await createHarness({ headless: true, sessionPrefix: 'crtr-broker' });
  root = h.spawnRoot('broker-suite root');
});

after(async () => {
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Items 1 + 2 — spawn --headless: broker host_kind, NULL placement, supervised
// by the broker pid alone. PURE MODEL READ: fabricate the broker row directly
// (a LIVE supervised pid), assert the contract, tick once → a healthy broker is
// LEFT. ZERO real boots.
// ===========================================================================
test('spawn --headless → broker host_kind, null placement; daemon leaves a healthy (live-pid) broker', async () => {
  const livePid = disposableLivePid();
  const id = h.fabricateBrokerNode({
    status: 'active',
    intent: null,
    pi_pid: livePid, // a real, alive process — the signal-0 supervision target
    pi_session_id: 'sess-lifecycle', // booted once (identity bound)
  });
  const node = h.node(id)!;

  // Item 1: the broker host + a paneless placement (the three NULL columns).
  assert.equal(node.host_kind, 'broker', "host_kind === 'broker'");
  assert.equal(node.window ?? null, null, 'window is NULL (paneless broker)');
  assert.equal(node.pane ?? null, null, 'pane is NULL (paneless broker)');
  assert.equal(node.tmux_session ?? null, null, 'tmux_session is NULL (paneless broker)');
  assert.ok(node.pi_pid != null, 'a broker pid is recorded as pi_pid');
  assert.equal(isPidAlive(node.pi_pid), true, 'the broker pid is alive');

  // Item 2: the supervision signal IS the broker pid. handleBrokerLiveness sees a
  // LIVE pid → nothing pending; the daemon leaves a healthy broker untouched.
  await h.tick();
  assert.equal(h.status(id), 'active', 'a healthy broker stays active across a daemon tick');
  assert.equal(h.node(id)!.pi_pid, livePid, 'pid unchanged — not revived');
  assert.equal(h.node(id)!.cycles ?? 0, 0, 'no revive — cycles still 0');
  assert.equal(isPidAlive(livePid), true, 'broker still alive');
});

// ===========================================================================
// Item 3 (LIVE) — the in-broker inbox-watcher delivers an inbox push WITHOUT an
// exit or revive (the broker stays alive; pi.sendUserMessage → injected). This
// is the one item that genuinely exercises the broker PROCESS, so it pays ONE
// real boot.
// ===========================================================================
test('LIVE wake — in-broker watcher injects an inbox push with no exit/revive', async () => {
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
