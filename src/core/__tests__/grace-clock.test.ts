// Run with: node --import tsx/esm --test src/core/__tests__/grace-clock.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.10 + §E). Drives a broker-hosted
// (paneless) node fabricated DIRECTLY in the canvas — no real tmux session, no
// remain-on-exit pane, and NO real broker boot. The grace decision is pure
// daemon logic, so the test never pays the ~5s SDK-boot cost.
//
// (1) BUG LOCKED — the REVIVE_GRACE_MS double-spawn guard (daemon invariant 10,
//     MINOR-4). A node whose engine pid is observed DEAD must pend through the
//     REVIVE_GRACE_MS window before the daemon revives it; revive too early and
//     it lands in the transient old-pi-dies→fresh-pi-boots gap and DOUBLE-SPAWNS
//     a second vehicle on the same .jsonl.
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — the guard lives entirely in pure daemon
//     logic: livenessVerdict(piPidAlive,deadFor) → REVIVE_GRACE_MS → the
//     unhealthySince clock → revivedThisTick (crtrd.ts). For a broker the dead-pid
//     path routes handleBrokerLiveness → handleLiveWindow VERBATIM (intent is
//     neither refresh nor idle-release), exercising the SAME grace machinery as a
//     tmux node. A broker is supervised purely by row.pi_pid, so a fabricated row
//     carrying a known-DEAD pid + a recorded pi_session_id (so it routes the
//     crash/grace path, NOT the never-booted boot-failure branch) reproduces the
//     exact "dead but supervised" state with no process at all.
//
// (3) HOW THE FABRICATED DRIVE STILL FAILS IF THE BUG REGRESSES — we walk
//     h.tick(now) across the grace boundary with a deterministic clock and assert
//     getNode(B).cycles (reviveNode bumps cycles + runs transition('revive')
//     BEFORE it spawns — revive.ts:114,145 — so a revive's model effect is
//     observable INSTANTLY, no awaitBoot needed). If the pending branch is removed
//     (revive fires on first-observed-dead), the WITHIN-GRACE tick revives →
//     cycles bumps early → the "cycles unchanged" asserts go RED. Verified by
//     reverting livenessVerdict's `deadFor < REVIVE_GRACE_MS` pending branch
//     (see bug-injection report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../../daemon/crtrd.js';

// A pid that is reaped (dead) by the time spawnSync returns — the "dead but
// supervised" pid the grace path judges.
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe; // fall back to an implausibly-high pid
}

// REVIVE_GRACE_MS is 20_000 (crtrd.ts). We choose offsets well inside / well
// past it so the test is robust to the exact value without importing it.
const NOW = 5_000_000;
const WITHIN_GRACE = NOW + 10_000; // < 20s after first-observed-dead → still pending
const PAST_GRACE = NOW + 25_000; //  > 20s after first-observed-dead → revive

// ===========================================================================
// The grace window guards against a double-spawn: while a node's engine pid has
// been observed dead for LESS than REVIVE_GRACE_MS, the daemon must NOT revive
// (a revive there would race the in-flight respawn and spawn a second vehicle on
// the same conversation). Once the pid has been dead PAST the grace, a revive
// proceeds and cycles advances.
// ===========================================================================
test(
  'grace clock: a dead-pi broker does NOT revive within REVIVE_GRACE_MS, but DOES once it elapses',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHarness({ headless: true, sessionPrefix: 'crtr-grace' });
    try {
      const dead = deadPid();
      assert.equal(isPidAlive(dead), false, 'fabrication precondition: the supervised pid is dead');

      // Fabricate the EXACT "dead but supervised" broker state directly — no
      // boot. pi_session_id is SET so handleBrokerLiveness routes the crash/grace
      // path (handleLiveWindow), NOT the never-booted boot-failure branch; intent
      // is null so it is neither the refresh nor the idle-release early-return.
      const B = h.fabricateBrokerNode({
        kind: 'developer',
        status: 'active',
        intent: null,
        pi_pid: dead,
        pi_session_id: 'sess-grace-B',
      });
      const b0 = h.node(B)!;
      assert.equal(b0.host_kind, 'broker', 'B is broker-hosted (paneless)');
      assert.equal(b0.status, 'active', 'B active');
      assert.equal(b0.intent ?? null, null, 'B intent=null (the grace path, not the idle-release early-return)');
      assert.equal(b0.pi_pid, dead, 'row pi_pid == the known-dead pid');
      assert.equal(b0.window ?? null, null, 'no tmux window — broker host');
      assert.equal(b0.cycles ?? 0, 0, 'no revive yet — cycles at 0');

      // --- TICK 1 @ NOW: first observation of the dead pid → 'pending'. The
      //     daemon records first-observed-dead and does NOT revive. ---
      await h.tick(NOW);
      {
        const b = h.node(B)!;
        assert.equal(b.cycles ?? 0, 0, 'first tick: NO revive on first-observed-dead (cycles still 0)');
        assert.equal(b.pi_pid, dead, 'pi_pid unchanged — no fresh vehicle launched');
        assert.equal(b.status, 'active', 'B left active (pending, not revived)');
      }

      // --- TICK 2 @ NOW+10s (WITHIN the 20s grace): STILL pending. This is the
      //     double-spawn guard: a revive here would land in the respawn gap. ---
      await h.tick(WITHIN_GRACE);
      {
        const b = h.node(B)!;
        assert.equal(
          b.cycles ?? 0,
          0,
          'within REVIVE_GRACE_MS: NO double-spawn — the dead pi must pend, not revive (cycles still 0)',
        );
        assert.equal(b.pi_pid, dead, 'pi_pid STILL the dead pid — guard held');
        assert.equal(b.status, 'active', 'B still active inside the grace window');
      }

      // --- TICK 3 @ NOW+25s (PAST the 20s grace): now a revive proceeds —
      //     reviveNode bumps cycles + transition('revive') BEFORE the (detached,
      //     unawaited) broker spawn, so the model effect is visible immediately. ---
      await h.tick(PAST_GRACE);
      {
        const b = h.node(B)!;
        assert.equal(b.cycles ?? 0, 1, 'past REVIVE_GRACE_MS: the dead pi is revived → cycles bumped to 1');
        assert.equal(b.status, 'active', 'B active after the grace-window revive (transition(revive))');
        assert.equal(b.intent ?? null, null, 'intent cleared by the revive');
        assert.equal(b.pi_pid ?? null, null, 'pi_pid cleared by the window-backed revive (clearPid)');
      }
    } finally {
      await h.dispose();
    }
  },
);
