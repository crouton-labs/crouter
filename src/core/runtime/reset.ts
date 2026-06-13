// `/new` handling — root relaunch + child session-id refresh — plus clean-exit
// termination.
//
// A node's engine is a detached broker process bound to one CRTR_NODE_ID, and
// its on-screen viewer is a SEPARATE `crtr attach` pane. `/new` splits by who
// ran it:
//
//   • relaunchRoot — a `/new` on a ROOT starts a genuinely new node: the old
//     root is parked `done` (kept as history), a fresh node id + broker is
//     minted in the same pane/cwd, and the viewer pane is re-pointed at the new
//     broker. The new broker is booted FIRST, so any failure before the commit
//     point leaves the old root fully intact.
//   • resetRoot — a `/new` on a non-root child refreshes its session id only, so
//     a later `--session <id>` wakes the right conversation.
//
// Termination semantics: a pi that ends cleanly resolves its node to `done`
// (markCleanExitDone); only a true crash leaves it `dead`. A force-kill fires NO
// clean session_shutdown, so reaped descendants are marked `canceled` explicitly
// here (A5: an externally-reaped node did not finish its own work — done is
// reserved for finalize).
//
// Best-effort throughout: a tmux/fs failure on one node never aborts the reap.

import {
  getNode,
  updateNode,
  fullName,
  closeFocusRow,
  view,
} from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { headlessBrokerHost } from './host.js';
import {
  tearDownNode,
  focusOf,
  registerViewerFocus,
  respawnPaneSync,
  viewerSplitEnv,
  windowOfPane,
  renameWindow,
  waitForBrokerViewSocket,
} from './placement.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { spawnNode, rootOfSpine } from './nodes.js';

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
// relaunchRoot — a `/new` on a ROOT mints a genuinely new node (Model B)
// ---------------------------------------------------------------------------

/** Injectable host/viewer seam, so the fast-tier test drives relaunchRoot's pure
 *  DB transitions without a real broker or tmux. Each field defaults to its
 *  production verb. */
export interface RelaunchDeps {
  /** Boot the new node's detached broker engine. Default: headlessBrokerHost.launch. */
  launchBroker?: typeof headlessBrokerHost.launch;
  /** Wait for the new broker's view.sock to accept. Default: waitForBrokerViewSocket. */
  waitForViewSocket?: (nodeId: string) => boolean;
  /** Re-exec the viewer pane onto the new node. Default: respawnPaneSync. */
  respawnViewer?: typeof respawnPaneSync;
  /** Tear the old broker down. Default: headlessBrokerHost.teardown. */
  teardownBroker?: typeof headlessBrokerHost.teardown;
}

export interface RelaunchRootResult {
  /** The freshly-minted node now driving this pane. */
  newNodeId: string;
}

/** Relaunch a ROOT on `/new`: park the old root `done` (kept as history) and
 *  mint a fresh node id + broker in the same pane/cwd, re-pointing the viewer at
 *  it. The new broker is booted FIRST and its pid confirmed BEFORE the old root
 *  is touched, so any pre-commit failure leaves the old root fully intact and
 *  live. Returns null when `oldId` is not a relaunchable root (unknown, a child,
 *  or already parked), or when the new broker failed to launch. */
