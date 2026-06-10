// Run with: node --import tsx/esm --test src/core/__tests__/broker-crash-teardown.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.3 + §E). Broker crash / teardown / boot-
// failure — acceptance items 4–6 of the headless-broker migration plus the
// M-1/M-2 boot-failure regression — run in the FAST tier (no tmux, no hasTmux()
// gate). Boot budget is minimized: the crash + teardown items genuinely exercise
// a real broker PROCESS so they share ONE spawn + ONE grace-revive (2 boots); the
// boot-failure lock is PURE daemon logic, so it is fabricated with ZERO boots.
//
// (1) BUG LOCKED — two locks:
//     • items 4–6: a CRASHED broker (pid killed out from under the daemon) must
//       grace-revive RESUMING the saved .jsonl, ONE-WRITER (the crashed pid is
//       dead BEFORE the revive launches and never resurrects; the revived pid is
//       distinct); and a clean `node close` tears the broker down (shutdown frame
//       → exit, socket unlinked, status canceled, daemon leaves it).
//     • M-1/M-2: a broker that DIES before session_start records NO pid and NO
//       session EVER. Read pid==null unconditionally as "still booting" and the
//       node strands 'active' with no engine FOREVER and its parent waits on a
//       dead child. The daemon must instead, after REVIVE_GRACE_MS with still no
//       pid AND no session, crash it (→ dead) and surface a boot-failure push up
//       the spine (handleBrokerLiveness, crtrd.ts).
//
// (2) WHY MODEL-LEVEL vs A REAL BOOT — the M-1/M-2 grace-surface is pure daemon
//     logic: pid==null && pi_session_id==null past the boot grace → transition
//     ('crash') + surfaceBootFailure → pushUrgent fanned to the active parent.
//     A broker is supervised purely by its row (pi_pid/pi_session_id), so this is
//     fabricated DIRECTLY — a parent-subscribed broker row with NO pid and NO
//     session, ticked across the grace boundary — with ZERO real boots and no
//     crashing subprocess at all. The crash/teardown items, by contrast, ARE the
//     broker process under test (a real pid to kill, a real socket to unlink), so
//     they pay one real spawn + the grace-revive boot.
//
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE BUG REGRESSES — for crash/teardown,
//     an early revive (no grace) would land a second writer in the respawn gap, or
//     a broken teardown would leave the socket / pid alive — the one-writer / socket
//     / canceled asserts go RED. For M-1/M-2, remove the grace-surface branch (read
//     pid==null as "still booting" forever) and the fabricated node NEVER goes
//     'dead' and the parent NEVER receives the notice → the boot-failure asserts go
//     RED. Verified by reverting that branch (see bug-injection report).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { createHarness, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { isPidAlive } from '../canvas/pid.js';

// crtrd.ts module const (not exported): the fresh-pi-boot grace window the daemon
// waits before grace-reviving / boot-failing a pi observed dead. Reference:
// crtrd.ts `REVIVE_GRACE_MS = 20_000`.
const REVIVE_GRACE_MS = 20_000;

let h: Harness;
let root: string;

