// The revive primitive — restores a node to active status under a fresh tmux
// window. Used by both the supervisor daemon (on crash/refresh detection) and
// the explicit `crtr canvas revive` command.
//
// A revive always opens a NEW window: the old one is gone (crashed, or the
// node exited with intent=refresh). The node's persisted LaunchSpec and cwd
// are the canonical recipe; reviveNode replays them faithfully.
//
//   resume=true  → `pi --session <path|id>` — wakes the saved conversation,
//                  preferring the absolute session-file path (cwd-immune) over
//                  the bare session id.
//   resume=false → fresh pi invocation — the node re-reads its roadmap/context dir.

import {
  getNode,
  updateNode,
  setStatus,
  setIntent,
  setPresence,
  clearPid,
  fullName,
  type NodeMeta,
} from '../canvas/index.js';
import { buildPiArgv } from './launch.js';
import { buildReviveKickoff } from './kickoff.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import {
  ensureSession,
  openNodeWindow,
  piCommand,
  respawnPane,
  nodeSession,
  windowAlive,
} from './tmux.js';

// ---------------------------------------------------------------------------
// resumeArgs — which session source a revive resumes from
// ---------------------------------------------------------------------------

/** Pick the `--session` source for a revive. resume=true prefers the absolute
 *  session-file path (immune to cwd; pi opens it directly) and keeps the bare
 *  session id as the fallback for older nodes booted before pi_session_file was
 *  captured. buildPiArgv prefers the path when both are present. resume=false (a
 *  refresh-yield) selects neither — the node re-reads its roadmap fresh. Pure so
 *  the path-vs-id selection is unit-testable without tmux. */