export function relaunchRoot(oldId: string, deps: RelaunchDeps = {}): RelaunchRootResult | null {
  const launchBroker = deps.launchBroker ?? headlessBrokerHost.launch;
  const waitForViewSocket = deps.waitForViewSocket ?? waitForBrokerViewSocket;
  const respawnViewer = deps.respawnViewer ?? respawnPaneSync;
  const teardownBroker = deps.teardownBroker ?? headlessBrokerHost.teardown;

  const old = getNode(oldId);
  if (old === null || old.parent != null) return null; // roots only
  if (old.status === 'done') return null; // defensive: a double `/new`
  const oldFocus = focusOf(oldId); // capture the viewer BEFORE any teardown

  // --- mint + boot the NEW broker FIRST (a failure here leaves the old root
  //     untouched) ---
  // A relaunched root is a fresh resident base, exactly like the front door.
  const { launch } = buildLaunchSpec(old.kind, 'base', {
    lifecycle: 'resident',
    hasManager: false,
    model: old.model_override ?? undefined,
  });
  const newMeta = spawnNode({
    kind: old.kind,
    mode: 'base',
    lifecycle: 'resident',
    cwd: old.cwd,
    name: old.kind,
    parent: null,
    launch,
    modelOverride: old.model_override ?? undefined,
  });
  const inv = buildPiArgv(newMeta, {});
  // Mirror bootRoot's subtree routing on inv.env (the broker host merges it; it
  // sets CRTR_FRONT_DOOR itself).
  inv.env = {
    ...inv.env,
    CRTR_SUBTREE: rootOfSpine(newMeta.node_id),
  };
  const placed = launchBroker(newMeta.node_id, inv, {
    cwd: old.cwd,
    name: fullName(newMeta),
    resuming: false,
  });
  if (placed.pid == null) {
    // The new broker never started — crash the half-born node and BAIL. The old
    // root is still live and untouched (nothing below this point has run).
    transition(newMeta.node_id, 'crash');
    return null;
  }
  waitForViewSocket(newMeta.node_id); // best-effort; attach auto-redials on miss

  // --- COMMIT: park + reap the old root, re-point the viewer, kill the old
  //     broker. Past this point the new node is the live root. ---
  reapDescendants(oldId); // old workers → canceled + torn down
  // Park the old root DONE (kept as history; NOT canceled — a relaunched root
  // finished cleanly, the user just started fresh). Its reports/inbox/roadmap
  // are left on disk as the record of that session.
  transition(oldId, 'finalize');
  if (oldFocus?.pane != null) {
    closeFocusRow(oldFocus.focus_id);
    respawnViewer({
      pane: oldFocus.pane,
      cwd: old.cwd,
      env: viewerSplitEnv(),
      command: `crtr attach to ${newMeta.node_id}`,
    });
    const window = windowOfPane(oldFocus.pane);
    if (window !== null) renameWindow(window, fullName(newMeta));
    registerViewerFocus(newMeta.node_id, oldFocus.pane, oldFocus.session, window);
  }
  teardownBroker(oldId); // old broker exits cleanly (its /new work is discarded)
  return { newNodeId: newMeta.node_id };
}

// ---------------------------------------------------------------------------
// resetRoot — a `/new` on a non-root child refreshes its session id only
// ---------------------------------------------------------------------------

export interface ResetRootResult {
  /** Descendant node ids torn down. Always empty — a child `/new` reaps nothing. */
  reaped: string[];
  /** Direct subscriptions dropped. Always empty — a child `/new` detaches nothing. */
  detached: string[];
  /** Always false — a child `/new` is not a graph reset (roots route to relaunchRoot). */
  reset: boolean;
}

/** Refresh a non-root child's pi session id on `/new`, so a later
 *  `--session <id>` wakes the right conversation. A `/new` on a child is NOT a
 *  graph reset — a root's `/new` is handled by relaunchRoot, never here; a root
 *  that reaches this is a no-op. */
export function resetRoot(
  nodeId: string,
  newSessionId?: string,
  newSessionFile?: string | null,
): ResetRootResult {
  const meta = getNode(nodeId);
  const empty: ResetRootResult = { reaped: [], detached: [], reset: false };
  if (meta === null || meta.parent == null) return empty; // unknown or a root
  if (newSessionId !== undefined) {
    updateNode(nodeId, {
      pi_session_id: newSessionId,
      ...(newSessionFile !== undefined ? { pi_session_file: newSessionFile } : {}),
    });
  }
  return empty;
}

// ---------------------------------------------------------------------------
// handleNewSession (the stophook's single entry)
// ---------------------------------------------------------------------------

export type HandleNewSessionPath = 'reset-child' | 'noop';

export interface HandleNewSessionResult {
  path: HandleNewSessionPath;
}

/** The child-side `/new` entry the stophook calls (the root side goes to
 *  relaunchRoot directly). The broker already drove the engine-side new_session;
 *  this only refreshes the child's session id on the SAME node id. */
export function handleNewSession(
  nodeId: string,
  newSessionId: string,
  newSessionFile?: string | null,
): HandleNewSessionResult {
  const meta = getNode(nodeId);
  if (meta === null) return { path: 'noop' };
  resetRoot(nodeId, newSessionId, newSessionFile);
  return { path: 'reset-child' };
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
