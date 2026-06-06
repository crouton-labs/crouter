// presence.ts — focus pointer + per-node liveness helpers.
//
// The focus pointer (`<crtrHome>/focus.ptr`) is a plain-text file holding the
// node id that currently "has focus" — meaning the user's terminal is showing
// that node's tmux window. It is written on every explicit `focusNode()` call
// and read by the dashboard / status-line to highlight the active node.
//
// This is intentionally a simple file-based pointer rather than a database
// column: focus is transient UI state, not durable business data. A crash
// leaves a stale pointer that the next focusNode() clobbers — harmless.
//
// focusNode() does two things:
//   1. Ensures the user's terminal lands on the right tmux window by calling
//      switchClient (cross-session) then selectWindow (in-session). Both are
//      best-effort; we set the pointer regardless so the dashboard stays in sync.
//   2. Persists the node id to focus.ptr so any process can quickly read "what
//      is the user looking at?".

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

import {
  crtrHome,
  getNode,
  getRow,
  openFocusRow,
  closeFocusRow,
  getFocusById,
  getFocusByNode,
} from '../canvas/index.js';
import type { NodeMeta } from '../canvas/index.js';
import { selectWindow, switchClient, windowAlive, currentTmux, inTmux } from './tmux.js';

// ---------------------------------------------------------------------------
// Focus pointer
// ---------------------------------------------------------------------------

/** Absolute path to the focus pointer file. */
function focusPtrPath(): string {
  return join(crtrHome(), 'focus.ptr');
}

/** Persist `nodeId` as the currently focused node. Best-effort; never throws.
 *  Also maintains the transitional focus.ptr↔focuses-table dual-write bridge
 *  (see below) so Step 6 can flip reads to the table with no data gap. */
export function setFocus(nodeId: string): void {
  try {
    const p = focusPtrPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, nodeId, 'utf8');
  } catch {
    /* focus pointer is best-effort; never surface */
  }
  syncBridgeFocusRow(nodeId); // Step-4 dual-write bridge (REMOVED in Step 8)
}

/** Read the currently focused node id, or null if there is no active focus.
 *  Reads `focus.ptr` first; FALLS BACK to the canonical focuses row (the bridge,
 *  below) when the pointer is absent/empty — so a reader sees the same focus
 *  whichever store a writer reached. Best-effort; never throws. */
