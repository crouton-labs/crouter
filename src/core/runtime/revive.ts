// The revive primitive — restores a node to active status under a fresh tmux
// window. Used by both the supervisor daemon (on crash/refresh detection) and
// the explicit `crtr canvas revive` command.
//
// A revive always opens a NEW window: the old one is gone (crashed, or the
// node exited with intent=refresh). The node's persisted LaunchSpec and cwd
// are the canonical recipe; reviveNode replays them faithfully.
//
//   resume=true  → `pi --resume <pi_session_id>` — wakes the saved conversation.
//   resume=false → fresh pi invocation — the node re-reads its roadmap/context dir.

import {
  getNode,
  updateNode,
} from '../canvas/index.js';
import { buildPiArgv } from './launch.js';
import { buildReviveKickoff } from './kickoff.js';
import {
  ensureSession,
  openNodeWindow,
  piCommand,
  respawnPane,
  nodeSession,
} from './tmux.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface ReviveResult {
  /** The new tmux window id, or null if openNodeWindow failed. */
  window: string | null;
  /** The tmux session the node was placed in. */
  session: string;
  /** True when pi was instructed to resume its saved conversation (`--resume`). */
  resumed: boolean;
}

// ---------------------------------------------------------------------------
// reviveNode
// ---------------------------------------------------------------------------

/** Open a fresh background tmux window for `nodeId` and update canvas meta.
 *
 *  Throws if the node does not exist. All other failures (e.g. tmux not
 *  available) propagate as-is — callers (daemon, command) decide how to handle.
 */
export function reviveNode(
  nodeId: string,
  opts: { resume: boolean },
): ReviveResult {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new Error(`reviveNode: unknown node ${nodeId}`);
  }

  // The node lives in the shared global session. Prefer its stored session
  // (an inline root tracks its own real terminal session); fall back to the
  // shared node session.
  const session = meta.tmux_session ?? nodeSession();

  ensureSession(session, meta.cwd);

  // Decide whether to wake the saved pi conversation or start fresh.
  const resumeId =
    opts.resume && meta.pi_session_id != null
      ? meta.pi_session_id
      : undefined;

  // A fresh revive (no resume) gets a kickoff prompt so it re-reads its roadmap
  // and continues; resuming a saved conversation needs none.
  const inv =
    resumeId !== undefined
      ? buildPiArgv(meta, { resumeSessionId: resumeId })
      : buildPiArgv(meta, { prompt: buildReviveKickoff(meta) });

  const env = { ...inv.env, CRTR_ROOT_SESSION: session };

  const window = openNodeWindow({
    session,
    name: meta.name,
    cwd: meta.cwd,
    env,
    command: piCommand(inv.argv),
  });

  updateNode(nodeId, {
    status: 'active',
    intent: null,
    window,
    tmux_session: session,
  });

  return { window, session, resumed: resumeId !== undefined };
}

// ---------------------------------------------------------------------------
// reviveInPlace — refresh-yield without churning the window
// ---------------------------------------------------------------------------

/** Re-exec a node's pi FRESH in its EXISTING tmux pane (the refresh-yield
 *  path). Unlike `reviveNode`, this opens no new window: the pane's current pi
 *  is replaced in place via `respawn-pane -k`, so a foreground/interactive
 *  session keeps its terminal and a background node keeps its window. Always
 *  fresh (no resume) — the node re-reads its roadmap/context dir.
 *
 *  `pane` is the target pane id (the yielding node reads it from $TMUX_PANE).
 *  Throws on unknown node or when the respawn could not be dispatched, so the
 *  caller can fall back to a plain shutdown (daemon revives in a new window). */
export function reviveInPlace(nodeId: string, pane: string): ReviveResult {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new Error(`reviveInPlace: unknown node ${nodeId}`);
  }

  const session = meta.tmux_session ?? nodeSession();

  // Fresh re-exec: same recipe as a no-resume reviveNode, with the kickoff so
  // the node rebuilds its bearings from disk.
  const inv = buildPiArgv(meta, { prompt: buildReviveKickoff(meta) });
  const env = { ...inv.env, CRTR_ROOT_SESSION: session };

  const ok = respawnPane({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });
  if (!ok) {
    throw new Error(`reviveInPlace: respawn-pane dispatch failed for ${nodeId}`);
  }

  updateNode(nodeId, { status: 'active', intent: null, tmux_session: session });

  // Window is unchanged (we re-execed in place); report the existing one.
  return { window: meta.window ?? null, session, resumed: false };
}