export function resumeArgs(
  meta: NodeMeta,
  resume: boolean,
): { resumeSessionId?: string; resumeSessionPath?: string } {
  if (!resume) return {};
  return {
    resumeSessionId: meta.pi_session_id ?? undefined,
    resumeSessionPath: meta.pi_session_file ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface ReviveResult {
  /** The new tmux window id, or null if openNodeWindow failed. */
  window: string | null;
  /** The tmux session the node was placed in. */
  session: string;
  /** True when pi was instructed to resume its saved conversation (`--session <id>`). */
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

  // Double-revive guard: if this node's window is already alive, another path
  // already revived it — e.g. restoreFocusToManager (in a finishing child's pi)
  // and the daemon's inbox-poll can both target the same idle-released node.
  // Re-launching would put a SECOND pi on the same session file. No-op: return
  // the live window untouched (no cycle bump, no new window, no resume).
  if (windowAlive(meta.tmux_session, meta.window)) {
    return {
      window: meta.window ?? null,
      session: meta.tmux_session ?? nodeSession(),
      resumed: false,
    };
  }

  // Every (re)launch is a new cycle — bump the counter so the editor label's
  // trailing N advances. Mutate the in-memory meta too so buildPiArgv below
  // builds the label with the incremented count.
  meta.cycles = (meta.cycles ?? 0) + 1;
  updateNode(nodeId, { cycles: meta.cycles });

  // The node lives in the shared global session. Prefer its stored session
  // (an inline root tracks its own real terminal session); fall back to the
  // shared node session.
  const session = meta.tmux_session ?? nodeSession();

  ensureSession(session, meta.cwd);

  // Decide whether to wake the saved pi conversation or start fresh. Prefer the
  // absolute session-file path (cwd-immune); fall back to the bare id.
  const resume = resumeArgs(meta, opts.resume);
  const resuming =
    resume.resumeSessionPath !== undefined || resume.resumeSessionId !== undefined;

  // A fresh revive (no resume) gets a kickoff prompt so it re-reads its roadmap
  // and continues; resuming a saved conversation needs none.
  const inv = resuming
    ? buildPiArgv(meta, resume)
    : buildPiArgv(meta, { prompt: buildReviveKickoff(meta) });

  const env = { ...inv.env, CRTR_ROOT_SESSION: session };

  const window = openNodeWindow({
    session,
    name: fullName(meta),
    cwd: meta.cwd,
    env,
    command: piCommand(inv.argv),
  });

  setStatus(nodeId, 'active');
  setIntent(nodeId, null);
  setPresence(nodeId, { window, tmux_session: session });
  // Window-backed launch: clear the stale pid so the daemon won't re-fire on
  // it during the new pi's boot. The fresh pi re-records its pid on
  // session_start; if it never boots, this window closes and the window-gone
  // pass reaps it.
  clearPid(nodeId);

  return { window, session, resumed: resuming };
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

  // A refresh-yield is a cycle too — advance the label's trailing N.
  meta.cycles = (meta.cycles ?? 0) + 1;
  updateNode(nodeId, { cycles: meta.cycles });

  const session = meta.tmux_session ?? nodeSession();

  // Fresh re-exec: same recipe as a no-resume reviveNode, with the kickoff so
  // the node rebuilds its bearings from disk.
  const inv = buildPiArgv(meta, { prompt: buildReviveKickoff(meta) });
  const env = { ...inv.env, CRTR_ROOT_SESSION: session };

  const ok = respawnPane({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });
  if (!ok) {
    throw new Error(`reviveInPlace: respawn-pane dispatch failed for ${nodeId}`);
  }

  // Deliberately DO NOT clear intent here, and DO NOT touch pi_pid. The detached
  // respawn-pane can't confirm it actually replaced the pi (it kills this very
  // process mid-flight), so clearing intent optimistically is how a failed
  // refresh became a silent death: the fresh pi never boots, yet meta says the
  // refresh completed. Instead we leave intent='refresh' (the fresh pi clears it
  // on boot — the only proof the respawn worked) and leave pi_pid as the OLD
  // pid. If the respawn succeeds, the old pi dies and the fresh one overwrites
  // pid+intent within the daemon's grace window; if it fails, the old pid stays
  // dead and the daemon's pi-liveness pass revives the node.
  setStatus(nodeId, 'active');
  // tmux_session may have resolved to the shared session; window is unchanged
  // (we re-execed in place), so preserve it explicitly.
  setPresence(nodeId, { tmux_session: session, window: meta.window ?? null });

  // Window is unchanged (we re-execed in place); report the existing one.
  return { window: meta.window ?? null, session, resumed: false };
}

// ---------------------------------------------------------------------------
// relaunchRootInPane — boot a CLEAN fresh root in the current pane (option C)
// ---------------------------------------------------------------------------

/** Re-exec a FRESH pi for `nodeId` in EXISTING `pane` (respawn-pane -k), with
 *  NO prompt and NO resume — a clean root conversation (goal-capture /
 *  context-intro handle the first message + bearings, exactly like bare
 *  `crtr`). Unlike reviveInPlace: no buildReviveKickoff prompt, no cycles bump,
 *  and it sets CRTR_FRONT_DOOR=1 (REQUIRED — src/core/runtime/CLAUDE.md: any
 *  path that boots a pi must guard against a removed/renamed subcommand
 *  fork-bombing). Throws if the respawn could not be dispatched.
 *
 *  Used by relaunchRoot (reset.ts) for the `/new`-in-a-root relaunch. Kept
 *  SEPARATE from reviveInPlace so the refresh-yield path's exact semantics
 *  (kickoff + cycle bump) are untouched. */
export function relaunchRootInPane(nodeId: string, pane: string): void {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new Error(`relaunchRootInPane: unknown node ${nodeId}`);
  }

  const session = meta.tmux_session ?? nodeSession();

  // No prompt, no resume → a brand-new root conversation at cycle 0.
  const inv = buildPiArgv(meta, {});
  const env = { ...inv.env, CRTR_ROOT_SESSION: session, [FRONT_DOOR_ENV]: '1' };

  const ok = respawnPane({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });
  if (!ok) {
    throw new Error(`relaunchRootInPane: respawn-pane dispatch failed for ${nodeId}`);
  }

  // Do NOT clear intent/pi_pid here — the fresh pi clears intent='refresh' on
  // its session_start boot (the only proof the respawn worked), same dance as
  // reviveInPlace.
}