export function getFocus(): string | null {
  try {
    const raw = readFileSync(focusPtrPath(), 'utf8').trim();
    if (raw !== '') return raw;
  } catch {
    /* pointer absent — fall through to the table */
  }
  // Bridge fallback: the canonical focus row's occupant (Step-8 removal).
  try {
    return getFocusById(BRIDGE_FOCUS_ID)?.node_id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transitional focus.ptr ↔ focuses-table dual-write bridge.
//
// THROWAWAY — DELETED IN STEP 8. Today `focus.ptr` owns the single "current"
// focus. Step 4 stands up the plural `focuses` table but nothing reads it as
// authority yet (that switch is Step 6). To populate it in lockstep WITHOUT a
// behavior change, every `setFocus` ALSO writes one canonical focus row that
// mirrors `focus.ptr`, and `getFocus` falls back to it. Step 6 replaces
// focusNodeInPlace with retargetFocus/openFocus, which write pane-correct focus
// rows directly — then this bridge (and focus.ptr) is removed.
// ---------------------------------------------------------------------------

/** The fixed focus_id of the one canonical row that mirrors `focus.ptr`. */
const BRIDGE_FOCUS_ID = '__focus_ptr__';

/** Best-effort pane/session for the canonical focus row. A bare `setFocus(id)`
 *  only carries a node id, but a focus row wants pane+session. Resolve them
 *  READ-ONLY from the node's already-stored LOCATION (`row.pane`/`tmux_session`),
 *  else from the caller's current tmux pane (`currentTmux`).
 *
 *  DELIBERATE DEVIATION from the design's "run reconcile(nodeId) first": reconcile
 *  WRITES node presence via setPresence, and `setFocus` has many non-focus callers
 *  (reset/close/demote/tmux-spread). Reconciling on every setFocus would mutate
 *  their nodes' LOCATION as an invisible side-effect of a dual-write that is
 *  supposed to change NOTHING this step. So the bridge reads, never reconciles;
 *  best-effort is fine THIS step (nothing reads the row as authority until Step 6,
 *  which replaces these writers with pane-correct retargetFocus/openFocus). */
function resolveBridgePaneSession(nodeId: string): { pane: string | null; session: string | null } {
  try {
    const row = getRow(nodeId);
    if (row?.pane != null && row.pane !== '') {
      return { pane: row.pane, session: row.tmux_session ?? null };
    }
    if (inTmux()) {
      const cur = currentTmux();
      if (cur) return { pane: cur.pane, session: cur.session };
    }
  } catch {
    /* best-effort */
  }
  return { pane: null, session: null };
}

/** Mirror the current focus into the single canonical focuses row. `''` closes
 *  it (focus cleared). Otherwise re-point the row at `nodeId`: drop the prior
 *  canonical row and any row already holding `nodeId` (UNIQUE(node_id) safety)
 *  before re-inserting. All best-effort — a failure here must never break a
 *  setFocus caller or the build. */
function syncBridgeFocusRow(nodeId: string): void {
  try {
    if (nodeId === '') {
      closeFocusRow(BRIDGE_FOCUS_ID);
      return;
    }
    // Step 6: retargetFocus/openFocus now write REAL (pane-correct) focus rows.
    // If one already shows this node, the table is already authoritative —
    // focus.ptr (the file, written above) names the node and getFocus's fallback
    // reads the real row. Drop any stale bridge row and PIGGYBACK on the real
    // one; never duplicate-insert (UNIQUE node_id) or clobber it.
    const real = getFocusByNode(nodeId);
    if (real !== null && real.focus_id !== BRIDGE_FOCUS_ID) {
      closeFocusRow(BRIDGE_FOCUS_ID);
      return;
    }
    const { pane, session } = resolveBridgePaneSession(nodeId);
    closeFocusRow(BRIDGE_FOCUS_ID);
    openFocusRow(BRIDGE_FOCUS_ID, pane, session, nodeId);
  } catch {
    /* dual-write is best-effort; never surface */
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** True when the node's tmux window is alive.  A falsy tmux_session/window
 *  always returns false so callers don't need to null-guard. */
export function nodeLive(meta: NodeMeta): boolean {
  return windowAlive(meta.tmux_session, meta.window);
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/** Bring a node's tmux window to the foreground and record it as focused.
 *
 * Strategy:
 *   - If the node has no live window (`nodeLive` is false), still write the
 *     focus pointer — the caller (e.g. revive logic) uses `focused:false` to
 *     know it needs to open a window first.
 *   - Otherwise call `switchClient` (lands us in the right session) then
 *     `selectWindow` (picks the right window within it).  Both calls are
 *     best-effort; the focus pointer is always written regardless.
 *
 * Returns:
 *   focused — whether the tmux focus actually succeeded.
 *   session — the tmux session name if one was attempted, null otherwise. */
export function focusNode(nodeId: string): { focused: boolean; session: string | null } {
  const meta = getNode(nodeId);

  // Always write the pointer so the dashboard reflects intent even when focus
  // fails (e.g. we're not currently inside tmux).
  setFocus(nodeId);

  if (meta === null || !nodeLive(meta)) {
    // Node not found or window is gone — caller may need to revive.
    return { focused: false, session: meta?.tmux_session ?? null };
  }

  // Both fields are non-null thanks to nodeLive() returning true.
  const session = meta.tmux_session as string;
  const window = meta.window as string;

  // Cross-session hop first, then window selection within the session.
  // switchClient may be a no-op when already in the same session but is
  // always safe to call — tmux handles it gracefully.
  const clientOk = switchClient(session);
  const windowOk = selectWindow(session, window);

  return { focused: clientOk && windowOk, session };
}
