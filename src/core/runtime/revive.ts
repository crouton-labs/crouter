// The revive primitive — restores a node to active status under a fresh tmux
// window. Used by both the supervisor daemon (on crash/refresh detection) and
// the explicit `crtr canvas revive` command.
//
// A revive replays the node's persisted LaunchSpec + cwd (the canonical recipe)
// and routes PLACEMENT through reviveIntoPlacement (§1.4): a non-focused node
// opens a fresh background window in its home_session (the backstage `crtr` for
// a child — NEVER a user session); a node that occupies a LIVE focus resumes IN
// PLACE in that focus pane (respawn-pane -k, no new window). reviveNode never
// targets meta.tmux_session, so a background revive can no longer open an
// unbidden window in the user's session.
//
//   resume=true  → `pi --session <path|id>` — wakes the saved conversation,
//                  preferring the absolute session-file path (cwd-immune) over
//                  the bare session id.
//   resume=false → fresh pi invocation — the node re-reads its roadmap/context dir.

import {
  getNode,
  updateNode,
  setPresence,
  clearPid,
  fullName,
  type NodeMeta,
} from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { buildPiArgv } from './launch.js';
import { buildReviveKickoff, drainBearings } from './kickoff.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { piCommand, respawnPane, nodeSession, type RespawnPaneOpts } from './tmux.js';
import { reviveIntoPlacement, reconcile, isNodePaneAlive, homeSessionOf } from './placement.js';

/** signal-0 liveness probe for a pi pid (mirrors the daemon's isPidAlive). A
 *  null pid (legacy / never-booted) reads dead. */
function pidAlive(pid: number | null | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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

  // Double-revive guard (pane-keyed, §2.4): reconcile FIRST so a user-moved pane
  // isn't misread as "not yet revived", then probe pane-existence. A node whose
  // pane is alive AND whose pi is still RUNNING was already revived by another
  // path; re-launching would put a SECOND pi on the same session file — no-op.
  // A FROZEN focus pane (remain-on-exit, F3) is pane-alive but pi-DEAD: that is
  // the resume-into-focus case and MUST proceed (respawn-pane -k back into the
  // frozen pane), so the guard gates on pi liveness too, not pane-existence alone.
  reconcile(nodeId);
  const live = getNode(nodeId) ?? meta;
  if (isNodePaneAlive(nodeId) && pidAlive(live.pi_pid)) {
    return {
      window: live.window ?? null,
      session: live.tmux_session ?? nodeSession(),
      resumed: false,
    };
  }

  // Every (re)launch is a new cycle — bump the counter so the editor label's
  // trailing N advances. Mutate the in-memory meta too so buildPiArgv below
  // builds the label with the incremented count.
  meta.cycles = (meta.cycles ?? 0) + 1;
  updateNode(nodeId, { cycles: meta.cycles });

  // Decide whether to wake the saved pi conversation or start fresh. Prefer the
  // absolute session-file path (cwd-immune); fall back to the bare id.
  const resume = resumeArgs(meta, opts.resume);
  const resuming =
    resume.resumeSessionPath !== undefined || resume.resumeSessionId !== undefined;

  // A fresh revive (no resume) gets a kickoff prompt so it re-reads its roadmap
  // and continues; resuming a saved conversation needs none. drainBearings is the
  // one-shot consuming step (yield note + feed cursor + persona ack); the builder
  // is then pure.
  let inv;
  if (resuming) {
    inv = buildPiArgv(meta, resume);
  } else {
    const bearings = drainBearings(meta);
    inv = buildPiArgv(meta, { prompt: buildReviveKickoff(meta, bearings) });
  }

  // Placement owns WHERE this revive lands (§1.4): resume into a live focus pane
  // if the node occupies one, else a fresh window in its home_session (the
  // backstage `crtr` for a child — NEVER a user session). reviveIntoPlacement
  // performs the one atomic setPresence; reviveNode keeps transition+clearPid
  // around it (the crash-safety ordering, unchanged). THIS is the bug-kill: a
  // non-focused background revive can no longer new-window into a user session.
  transition(nodeId, 'revive');
  const placed = reviveIntoPlacement(nodeId, {
    command: piCommand(inv.argv),
    env: inv.env,
    cwd: meta.cwd,
    name: fullName(meta),
    resuming,
  });
  // Window-backed launch: clear the stale pid so the daemon won't re-fire on
  // it during the new pi's boot. The fresh pi re-records its pid on
  // session_start; if it never boots, this window closes and the window-gone
  // pass reaps it.
  clearPid(nodeId);

  return { window: placed.window, session: placed.session, resumed: resuming };
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
export function reviveInPlace(
  nodeId: string,
  pane: string,
  respawn: (opts: RespawnPaneOpts) => boolean = respawnPane,
): ReviveResult {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new Error(`reviveInPlace: unknown node ${nodeId}`);
  }

  // A refresh-yield is a cycle too — advance the label's trailing N.
  meta.cycles = (meta.cycles ?? 0) + 1;
  updateNode(nodeId, { cycles: meta.cycles });

  // The node's LOCATION — the session its pane physically lives in. The re-exec
  // is IN PLACE (the pane never moves), so this is preserved unchanged below.
  const session = meta.tmux_session ?? nodeSession();

  // Fresh re-exec: same recipe as a no-resume reviveNode, with the kickoff so
  // the node rebuilds its bearings from disk. Drain the one-shot bearings first,
  // then build purely.
  const bearings = drainBearings(meta);
  const inv = buildPiArgv(meta, { prompt: buildReviveKickoff(meta, bearings) });
  // CRTR_ROOT_SESSION is the backstage this node's CHILDREN spawn into — it must
  // be the durable REVIVE-HOME (home_session), NOT the pane's live `session`. A
  // FOCUSED child's pane is in a USER session (focus taints meta.tmux_session),
  // so sourcing it from `session` would land any child it spawns in the user's
  // session, re-tainting that child's home_session (A-MAJOR-1). home_session is
  // the taint-immune backstage `crtr` for a child; for a root it equals its own
  // session, so this is behavior-preserving there.
  const env = { ...inv.env, CRTR_ROOT_SESSION: homeSessionOf(nodeId) };

  const ok = respawn({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });
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
  transition(nodeId, 'boot');
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

  // No prompt, no resume → a brand-new root conversation at cycle 0.
  const inv = buildPiArgv(meta, {});
  // Source CRTR_ROOT_SESSION from the durable REVIVE-HOME (home_session), the
  // same taint-immunity rule as reviveInPlace. relaunchRootInPane runs only on a
  // root, whose home_session IS its own session, so this is behavior-preserving
  // — it keeps both in-pane revive paths sourced identically.
  const env = { ...inv.env, CRTR_ROOT_SESSION: homeSessionOf(nodeId), [FRONT_DOOR_ENV]: '1' };

  const ok = respawnPane({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });
  if (!ok) {
    throw new Error(`relaunchRootInPane: respawn-pane dispatch failed for ${nodeId}`);
  }

  // Do NOT clear intent/pi_pid here — the fresh pi clears intent='refresh' on
  // its session_start boot (the only proof the respawn worked), same dance as
  // reviveInPlace.
}
