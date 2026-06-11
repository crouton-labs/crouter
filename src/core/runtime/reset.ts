// Root reset — the `/new` equivalent — plus clean-exit termination.
//
// A node's engine is a detached broker process bound to one CRTR_NODE_ID. When
// the user runs `/new` in the viewer, the broker drives the engine-side
// new_session (the viewer's /new → broker new_session frame), keeping the SAME
// node id with a fresh conversation. The runtime side then only resets the GRAPH
// state in place — there is no pane to respawn and no new node id to mint:
//
//   • resetRoot — for a non-root child a `/new` refreshes its session id only;
//     for a root it reaps descendants, drops subscriptions, and wipes working
//     state (reports/inbox/roadmap), re-pointing the SAME id at a fresh base.
//
// Termination semantics: a pi that ends cleanly resolves its node to `done`
// (markCleanExitDone); only a true crash leaves it `dead`. A force-kill
// (closeWindow / respawn-pane -k) fires NO clean session_shutdown, so reaped
// descendants are marked `canceled` explicitly here (A5: an externally-reaped
// node did not finish its own work — done is reserved for finalize).
//
// Best-effort throughout: a tmux/fs failure on one node never aborts the reset.

import { existsSync, rmSync } from 'node:fs';
import {
  getNode,
  updateNode,
  subscriptionsOf,
  unsubscribe,
  view,
  reportsDir,
  inboxPath,
} from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { headlessBrokerHost } from './host.js';
import { tearDownNode } from './placement.js';
import { buildLaunchSpec } from './launch.js';
import { roadmapPath } from './roadmap.js';

// ---------------------------------------------------------------------------
// reapDescendants — tear down a root's descendant sub-DAG (shared helper)
// ---------------------------------------------------------------------------

/** Reap the descendant sub-DAG of `rootId`: mark each **canceled** (the user
 *  moved on — a clean teardown, NOT a fault) + clear intent FIRST, then kill its
 *  window (closes the daemon revive race). Edges are LEFT INTACT — descendants
 *  keep parent=rootId. No wipe. Returns the reaped ids.
 *
 *  Why `canceled` (A5, human-confirmed 2026-06-06): an externally-reaped node —
 *  whether via `node close` OR a root reset — did not finish its OWN work, so it
 *  unifies on `canceled`; `done` is reserved for finalize. Why marking is STILL
 *  explicit: an abrupt broker teardown fires NO clean `session_shutdown`, so the
 *  general quit→done rule does NOT auto-resolve a force-killed descendant — we
 *  mark it `canceled` here via the same `cancel` event the close cascade uses. */
