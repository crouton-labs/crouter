// revive-all — resume EVERY disconnected node in one shot (gh issue #9).
//
// After a mass-disconnect event (a reboot, a killed login/tmux session, a mass
// crash, or the daemon being down a while) many nodes end up with their
// canvas.db row + saved conversation intact but NO broker engine running. The
// daemon recovers some on its own (active|idle rows with a dead pid grace-revive
// on its next tick), but it deliberately never touches terminal/dormant states,
// so the operator is left reviving survivors one id at a time.
//
// This module is the single sweep: `listDisconnected` selects every DISCONNECTED
// node (engine not running, but a resumable saved session exists), and
// `reviveAll` RESUMEs each via reviveNode — the only sanctioned launcher, which
// self-guards the double-spawn. The selection predicate (`isDisconnected`) is
// pure so the scope rules are unit-testable without booting a single process.

import { listNodes, getNode } from '../canvas/index.js';
import { isPidAlive } from '../canvas/pid.js';
import { reviveNode } from './revive.js';
import type { NodeMeta, NodeStatus } from '../canvas/types.js';

/** Statuses a node lands in DELIBERATELY: a worker that finished its own work
 *  (`done`) or a node a human closed/reaped (`canceled`). The daemon never
 *  auto-revives these (see reapDeadResidue in crtrd.ts), and revive-all leaves
 *  them alone too — resurrecting finished and closed conversations en masse would
 *  flood the canvas with work nobody asked to reopen. `dead` is NOT here: a crash
 *  is involuntary, so it is swept. (Silas, 2026-06-13: no opt-in to include these
 *  — the exclusion is unconditional.) */
export const TERMINAL_BY_CHOICE: readonly NodeStatus[] = ['done', 'canceled'];

/** True when `meta`'s engine is NOT running but it has a resumable saved session
 *  — the precise "disconnected" predicate (gh #9).
 *
 *  - engine not running: no live `pi_pid` (a dead/absent broker pid).
 *  - resumable: a captured pi session (`pi_session_file` or `pi_session_id`) —
 *    without one there is nothing to resume.
 *  - `human`-kind rows are the `crtr human` bridge, never a pi engine, so they
 *    are never "disconnected" (mirrors the daemon's superviseTick carve-out).
 *  - terminal-by-choice (`done`/`canceled`) is always excluded.
 *
 *  Pure: the liveness probe is injected so scope is unit-testable without real
 *  processes. */
export function isDisconnected(
  meta: NodeMeta,
  isAlive: (pid: number | null | undefined) => boolean,
): boolean {
  if (meta.kind === 'human') return false;
  if (isAlive(meta.pi_pid)) return false; // engine running → connected
  if (meta.pi_session_id == null && meta.pi_session_file == null) return false; // nothing to resume
  if (TERMINAL_BY_CHOICE.includes(meta.status)) return false;
  return true;
}

/** Every disconnected node on the canvas — the set a revive-all WOULD relaunch.
 *  This is the PREVIEW: it has no side effects, so the command can list the
 *  candidates and gate on confirmation before any engine is launched. */
export function listDisconnected(): NodeMeta[] {
  const out: NodeMeta[] = [];
  for (const row of listNodes()) {
    const meta = getNode(row.node_id);
    if (meta !== null && isDisconnected(meta, isPidAlive)) out.push(meta);
  }
  return out;
}

export interface ReviveAllResult {
  /** Node ids whose broker engine reviveAll relaunched (RESUME). */
  revived: string[];
  /** Per-node failures — reviveNode threw (its launch failed). One bad node
   *  never aborts the sweep. */
  failed: { node_id: string; error: string }[];
}

/** RESUME every disconnected node. reviveNode is the ONLY sanctioned launcher
 *  and self-guards the double-spawn (a node whose broker pid is already live is a
 *  no-op), so this is a thin orchestrator over `listDisconnected`: revive each
 *  with resume:true. One failing node never aborts the sweep — its error is
 *  collected and the rest proceed. */
export function reviveAll(): ReviveAllResult {
  const result: ReviveAllResult = { revived: [], failed: [] };
  for (const meta of listDisconnected()) {
    try {
      reviveNode(meta.node_id, { resume: true });
      result.revived.push(meta.node_id);
    } catch (err) {
      result.failed.push({ node_id: meta.node_id, error: (err as Error).message });
    }
  }
  return result;
}
