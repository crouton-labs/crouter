// Run with: node --import tsx/esm --test src/core/__tests__/refresh-stall-recycle.test.ts
//
// BUG-REGRESSION (broker-universal-host cut, design §H refresh-authority; U7
// report mq8gq8we-4cadd8e6; stuck-refresh, parent mq7s5o93). A `node yield` /
// refresh records intent='refresh' and relies on the in-process stophook to call
// shutdown at stop. But the engine can be left ALIVE forever — it hangs at a huge
// context, OR a STALE in-process stophook (pi extensions never reload, so a
// days-old resident carries an old hook) ignores intent='refresh' and never calls
// shutdown. Engine alive + turn over + intent pending forever. The daemon only
// revives DEAD engines, so without §H the node is permanently stuck. The DAEMON
// is the authority: when intent='refresh' persists on a LIVE engine whose turn is
// over, past YIELD_STALL_GRACE_MS, it force-kills the engine (SIGTERM) so the
// dead-pid refresh path then revives it fresh.
//
// Two legs: the pure truth table (D4a — yieldStallVerdict) and the daemon
// integration over a real live pid the daemon must SIGTERM (D4b — superviseTick
// with an injected clock). Regression check: drop §H and D4b's "engine killed"
// assert goes RED (the live refresh pid lives forever, never recycled).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { yieldStallVerdict, YIELD_STALL_GRACE_MS, isPidAlive } from '../../daemon/crtrd.js';

// ---------------------------------------------------------------------------
// D4a — the pure refresh-stall truth table.
// ---------------------------------------------------------------------------
test('D4a yieldStallVerdict: kill ONLY a live, not-busy, refresh engine past the grace', () => {
  const G = YIELD_STALL_GRACE_MS;

  // The one 'kill' case: engine alive, intent=refresh, turn over (not busy), past grace.
  assert.equal(yieldStallVerdict(true, 'refresh', false, G), 'kill', 'alive+refresh+!busy+>=grace → kill');
  assert.equal(yieldStallVerdict(true, 'refresh', false, G + 60_000), 'kill', 'well past grace → kill');

  // Within the grace → pending (the healthy stophook window).
  assert.equal(yieldStallVerdict(true, 'refresh', false, null), 'pending', 'first observation → pending');
  assert.equal(yieldStallVerdict(true, 'refresh', false, G - 1), 'pending', 'within grace → pending');

  // A working engine is NEVER killed, even past the grace.
  assert.equal(yieldStallVerdict(true, 'refresh', true, G + 60_000), 'leave', 'busy (mid-turn) → leave');

  // Not a refresh → not our concern.
  assert.equal(yieldStallVerdict(true, 'idle-release', false, G + 60_000), 'leave', 'intent≠refresh → leave');
  assert.equal(yieldStallVerdict(true, null, false, G + 60_000), 'leave', 'no pending intent → leave');

  // A dead/unknown pid is the ordinary revive path's job, not this one.
  assert.equal(yieldStallVerdict(false, 'refresh', false, G + 60_000), 'leave', 'dead pid → leave (dead-pid path owns it)');
  assert.equal(yieldStallVerdict(null, 'refresh', false, G + 60_000), 'leave', 'unknown pid → leave');
});

// ---------------------------------------------------------------------------
// D4b — daemon integration: a stuck refresh on a LIVE engine is force-recycled.
// ---------------------------------------------------------------------------
const T0 = 7_000_000;
const T_KILL = T0 + YIELD_STALL_GRACE_MS + 1; // one ms past the grace from t0

test(
  'D4b daemon force-recycles a stuck refresh: a live, not-busy refresh engine past the grace is SIGTERM\'d',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-d4b' });
    // A real live subprocess standing in for the hung/stale-hook engine. `sleep`
    // dies on SIGTERM, so the daemon's force-kill is directly observable.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const enginePid = child.pid!;
    try {
      assert.equal(isPidAlive(enginePid), true, 'precondition: the refresh engine is alive');

      // intent='refresh' + LIVE pid + turn over (no busy marker by default) →
      // the §H stall state the daemon must break.
      const id = h.fabricateBrokerNode({
        kind: 'developer',
        status: 'active',
        intent: 'refresh',
        pi_pid: enginePid,
        pi_session_id: 'sess-d4b',
      });
      assert.equal(h.node(id)!.intent, 'refresh', 'precondition: intent=refresh pending');

      // --- TICK @ t0: arms the stall clock (yieldStallSince). No kill yet. ---
      await h.tick(T0);
      assert.equal(isPidAlive(enginePid), true, 'within grace: the engine is NOT killed (clock just armed)');

      // --- TICK past the grace: the daemon concludes the refresh stalled and
      //     SIGTERMs the engine itself (§H force-recycle). ---
      await h.tick(T_KILL);
      await h.waitFor(() => (isPidAlive(enginePid) ? null : true), {
        label: 'daemon SIGTERM killed the stuck refresh engine',
        timeoutMs: 10_000,
      });
      assert.equal(isPidAlive(enginePid), false, 'past grace: the daemon force-killed the stuck refresh engine (§H)');
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await h.dispose();
    }
  },
);
