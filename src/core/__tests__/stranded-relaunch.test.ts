// Run with: node --import tsx/esm --test src/core/__tests__/stranded-relaunch.test.ts
//
// BUG-REGRESSION (observed 2026-06-15 on the live canvas). A broker-hosted node
// whose row carries pi_pid=NULL but pi_session_id SET was read by
// handleNodeLiveness as "a relaunch in flight — leave it" UNCONDITIONALLY, with
// no timeout. reviveNode clears pi_pid right after launch and the fresh engine
// re-records it within a tick or two — but a relaunch whose broker DIED in that
// gap (after the pid-clear, before re-record) never re-records, so the node sat
// 'active' with no engine FOREVER and its parent waited on a dead child. Six such
// stranded resident roots had accumulated and the daemon would never recover or
// reap any of them.
//
// THE FIX — give the pid==null + session-set case the SAME REVIVE_GRACE_MS boot
// grace as the never-booted case: a healthy relaunch always re-records its pid
// well inside the grace (and the pid-alive branch clears the clock); if the grace
// ELAPSES with still no pid, the relaunch is dead → grace-revive RESUME on the
// saved session. The 20s grace doubles as the double-spawn guard.
//
// WHY MODEL-LEVEL, NOT TMUX CHROME — the stranding lives entirely in pure daemon
// logic (the pid==null branch of handleNodeLiveness + the unhealthySince clock).
// A fabricated broker row carrying pi_pid=null + a recorded pi_session_id
// reproduces the exact stranded state with no process at all; h.tick(now) walks a
// deterministic clock across the grace boundary and getNode().cycles (reviveNode
// bumps cycles + transition('revive') BEFORE the detached spawn) makes the revive
// observable instantly.
//
// HOW IT FAILS IF THE BUG REGRESSES — restore the unconditional
// `if (meta.pi_session_id != null) return;` and the PAST-grace tick never revives
// → cycles stays 0 → the final assert goes RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, type Harness } from './helpers/harness.js';

// REVIVE_GRACE_MS is 20_000 (crtrd.ts). Offsets well inside / well past it keep
// the test robust to the exact value without importing it.
const NOW = 7_000_000;
const WITHIN_GRACE = NOW + 10_000; // < 20s after first-observed-null → still pending
const PAST_GRACE = NOW + 25_000; //  > 20s after first-observed-null → revive

test(
  'stranded relaunch: pid=null + session set is revived once the boot grace elapses, not left active forever',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHarness({ headless: true, sessionPrefix: 'crtr-stranded' });
    try {
      // The EXACT stranded state: a broker row that booted once (pi_session_id
      // captured) whose relaunch then died after the pid-clear — pi_pid NULL,
      // intent null (so it is neither the refresh nor the idle-release path).
      const B = h.fabricateBrokerNode({
        kind: 'developer',
        status: 'active',
        intent: null,
        pi_pid: null,
        pi_session_id: 'sess-stranded-B',
      });
      const b0 = h.node(B)!;
      assert.equal(b0.host_kind, 'broker', 'B is broker-hosted (paneless)');
      assert.equal(b0.pi_pid ?? null, null, 'row pi_pid is null (relaunch never re-recorded)');
      assert.equal(b0.pi_session_id, 'sess-stranded-B', 'session is set (booted once)');
      assert.equal(b0.cycles ?? 0, 0, 'no revive yet — cycles at 0');

      // --- TICK 1 @ NOW: first observation of null pid → start the boot grace
      //     clock, do NOT revive (a healthy relaunch re-records its pid here). ---
      await h.tick(NOW);
      assert.equal(h.node(B)!.cycles ?? 0, 0, 'first tick: no revive — grace clock started');

      // --- TICK 2 @ NOW+10s (WITHIN grace): still pending. This is the
      //     double-spawn guard — a healthy relaunch would have re-recorded by now. ---
      await h.tick(WITHIN_GRACE);
      assert.equal(
        h.node(B)!.cycles ?? 0,
        0,
        'within REVIVE_GRACE_MS: still no revive (healthy relaunch grace, not a strand yet)',
      );

      // --- TICK 3 @ NOW+25s (PAST grace): the relaunch is dead → grace-revive
      //     RESUME on the saved session; reviveNode bumps cycles immediately. ---
      await h.tick(PAST_GRACE);
      assert.equal(
        h.node(B)!.cycles ?? 0,
        1,
        'past REVIVE_GRACE_MS: the stranded relaunch is revived (cycles bumped) — NOT left active forever',
      );
    } finally {
      await h.dispose();
    }
  },
);
