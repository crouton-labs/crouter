// Root reset + relaunch — the `/new` equivalents, plus clean-exit termination.
//
// A live pi process is bound to one node via CRTR_NODE_ID (set at launch, not
// rebindable mid-process). When the user runs `/new`, the conversation resets
// but the OS process — and thus the node id — stays the same. To make `/new`
// behave like re-running `crtr` we have two strategies:
//
//   • relaunchRoot (option C) — for a ROOT in a tmux pane: PARK the old root
//     (mark done, keep its id/edges/pi_session_id intact as history), mint a
//     FRESH node id, and re-exec pi in the current pane bound to the new id.
//     The old id never changes meaning; external refs stay valid.
//   • resetRoot (fallback) — for a non-root child (session-id refresh only) or
//     a root with no pane (no tmux): the legacy in-place reset of the SAME id.
//
// Termination semantics: a pi that ends cleanly resolves its node to `done`
// (markCleanExitDone); only a true crash leaves it `dead`. A force-kill
// (closeWindow / respawn-pane -k) fires NO clean session_shutdown, so reaped
// descendants are marked `done` explicitly here.
//
// Best-effort throughout: a tmux/fs failure on one node never aborts the reset.

import { existsSync, rmSync } from 'node:fs';
import {
  getNode,
  updateNode,
  setStatus,
  setIntent,
  setPresence,
  clearPid,
  subscriptionsOf,
  unsubscribe,
  view,
  reportsDir,
  inboxPath,
} from '../canvas/index.js';
import { closeWindow, windowAlive, paneLocation } from './tmux.js';
import { buildLaunchSpec } from './launch.js';
import { roadmapPath } from './roadmap.js';
import { spawnNode, newNodeId } from './nodes.js';
import { setFocus } from './presence.js';
import { relaunchRootInPane } from './revive.js';

// ---------------------------------------------------------------------------
// reapDescendants — tear down a root's descendant sub-DAG (shared helper)
// ---------------------------------------------------------------------------

/** Reap the descendant sub-DAG of `rootId`: mark each **done** (the user moved
 *  on — a clean teardown, NOT a fault) + clear intent FIRST, then kill its
 *  window (closes the daemon revive race). Edges are LEFT INTACT — descendants
 *  keep parent=rootId. No wipe. Returns the reaped ids.
 *
 *  Why `done`, and why marking is STILL explicit: a `closeWindow`/`respawn-pane
 *  -k` kill is abrupt and fires NO clean `session_shutdown`, so the general
 *  quit→done rule does NOT auto-resolve a force-killed descendant — we mark it
 *  `done` here. Shared by relaunchRoot (option C) and resetRoot's in-place
 *  fallback, so both leave their descendants `done`. */
export function reapDescendants(rootId: string): string[] {
  const reaped: string[] = [];
  for (const id of view(rootId)) {
    try {
      const dmeta = getNode(id);
      // Mark done + clear intent BEFORE killing the window: the daemon revives
      // on a window-gone + intent==='refresh' (or 'idle-release'), so flipping
      // to a non-supervised status before the window dies closes the race where
      // a descendant mid-yield gets revived as we tear it down.
      setStatus(id, 'done');
      setIntent(id, null);
      if (dmeta !== null && windowAlive(dmeta.tmux_session, dmeta.window)) {
        closeWindow(dmeta.window as string);
      }
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
  /** Descendant node ids torn down (window killed + marked done). */
  reaped: string[];
  /** Direct subscriptions dropped off the root. */
  detached: string[];
  /** True when the node was a root and a full reset ran. */
  reset: boolean;
}

/** Reset a root node to a pristine, empty graph (the legacy `/new` semantics —
 *  now used as the no-pane fallback and the non-root session-id refresh).
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
      try {
        updateNode(nodeId, {
          pi_session_id: newSessionId,
          ...(newSessionFile !== undefined ? { pi_session_file: newSessionFile } : {}),
        });
      } catch { /* */ }
    }
    return { reaped: [], detached: [], reset: false };
  }

  // 1) Reap the descendant sub-DAG (mark done + kill windows; shared helper).
  const reaped = reapDescendants(nodeId);

  // 2) Detach the root's own subscriptions so its view is empty.
  const detached: string[] = [];
  for (const sub of subscriptionsOf(nodeId)) {
    try {
      unsubscribe(nodeId, sub.node_id);
      detached.push(sub.node_id);
    } catch {
      /* */
    }
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
  try {
    const { launch } = buildLaunchSpec(meta.kind, 'base');
    updateNode(nodeId, {
      mode: 'base',
      lifecycle: 'resident',
      persona_ack: { mode: 'base', lifecycle: 'resident' },
      launch,
      ...(newSessionId !== undefined ? { pi_session_id: newSessionId } : {}),
      ...(newSessionFile !== undefined ? { pi_session_file: newSessionFile } : {}),
    });
    setIntent(nodeId, null);
    setStatus(nodeId, 'active');
  } catch {
    /* */
  }

  return { reaped, detached, reset: true };
}

// ---------------------------------------------------------------------------
// relaunchRoot (option C) + handleNewSession (the stophook's single entry)
// ---------------------------------------------------------------------------

/** Injectable respawn seam — tests pass a double since tmux isn't available. */
export interface RelaunchDeps {
  relaunchRootInPane?: (nodeId: string, pane: string) => void;
}

