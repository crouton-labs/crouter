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

import { crtrHome, getNode } from '../canvas/index.js';
import type { NodeMeta } from '../canvas/index.js';
import { selectWindow, switchClient, windowAlive } from './tmux.js';

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
