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

import { crtrHome, getNode, setPresence } from '../canvas/index.js';
import type { NodeMeta } from '../canvas/index.js';
import { selectWindow, switchClient, windowAlive, currentTmux, paneOfWindow, swapPaneInPlace, paneLocation } from './tmux.js';

// ---------------------------------------------------------------------------
// Focus pointer
// ---------------------------------------------------------------------------

/** Absolute path to the focus pointer file. */
function focusPtrPath(): string {
  return join(crtrHome(), 'focus.ptr');
}

/** Persist `nodeId` as the currently focused node. Best-effort; never throws. */
export function setFocus(nodeId: string): void {
  try {
    const p = focusPtrPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, nodeId, 'utf8');
  } catch {
    /* focus pointer is best-effort; never surface */
  }
}

/** Read the currently focused node id, or null if the pointer is absent or
 *  empty (no active focus). Best-effort; never throws. */
export function getFocus(): string | null {
  try {
    const raw = readFileSync(focusPtrPath(), 'utf8').trim();
    return raw !== '' ? raw : null;
  } catch {
    return null;
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

/** Focus a node IN PLACE: bring its pane into the caller's current pane slot
 *  (swap-pane) instead of navigating the client to the node's own window. This
 *  is the default for `crtr node focus` and the nav-chrome spine jump — the
 *  agent appears where you are.
 *
 *  Falls back to window focus when there is no caller pane (not inside tmux) or
 *  the target pane can't be resolved. `inPlace` reports which path ran. */
export function focusNodeInPlace(
  nodeId: string,
  callerPane?: string,
  callerNodeId?: string,
): { focused: boolean; session: string | null; inPlace: boolean } {
  const meta = getNode(nodeId);

  // Always write the pointer so the dashboard reflects intent even on failure.
  setFocus(nodeId);

  if (meta === null || !nodeLive(meta)) {
    return { focused: false, session: meta?.tmux_session ?? null, inPlace: false };
  }

  const session = meta.tmux_session as string;
  const window = meta.window as string;
  const pane = callerPane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;

  // No caller pane (not in tmux) — best we can do is bring the window forefront.
  if (pane === undefined || pane === '') {
    const ok = switchClient(session) && selectWindow(session, window);
    return { focused: ok, session, inPlace: false };
  }

  const targetPane = paneOfWindow(session, window);
  if (targetPane === null) {
    const ok = switchClient(session) && selectWindow(session, window);
    return { focused: ok, session, inPlace: false };
  }
  if (targetPane === pane) return { focused: true, session, inPlace: true }; // already here

  // The session + window the caller's pane currently sits in — the slot the
  // target's pane is about to be swapped INTO. Capture BOTH fields, not just
  // the window: an inline root adopts the user's own tmux session while its
  // children live in the shared `crtr` session, so the caller and target can
  // sit in DIFFERENT sessions and swap-pane crosses the session boundary.
  const callerLoc = paneLocation(pane);

  const ok = swapPaneInPlace(targetPane, pane);

  // Keep the canvas (session, window) mapping in sync with the physical swap.
  // swap-pane exchanges the two PANES between their slots (pane ids are stable,
  // window/session are the slot, and a swap can cross sessions): after it the
  // target's pane occupies the caller's slot and the caller's pane occupies the
  // target's old slot. Re-point BOTH fields on BOTH nodes. Updating only
  // `window` after a CROSS-SESSION swap leaves tmux_session naming the wrong
  // session, so the (session, window) pair points at a window that isn't there:
  // windowAlive() then reports the live node dormant, and the next focus tries
  // to revive it — relaunching pi against a stale window, which drops you on the
  // session selector. That was the broken "go back up to the parent" path
  // (root in the user's session ↔ child in the `crtr` session). Window ids are
  // server-global, so a differing window id is a reliable "panes moved" signal.
  if (ok && callerLoc !== null && callerLoc.window !== window) {
    // The focused node's pane now sits in the caller's old slot.
    try { setPresence(nodeId, { tmux_session: callerLoc.session, window: callerLoc.window }); } catch { /* best-effort */ }
    // The caller is the node running this focus (its pi process owns callerPane).
    // Its pane moved to the target's old slot (session, window), so re-point it
    // there. Prefer an explicit id (the `node cycle` tmux binding runs outside
    // any pi, so CRTR_NODE_ID is unset there) and fall back to the env for
    // `node focus`.
    const cnid = callerNodeId ?? process.env['CRTR_NODE_ID'];
    if (cnid !== undefined && cnid.trim() !== '' && cnid !== nodeId) {
      try { setPresence(cnid, { tmux_session: session, window }); } catch { /* best-effort */ }
    }
  }

  return { focused: ok, session, inPlace: true };
}
