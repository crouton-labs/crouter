// Run with: node --import tsx/esm --test src/core/__tests__/broker-double-spawn.test.ts
//
// BUG-REGRESSION (broker-universal-host cut, design §C "double-spawn verdict";
// taste/broker-is-the-host). Two coupled invariants the cut introduced:
//
//   1. A pre-cut row carries host_kind='tmux' (or null). While its RAW pi pid is
//      still ALIVE the daemon must NEVER relaunch it — a relaunch would put a
//      SECOND vehicle on the same .jsonl (the double-spawn). Liveness is the
//      recorded engine pid alone; an alive pid is always 'leave'.
//   2. When that pid dies and the node revives, it comes back as a BROKER and the
//      row's host_kind is lazily COERCED tmux→'broker' (reviveNode, revive.ts
//      ~91-97) so inspect/history read honest values and the daemon never
//      branches it back to a tmux host.
//
// Three legs, strongest→cheapest: the pure verdict (D1a), the direct reviveNode
// coerce (D1b), and the full daemon integration over a real live→dead pid (D1c).
// Regression check: if the cut's coerce is removed, D1b/D1c go RED (host_kind
// stays 'tmux'); if an alive pid is ever revived, D1c's "no relaunch" asserts go
// RED (cycles bumps / host_kind flips while the pid is still alive).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { createNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { reviveNode } from '../runtime/revive.js';
import { livenessVerdict, isPidAlive } from '../../daemon/crtrd.js';
import type { NodeMeta } from '../canvas/types.js';

// A pid reaped (dead) by the time spawnSync returns — the "dead but supervised"
// pid the grace path judges.
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

/** Fabricate a PRE-CUT host_kind='tmux' row directly (the harness's
 *  fabricateBrokerNode hardcodes host_kind:'broker', so we mirror its body here
 *  with host_kind:'tmux' — no harness edit). The result is a row the daemon
 *  supervises by pid exactly as a legacy tmux node would be. */
function fabricateTmuxNode(o: {
  id: string;
  pi_pid: number | null;
  pi_session_id: string | null;
}): string {
  const meta: NodeMeta = {
    node_id: o.id,
    name: o.id,
    created: new Date().toISOString(),
    cwd: process.cwd(),
    host_kind: 'tmux',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    parent: null,
    pi_session_id: o.pi_session_id,
    status: 'active',
    intent: null,
    pi_pid: o.pi_pid,
  };
  createNode(meta);
  closeDb();
  return o.id;
}

// REVIVE_GRACE_MS is 20_000 (crtrd.ts); pick offsets well inside / well past it.
const T_ALIVE = 6_000_000;
const T_DEAD = 6_100_000; // first dead observation
const T_PAST = T_DEAD + 25_000; // > 20s after first-observed-dead → revive

// ---------------------------------------------------------------------------
// D1a — pure verdict: an alive pid is NEVER relaunched (no double-spawn).
// ---------------------------------------------------------------------------
test('D1a livenessVerdict: an ALIVE pid is left alone (never a double-spawn); a DEAD pid pends then revives', () => {
  assert.equal(livenessVerdict(true, null), 'leave', 'alive pid, first obs → leave');
  assert.equal(livenessVerdict(true, 10_000_000), 'leave', 'alive pid is NEVER relaunched');
  assert.equal(livenessVerdict(false, null), 'pending', 'dead, first obs → pending (double-spawn guard)');
  assert.equal(livenessVerdict(false, 1_000), 'pending', 'dead, within grace → pending');
  assert.equal(livenessVerdict(false, 10_000_000), 'revive', 'dead past grace → revive');
});

// ---------------------------------------------------------------------------
// D1b — direct reviveNode coerce: a tmux row flips to 'broker' on revive.
// ---------------------------------------------------------------------------
test('D1b reviveNode coerces a pre-cut host_kind=tmux row to broker', async () => {
  const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-d1b' });
  try {
    const id = fabricateTmuxNode({ id: 'd1b-node', pi_pid: deadPid(), pi_session_id: 'sess-d1b' });
    assert.equal(h.node(id)!.host_kind, 'tmux', 'precondition: row is a legacy tmux host');

    // reviveNode's lazy coerce runs at the top, before any launch (revive.ts ~91-97).
    reviveNode(id, { resume: true });

    assert.equal(h.node(id)!.host_kind, 'broker', 'tmux→broker coerced on revive (the daemon never branches it back)');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// D1c — full integration: an ALIVE tmux pid is NOT relaunched; once it dies the
// node revives as a broker (host_kind coerced, cycles bumped).
// ---------------------------------------------------------------------------
test(
  'D1c daemon: a live tmux pi is never double-spawned; on death it revives as a broker',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-d1c' });
    // A real live subprocess whose pid stands in for the raw pi vehicle.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const livePid = child.pid!;
    try {
      assert.equal(isPidAlive(livePid), true, 'precondition: the raw pi pid is alive');

      // pi_session_id SET so the dead-pid path routes the crash/grace revive, NOT
      // the never-booted boot-failure branch.
      const id = fabricateTmuxNode({ id: 'd1c-node', pi_pid: livePid, pi_session_id: 'sess-d1c' });
      assert.equal(h.node(id)!.host_kind, 'tmux', 'precondition: pre-cut tmux host');
      assert.equal(h.node(id)!.cycles ?? 0, 0, 'no revive yet');

      // --- TICK while the pi is ALIVE: must be a no-op. The daemon never
      //     relaunches a live pid, so reviveNode is never called → NO coerce, NO
      //     cycle bump, pid unchanged. This is the double-spawn guard. ---
      await h.tick(T_ALIVE);
      {
        const n = h.node(id)!;
        assert.equal(n.host_kind, 'tmux', 'live pid: host_kind NOT coerced (reviveNode never ran → no double-spawn)');
        assert.equal(n.cycles ?? 0, 0, 'live pid: NO revive (cycles still 0)');
        assert.equal(n.pi_pid, livePid, 'live pid: pi_pid unchanged — no second vehicle launched');
      }

      // Kill the raw pi and wait until the daemon would observe it dead.
      child.kill('SIGKILL');
      await h.waitFor(() => (isPidAlive(livePid) ? null : true), { label: 'raw pi dead', timeoutMs: 10_000 });

      // --- TICK: first dead observation → pending (within grace). No revive. ---
      await h.tick(T_DEAD);
      {
        const n = h.node(id)!;
        assert.equal(n.cycles ?? 0, 0, 'first-observed-dead: pends, no revive yet');
        assert.equal(n.host_kind, 'tmux', 'still tmux until the revive actually fires');
      }

      // --- TICK past the grace: the crash/grace revive fires → reviveNode coerces
      //     host_kind tmux→broker and bumps cycles (observable instantly, the
      //     model effect lands before the detached broker spawn — grace-clock). ---
      await h.tick(T_PAST);
      {
        const n = h.node(id)!;
        assert.equal(n.cycles ?? 0, 1, 'past grace: revived → cycles bumped to 1');
        assert.equal(n.host_kind, 'broker', 'past grace: host_kind coerced tmux→broker on revive');
      }
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
