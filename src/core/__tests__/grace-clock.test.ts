// Run with: node --import tsx/esm --test src/core/__tests__/grace-clock.test.ts
//
// AXIS: the REVIVE_GRACE_MS double-spawn guard (daemon invariant 10), exercised
// FAITHFULLY with a CONTROLLED CLOCK via the harness's injectable tick(now).
//
// Why this exists (MINOR-4): the harness exposes superviseTick's injectable
// `now` through h.tick(now), but every other faithful test calls h.tick() with
// no arg — so the grace window (the guard that a pi observed dead-while-its-pane-
// lives must pend through REVIVE_GRACE_MS before a revive, lest a revive land in
// the transient old-pi-dies→fresh-pi-boots gap and DOUBLE-SPAWN) was never
// exercised end-to-end. daemon-liveness.test.ts pins livenessVerdict purely and
// drives superviseTick with a FABRICATED pi-death (deadPid); this drives a REAL
// fake-pi boot, kills it under a FROZEN (remain-on-exit) pane so the pane stays
// alive while pi is genuinely dead, then walks a deterministic clock across the
// grace boundary.
//
// This file is ADDITIVE and uses ONLY the public Harness API + h.tick(now) +
// test-local tmux/file reads (the same shape as live-mutation.test.ts's
// firstPaneOf/demote helpers). It does NOT edit harness.ts / fake-pi-host.ts or
// any production file, and adds no harness helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../../daemon/crtrd.js';

const SKIP = !hasTmux() ? 'tmux unavailable' : false;

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

/** Count the fake-pi boots recorded for a node (one line per boot in
 *  fake-pi.boots.jsonl) — the observable for "did a revive double-spawn?". */
function bootCount(home: string, id: string): number {
  try {
    return readFileSync(join(home, 'nodes', id, 'fake-pi.boots.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

// REVIVE_GRACE_MS is 20_000 (crtrd.ts). We choose offsets well inside / well
// past it so the test is robust to the exact value without importing it.
const NOW = 5_000_000;
const WITHIN_GRACE = NOW + 10_000; // < 20s after first-observed-dead → still pending
const PAST_GRACE = NOW + 25_000; //  > 20s after first-observed-dead → revive

// ===========================================================================
// The grace window guards against a double-spawn: while a node's pane is alive
// but its pi has been observed dead for LESS than REVIVE_GRACE_MS, the daemon
// must NOT revive (a revive there would race the in-flight respawn and spawn a
// second vehicle on the same pane). Once the pi has been dead PAST the grace, a
// revive proceeds.
// ===========================================================================
test(
  'grace clock: a dead-pi/alive-pane node does NOT revive within REVIVE_GRACE_MS, but DOES once it elapses',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-grace' });
    try {
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });

      // The boot proof carries the live fake-pi pid; the row records it via the
      // real session_start hook. Both are the SAME process — that pid is what
      // handleLiveWindow judges liveness on.
      const boot = await h.awaitBoot(B);
      const b0 = h.node(B)!;
      assert.equal(b0.status, 'active', 'B active after boot');
      assert.equal(b0.intent ?? null, null, 'B intent=null (NOT idle-release — the grace path, not the frozen early-return)');
      assert.equal(b0.pi_pid, boot.pid, 'row pi_pid == the live fake-pi pid (recorded at session_start)');
      assert.equal(bootCount(h.home, B), 1, 'exactly one boot so far');

      // Arm remain-on-exit on B's window so that when we kill its pi the PANE
      // survives (frozen) rather than closing — that is the only way to produce
      // the "pane alive but pi dead" state handleLiveWindow's grace path judges.
      const ro = spawnSync('tmux', ['set-window-option', '-t', b0.window!, 'remain-on-exit', 'on'], { stdio: 'ignore' });
      assert.equal(ro.status, 0, 'armed remain-on-exit on B\'s window');

      // Kill the fake-pi. pi dies; the frozen pane stays alive.
      process.kill(boot.pid, 'SIGKILL');
      await h.waitFor(() => !isPidAlive(boot.pid), { timeoutMs: 10_000, label: 'fake-pi pid dead' });
      assert.equal(h.paneAlive(B), true, 'pane is FROZEN alive after pi death (remain-on-exit)');

      // --- TICK 1 @ NOW: first observation of the dead pi → 'pending'. The
      //     daemon records first-observed-dead and does NOT revive. ---
      await h.tick(NOW);
      {
        const b = h.node(B)!;
        assert.equal(bootCount(h.home, B), 1, 'first tick: NO revive on first-observed-dead (still 1 boot)');
        assert.equal(b.pi_pid, boot.pid, 'pi_pid unchanged — no fresh vehicle spawned');
        assert.equal(b.status, 'active', 'B left active (pending, not revived)');
        assert.equal(h.paneAlive(B), true, 'frozen pane still alive');
      }

      // --- TICK 2 @ NOW+10s (WITHIN the 20s grace): STILL pending. This is the
      //     double-spawn guard: a revive here would land in the respawn gap. ---
      await h.tick(WITHIN_GRACE);
      {
        const b = h.node(B)!;
        assert.equal(
          bootCount(h.home, B),
          1,
          'within REVIVE_GRACE_MS: NO double-spawn — the dead pi must pend, not revive',
        );
        assert.equal(b.pi_pid, boot.pid, 'pi_pid STILL the dead pid — guard held');
        assert.equal(b.status, 'active', 'B still active inside the grace window');
      }

      // --- TICK 3 @ NOW+25s (PAST the 20s grace): now a revive proceeds — a
      //     FRESH fake-pi boots in the frozen pane (respawn-pane -k resume). ---
      await h.tick(PAST_GRACE);
      await h.awaitBoot(B, { minCount: 2, timeoutMs: 30_000 });
      assert.ok(
        bootCount(h.home, B) >= 2,
        'past REVIVE_GRACE_MS: the dead pi is revived → a fresh vehicle boots',
      );
      await h.waitForStatus(B, 'active');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'B active after the grace-window revive');
        assert.notEqual(b.pi_pid, boot.pid, 'pi_pid advanced to the fresh vehicle — the revive landed');
      }
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
