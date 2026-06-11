// The revive primitive — restores a node to active status by relaunching its
// broker engine. Used by both the supervisor daemon (on crash/refresh
// detection) and the explicit `crtr canvas revive` command.
//
// A revive replays the node's persisted LaunchSpec + cwd (the canonical recipe)
// and launches the headless broker host (the only host after the
// broker-is-the-host cut). It opens NO viewer — it relaunches the engine only;
// existing viewer panes reconnect to the fresh broker on their own (attach
// auto-reconnect), and a node with no viewer is brought on screen by the next
// `focus`.
//
//   resume=true  → `pi --session <path|id>` — wakes the saved conversation,
//                  preferring the absolute session-file path (cwd-immune) over
//                  the bare session id.
//   resume=false → fresh pi invocation — the node re-reads its roadmap/context dir.
//
// reviveNode remains the ONLY sanctioned launcher of the node engine.

import {
  getNode,
  updateNode,
  clearPid,
  fullName,
  cancelDeadlinesFor,
  type NodeMeta,
} from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { buildPiArgv } from './launch.js';
import { buildReviveKickoff, drainBearings } from './kickoff.js';
import type { WakeOrigin } from './bearings.js';
import { headlessBrokerHost } from './host.js';
import { nodeSession } from './nodes.js';
import { isPidAlive } from '../canvas/pid.js';
import { clearInjectedDocs } from '../substrate/injected-store.js';

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
  /** Always null — the broker engine is never placed in a tmux window. Kept on
   *  the result for caller back-compat. */
  window: string | null;
  /** The node's backstage session (always the shared backstage; the broker
   *  engine has no tmux session of its own). Kept for caller back-compat. */
  session: string;
  /** True when pi was instructed to resume its saved conversation (`--session <id>`). */
  resumed: boolean;
}

// ---------------------------------------------------------------------------
// reviveNode
// ---------------------------------------------------------------------------

/** Relaunch `nodeId`'s broker engine from its persisted recipe and update canvas
 *  meta. Opens no viewer (engine-only).
 *
 *  Throws if the node does not exist. All other failures propagate as-is —
 *  callers (daemon, command) decide how to handle.
 */
export function reviveNode(
  nodeId: string,
  opts: { resume: boolean; wakeReason?: WakeOrigin },
): ReviveResult {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new Error(`reviveNode: unknown node ${nodeId}`);
  }

  // Lazy host_kind coerce (§C): a pre-cut row carries host_kind null or 'tmux'.
  // Every launcher now uses the broker host regardless, loading the same
  // host-agnostic session.jsonl; persist 'broker' so inspect/history read honest
  // values and the daemon never branches it back. Mutate the in-memory meta too.
  if (meta.host_kind !== 'broker') {
    updateNode(nodeId, { host_kind: 'broker' });
    meta.host_kind = 'broker';
  }

  // Double-revive guard: the broker's isAlive IS isPidAlive(pi_pid), so a node
  // whose broker pid is still running was already revived by another path —
  // re-launching would put a SECOND broker on the same session file. No-op.
  const live = getNode(nodeId) ?? meta;
  if (isPidAlive(live.pi_pid)) {
    return {
      window: null,
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
    // A fresh revive: drain the one-shot bearings, then build the kickoff. When
    // a scheduled bare self-alarm drove this revive, opts.wakeReason carries the
    // wake provenance so the kickoff leads with a <crtr-wake> block ("a timer
    // woke you"); every other reviveNode caller passes nothing → no block.
    const bearings = drainBearings(meta);
    inv = buildPiArgv(meta, { prompt: buildReviveKickoff(meta, bearings, opts.wakeReason) });
    // Fresh (no-resume) revive starts a NEW transcript — reset the on-read doc
    // dedup so the new conversation surfaces docs from scratch (a resume below
    // would instead KEEP the persisted set, continuing the same transcript).
    clearInjectedDocs(nodeId);
  }

  // The broker host launches the detached engine. reviveNode keeps
  // transition+clearPid around it (the crash-safety ordering, unchanged). It
  // opens NO viewer — engine-only; existing viewers reconnect, and a viewer-less
  // node is brought on screen by the next `focus`.
  transition(nodeId, 'revive');
  // Cancel-on-wake (design §6.4, AC-E1): every revive-for-any-reason (an inbox
  // event, a different wake, a manual focus) drops this node's pending deadline,
  // so the deadline always belongs to the dormancy being left. Writes only the
  // wakeups table, after the atomic transition above.
  cancelDeadlinesFor(nodeId);
  headlessBrokerHost.launch(nodeId, inv, {
    cwd: meta.cwd,
    name: fullName(meta),
    resuming,
  });
  // Clear the stale pid so the daemon won't re-fire on it during the new
  // broker's boot. The fresh broker re-records its pid during extension bind; if
  // it never boots, the daemon's boot-grace + surfaceBootFailure own that case.
  clearPid(nodeId);

  return { window: null, session: nodeSession(), resumed: resuming };
}
