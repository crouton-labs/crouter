// The revive primitive — restores a node to active status under a fresh tmux
// window. Used by both the supervisor daemon (on crash/refresh detection) and
// the explicit `crtr revive node` command.
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
import {
  ensureSession,
  openNodeWindow,
  piCommand,
} from './tmux.js';
import { rootSessionName } from './spawn.js';

/** Kickoff message for a FRESH revive — the node's in-memory context is gone,
 *  so it must rebuild situational awareness from disk before continuing. */
const REVIVE_KICKOFF =
  'You have been revived fresh after a context refresh — your previous in-memory ' +
  'context is gone, by design. Rebuild your bearings from disk: read ' +
  '`context/roadmap.md`, then run `crtr feed read` to absorb what your children ' +
  'reported. Then continue the work toward your goal. If everything is done, ' +
  '`crtr push final`.';

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

  // The node lives in its root's tmux session. Prefer the stored session name;
  // fall back to deriving it from the parent (or the node itself for roots).
  const session =
    meta.tmux_session ??
    rootSessionName((meta.parent ?? meta.node_id) as string);

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
      : buildPiArgv(meta, { prompt: REVIVE_KICKOFF });

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