export function reapDescendants(rootId: string): string[] {
  const reaped: string[] = [];
  for (const id of view(rootId)) {
    try {
      // Reap BEFORE tearing down the engine (the crash-safety invariant the
      // `cancel` event encodes): a non-supervised status + cleared intent first,
      // so the daemon can't revive a descendant mid-teardown. Teardown then sends
      // the broker the `shutdown` frame so its PROCESS exits and releases the
      // sole .jsonl writer; tearDownNode then proactively closes the on-screen
      // viewer pane + registry row (attach auto-reconnects, so the viewer must be
      // closed here or it lingers ~30s in a misleading "reconnecting…" state).
      transition(id, 'cancel');
      headlessBrokerHost.teardown(id);
      tearDownNode(id);
      reaped.push(id);
    } catch {
      /* one bad node never aborts the reap */
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// resetRoot — the legacy in-place reset (fallback + non-root refresh)
// ---------------------------------------------------------------------------

export interface ResetRootResult {
  /** Descendant node ids torn down (window killed + marked canceled). */
  reaped: string[];
  /** Direct subscriptions dropped off the root. */
  detached: string[];
  /** True when the node was a root and a full reset ran. */
  reset: boolean;
}

/** Reset a root node to a pristine, empty graph (the `/new` semantics).
 *
 *  For a non-root (spawned child), a `/new` is not a graph reset — we only
 *  refresh its session id so a later `--session <id>` wakes the right conversation. */
export function resetRoot(
  nodeId: string,
  newSessionId?: string,
  newSessionFile?: string | null,
): ResetRootResult {
  const meta = getNode(nodeId);
  if (meta === null) return { reaped: [], detached: [], reset: false };

  // Only roots own a graph in the "ran crtr again" sense.
  if (meta.parent != null) {
    if (newSessionId !== undefined) {
      updateNode(nodeId, {
        pi_session_id: newSessionId,
        ...(newSessionFile !== undefined ? { pi_session_file: newSessionFile } : {}),
      });
    }
    return { reaped: [], detached: [], reset: false };
  }

  // 1) Reap the descendant sub-DAG (mark canceled + kill windows; shared helper).
  const reaped = reapDescendants(nodeId);

  // 2) Detach the root's own subscriptions so its view is empty.
  const detached: string[] = [];
  for (const sub of subscriptionsOf(nodeId)) {
    unsubscribe(nodeId, sub.node_id);
    detached.push(sub.node_id);
  }

  // 3) Wipe the root's working state (reports / inbox / roadmap).
  for (const p of [
    reportsDir(nodeId),
    inboxPath(nodeId),
    `${inboxPath(nodeId)}.cursor`,
    roadmapPath(nodeId),
  ]) {
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch {
      /* */
    }
  }

  // 4) Re-point the root at a fresh base persona + the new pi session id. A
  //    root is resident by definition (this only runs on roots — see the early
  //    return above), so resetting to base/resident is the model, not a bypass.
  //    Re-seed persona_ack to the fresh persona so the pristine `/new`
  //    conversation never gets a spurious mode/lifecycle transition steer (the
  //    persona injector compares against this ack).
  const { launch } = buildLaunchSpec(meta.kind, 'base', { lifecycle: 'resident', hasManager: false, model: meta.model_override ?? undefined });
  updateNode(nodeId, {
    mode: 'base',
    lifecycle: 'resident',
    persona_ack: { mode: 'base', lifecycle: 'resident' },
    launch,
    ...(newSessionId !== undefined ? { pi_session_id: newSessionId } : {}),
    ...(newSessionFile !== undefined ? { pi_session_file: newSessionFile } : {}),
  });
  transition(nodeId, 'revive');

  return { reaped, detached, reset: true };
}

// ---------------------------------------------------------------------------
// handleNewSession (the stophook's single entry)
// ---------------------------------------------------------------------------

export type HandleNewSessionPath = 'reset-root' | 'reset-child' | 'noop';

export interface HandleNewSessionResult {
  path: HandleNewSessionPath;
}

/** The single entry the stophook calls on a detected `/new` (session id change).
 *  The broker already drove the engine-side new_session, so this only resets the
 *  runtime GRAPH state in place on the SAME node id — there is no pane to respawn
 *  and no new node id to mint:
 *    - non-root child → resetRoot(nodeId, newSessionId)  (session-id refresh only)
 *    - root          → resetRoot(nodeId, newSessionId)  (reap + wipe + re-point) */
export function handleNewSession(
  nodeId: string,
  newSessionId: string,
  newSessionFile?: string | null,
): HandleNewSessionResult {
  const meta = getNode(nodeId);
  if (meta === null) return { path: 'noop' };

  // Non-root child: a `/new` only refreshes its session id. resetRoot branches
  // internally on parent, so it handles both root and child correctly.
  if (meta.parent != null) {
    resetRoot(nodeId, newSessionId, newSessionFile);
    return { path: 'reset-child' };
  }

  resetRoot(nodeId, newSessionId, newSessionFile);
  return { path: 'reset-root' };
}

// ---------------------------------------------------------------------------
// markCleanExitDone — the clean-exit→done termination guard
// ---------------------------------------------------------------------------

/** Resolve a cleanly-exiting node to `done`. Returns true iff it transitioned.
 *  Guard: only a real quit, and only a node still active|idle with no pending
 *  intent — so it never clobbers a node already routed by agent_end to done
 *  (push final), refresh (yield), or idle-release. Pure/DB-only (no pi/tmux) so
 *  the guard is unit-testable without a live pi. */
export function markCleanExitDone(nodeId: string, reason: unknown): boolean {
  if (reason !== 'quit') return false;                         // new/reload/resume/fork → no-op
  const meta = getNode(nodeId);
  if (meta === null) return false;
  if (meta.status !== 'active' && meta.status !== 'idle') return false; // already done/dead/canceled
  if (meta.intent != null) return false;                      // refresh / idle-release in flight
  transition(nodeId, 'finalize');
  return true;
}