export type HandleNewSessionPath = 'relaunch' | 'reset-root' | 'reset-child' | 'noop';

export interface HandleNewSessionResult {
  path: HandleNewSessionPath;
  newNodeId?: string;
}

/** The single entry the stophook calls on a detected `/new` (session id change).
 *  Policy lives here so the stophook stays thin and this stays unit-testable:
 *    - non-root child          → resetRoot(nodeId, newSessionId)  (session-id refresh only)
 *    - root + pane present      → relaunchRoot(nodeId, pane)        (option C)
 *    - root + no pane (no tmux) → resetRoot(nodeId, newSessionId)  (in-place fallback)
 *  On a respawn-dispatch failure the live pi never died, so we degrade to the
 *  legacy in-place reset. */
export function handleNewSession(
  nodeId: string,
  newSessionId: string,
  pane: string | undefined,
  deps: RelaunchDeps = {},
  newSessionFile?: string | null,
): HandleNewSessionResult {
  const meta = getNode(nodeId);
  if (meta === null) return { path: 'noop' };

  // Non-root child: a `/new` only refreshes its session id (unchanged).
  if (meta.parent != null) {
    resetRoot(nodeId, newSessionId, newSessionFile);
    return { path: 'reset-child' };
  }

  // Root with no pane (not inside tmux): in-place reset fallback. Option C needs
  // a pane to respawn into; resetRoot needs the new session id (available here
  // because the trigger is session_start).
  if (pane === undefined || pane.trim() === '') {
    resetRoot(nodeId, newSessionId, newSessionFile);
    return { path: 'reset-root' };
  }

  // Root with a pane: option C relaunch. relaunchRoot self-rolls-back its DB
  // writes on a respawn-dispatch failure and rethrows; we then degrade to the
  // legacy in-place reset (the live pi is still alive, never killed).
  try {
    const result = relaunchRoot(nodeId, pane, deps);
    if (result === null) return { path: 'noop' }; // defensive guard hit (e.g. rapid double /new)
    return { path: 'relaunch', newNodeId: result.newNodeId };
  } catch {
    setFocus(nodeId);
    resetRoot(nodeId, newSessionId, newSessionFile);
    return { path: 'reset-root' };
  }
}

/** Park the old root + create+launch a fresh root in `pane` (option C). All DB
 *  writes are synchronous and happen BEFORE the respawn (the respawn kills the
 *  caller). Returns the new node id, or null on a defensive guard (not a root /
 *  already parked). Throws only if the respawn dispatch fails — and self-rolls-
 *  back its writes first so the caller can degrade to resetRoot. */
export function relaunchRoot(
  oldId: string,
  pane: string,
  deps: RelaunchDeps = {},
): { newNodeId: string } | null {
  const oldMeta = getNode(oldId);
  if (oldMeta === null || oldMeta.parent != null) return null; // defensive: not a root
  if (oldMeta.status === 'done') return null;                  // defensive: already parked (rapid double /new)

  const respawn = deps.relaunchRootInPane ?? relaunchRootInPane;

  // 1) Reap descendants (mark done + kill windows, keep edges, no wipe).
  reapDescendants(oldId);

  // 2) Resolve where the new pi will live (pane authoritative; fall back to old
  //    meta when paneLocation can't resolve, e.g. outside a live tmux server).
  const loc = paneLocation(pane) ?? {
    session: oldMeta.tmux_session ?? null,
    window: oldMeta.window ?? null,
  };

  // 3) Create the fresh root node (new id, empty context dir via ensureNodeDirs).
  const newId = newNodeId();
  const { launch } = buildLaunchSpec(oldMeta.kind, 'base');
  spawnNode({
    kind: oldMeta.kind,
    mode: 'base',
    lifecycle: 'resident',
    cwd: oldMeta.cwd,
    name: oldMeta.kind,
    parent: null,
    spawnedBy: oldId,            // audit-only successor link; does NOT touch the spine
    nodeId: newId,
    launch,
  });
  setStatus(newId, 'active');
  setIntent(newId, 'refresh');   // safety net: if the pane dies before boot, daemon revives in a new window
  setPresence(newId, { tmux_session: loc.session, window: loc.window });
  clearPid(newId);               // no pi yet → daemon 'leave' until boot records the pid

  // 4) Park the old root. done + detach its window so it never claims the pane,
  //    but KEEP pi_session_id (resumable), parent=null, and all edges.
  setStatus(oldId, 'done');
  setIntent(oldId, null);
  setPresence(oldId, { window: null, tmux_session: null });

  // 5) Focus follows content.
  setFocus(newId);

  // 6) Re-exec pi in this pane bound to newId. Detached respawn kills THIS pi.
  try {
    respawn(newId, pane);
  } catch (err) {
    // Dispatch failed — the live pi never died. Roll back so it keeps working
    // as the old root (caller degrades to resetRoot).
    try {
      setStatus(oldId, 'active');
      setIntent(oldId, oldMeta.intent ?? null);
      setPresence(oldId, { window: loc.window, tmux_session: loc.session });
    } catch { /* */ }
    try { setStatus(newId, 'dead'); } catch { /* */ } // daemon ignores it
    try { setFocus(oldId); } catch { /* */ }
    throw err instanceof Error ? err : new Error(String(err));
  }

  return { newNodeId: newId };
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
  setStatus(nodeId, 'done');
  return true;
}