before(async () => {
  h = await createHarness({ headless: true, sessionPrefix: 'crtr-brkcrash' });
  root = h.spawnRoot('broker-crash suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Items 4 + 5 + 6 — one real broker lifecycle, ONE spawn + ONE grace-revive:
//   crash → grace-revive RESUME (one-writer) → close → clean teardown.
// ===========================================================================
test('CRASH → grace-revive RESUME (one-writer), then clean teardown on close', async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — crash+teardown');
  const oldPid = h.node(id)!.pi_pid!;
  assert.equal(isPidAlive(oldPid), true, 'broker alive before the crash');
  assert.equal(h.node(id)!.intent ?? null, null, 'fresh broker has a null intent (not refresh/idle-release)');
  const boots = h.bootCount(id);

  // --- Items 4 + 6: kill the broker out from under the daemon (a crash). Drive a
  //     FIXED clock so the grace window is exercised deterministically. ---
  process.kill(oldPid, 'SIGKILL');
  await h.waitFor(() => !isPidAlive(oldPid), { label: 'crashed broker pid is dead' });
  // ONE-WRITER: the old engine pid is dead BEFORE any revive can launch.
  assert.equal(isPidAlive(oldPid), false, 'crashed pid dead before the daemon revives');

  const NOW = 5_000_000;
  await h.tick(NOW); // pid dead, intent null → handleBrokerLiveness → handleLiveWindow marks pending
  assert.equal(h.bootCount(id), boots, 'inside the grace window → NOT yet revived');

  await h.tick(NOW + REVIVE_GRACE_MS + 1); // grace elapsed → reviveNode(resume:true)
  const boot2 = await h.awaitBoot(id, { minCount: boots + 1 });
  assert.equal(boot2.resuming, true, 'grace-revive RESUMES the saved .jsonl');

  const newPid = h.node(id)!.pi_pid!;
  assert.ok(newPid != null && isPidAlive(newPid), 'the revived broker pid is alive');
  assert.notEqual(newPid, oldPid, 'the revived pid is distinct from the crashed one');
  assert.equal(isPidAlive(oldPid), false, 'one-writer: the crashed pid never resurrected');

  // --- Item 5: clean teardown of the (revived, live) broker. node close marks
  //     canceled BEFORE teardown (crash-safe order), then hostFor(broker).teardown
  //     sends the `shutdown` frame → the broker disposes + exits, socket unlinked. ---
  const sock = h.brokerSock(id);
  await h.waitFor(() => existsSync(sock), { label: 'revived broker created its view.sock' });

  const res = h.cli(root, ['node', 'close', '--node', id]);
  assert.equal(res.code, 0, `node close should exit 0\n--stderr--\n${res.stderr}`);

  await h.waitFor(() => !isPidAlive(newPid), { label: 'broker process exited on shutdown frame' });
  await h.waitFor(() => !existsSync(sock), { label: 'broker unlinked its socket on exit' });
  assert.equal(h.status(id), 'canceled', 'the closed node is canceled');

  // listNodes only surfaces active|idle, so a canceled broker is never supervised.
  await h.tick();
  assert.equal(h.status(id), 'canceled', 'still canceled after a daemon tick');
  assert.equal(isPidAlive(newPid), false, 'the broker stays dead — never revived');
});

// ===========================================================================
// M-1 / M-2 — a broker that DIES before session_start (NO pid, NO session EVER)
// must be grace-surfaced as a boot failure, not stranded 'active' forever.
// PURE MODEL DRIVE: fabricate the exact strand state directly + a parent
// subscription, tick across the boot grace, assert crash + the up-spine push.
// ZERO real boots — no crashing subprocess needed.
// ===========================================================================
test('boot failure — a broker that never records a pid/session is grace-surfaced, not stranded (review M-1/M-2)', async () => {
  // The exact "never booted" strand: status=active, NO pid, NO session ever
  // (pi_session_id null routes the boot-failure branch, NOT relaunch-in-flight).
  const id = h.fabricateBrokerNode({
    parent: root,
    status: 'active',
    intent: null,
    pi_pid: null,
    pi_session_id: null,
  });
  // The parent is an ACTIVE subscriber of the child (what spawn auto-wires), so
  // surfaceBootFailure's pushUrgent reaches it on its inbox.
  subscribe(root, id, true);

  {
    const n0 = h.node(id)!;
    assert.equal(n0.host_kind, 'broker', 'broker-hosted (paneless)');
    assert.equal(n0.pi_pid ?? null, null, 'no broker pid was ever recorded');
    assert.equal(n0.pi_session_id ?? null, null, 'no session was ever recorded');
    assert.equal(n0.status, 'active', 'starts stranded active');
  }

  // Inside the boot grace the daemon LEAVES it (could be the sub-second boot gap):
  // tick 1 starts the boot-grace clock, tick 2 still within grace.
  const NOW = 9_000_000;
  await h.tick(NOW);
  assert.equal(h.status(id), 'active', 'first observation → boot-grace clock started, left active');
  await h.tick(NOW + 10_000);
  assert.equal(h.status(id), 'active', 'inside the boot grace → daemon leaves it (boot gap)');

  // Past the boot grace with STILL no pid and no session → crash + boot failure.
  await h.tick(NOW + REVIVE_GRACE_MS + 1);
  assert.equal(h.status(id), 'dead', 'a never-booted broker is reaped, not stranded active forever');

  // …and the parent (an active subscriber of the child) was told up the spine.
  const note = h.inbox(root).find((e) => /never started/.test(e.label ?? ''));
  assert.ok(note !== undefined, 'the parent received a boot-failure notice up the spine');
  assert.equal(note!.tier, 'urgent', 'the boot-failure notice is urgent');
});
