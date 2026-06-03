// Root reset — the `/new` equivalent.
//
// A live pi process is bound to one node via CRTR_NODE_ID (set at launch, not
// rebindable mid-process). When the user runs `/new`, the conversation is reset
// but the process — and thus the node id — stays the same. To make `/new`
// behave like re-running `crtr` (a brand-new graph on the canvas) we reset the
// root in place: reap its entire descendant sub-DAG, detach its subscriptions,
// and wipe its working state, then re-point it at a fresh base persona and the
// new pi session id. The node keeps its id; from the dashboard/nav it is a
// pristine root with an empty graph.
//
// Best-effort throughout: a tmux/fs failure on one node never aborts the reset.

import { existsSync, rmSync } from 'node:fs';
import {
  getNode,
  updateNode,
  setStatus,
  subscriptionsOf,
  unsubscribe,
  view,
  reportsDir,
  inboxPath,
} from '../canvas/index.js';
import { closeWindow, windowAlive } from './tmux.js';
import { buildLaunchSpec } from './launch.js';
import { roadmapPath } from './roadmap.js';

export interface ResetRootResult {
  /** Descendant node ids torn down (window killed + marked dead). */
  reaped: string[];
  /** Direct subscriptions dropped off the root. */
  detached: string[];
  /** True when the node was a root and a full reset ran. */
  reset: boolean;
}

/** Reset a root node to a pristine, empty graph (the `/new` semantics).
 *
 *  For a non-root (spawned child), a `/new` is not a graph reset — we only
 *  refresh its session id so a later `--resume` wakes the right conversation. */
export function resetRoot(nodeId: string, newSessionId?: string): ResetRootResult {
  const meta = getNode(nodeId);
  if (meta === null) return { reaped: [], detached: [], reset: false };

  // Only roots own a graph in the "ran crtr again" sense.
  if (meta.parent != null) {
    if (newSessionId !== undefined) {
      try { updateNode(nodeId, { pi_session_id: newSessionId }); } catch { /* */ }
    }
    return { reaped: [], detached: [], reset: false };
  }

  // 1) Reap the descendant sub-DAG. Mark dead + clear intent FIRST, then kill
  //    the window: the daemon revives on a window-gone + intent==='refresh'
  //    (or 'idle-release'), so flipping to dead before the window dies closes
  //    the race where a descendant mid-yield gets revived as we tear it down.
  const reaped: string[] = [];
  for (const id of view(nodeId)) {
    try {
      const dmeta = getNode(id);
      setStatus(id, 'dead');
      updateNode(id, { intent: null });
      if (dmeta !== null && windowAlive(dmeta.tmux_session, dmeta.window)) {
        closeWindow(dmeta.window as string);
      }
      reaped.push(id);
    } catch {
      /* one bad node never aborts the reset */
    }
  }

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

  // 4) Re-point the root at a fresh base persona + the new pi session id.
  try {
    const { launch } = buildLaunchSpec(meta.kind, 'base');
    updateNode(nodeId, {
      mode: 'base',
      lifecycle: 'resident',
      intent: null,
      status: 'active',
      launch,
      ...(newSessionId !== undefined ? { pi_session_id: newSessionId } : {}),
    });
  } catch {
    /* */
  }

  return { reaped, detached, reset: true };
}
