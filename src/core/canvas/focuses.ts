// focuses.ts — the FOCUS table data-access layer (canvas.db, migration v6).
//
// Part of the canvas data-access layer: Q7 widens canvas.db from "topology" to
// "topology + focuses", so the focus-row SQL lives here beside the node+edge
// model, never in the runtime layer. A FOCUS is one durable on-screen viewport
// bound to one node; the table is PLURAL (many focuses across windows/sessions),
// the generalization of the old single focus pointer. It is the CANONICAL focus
// store — there is no focus.ptr file and no dual-write bridge.
//
// placement.ts COMPOSES over these atomic setters/reads (the same way it calls
// setPresence) — it never runs raw focus SQL itself.
//
// Each setter is a single atomic statement. UNIQUE(node_id) upholds "a node
// occupies at most one focus" (Q5): a second focus row (or an occupant UPDATE)
// for an already-focused node throws — that is correct, the Q5 vacate-first
// orchestration is retargetFocus's job (Step 6), not these setters'.

import { openDb } from './db.js';
import type { FocusRow } from './types.js';

function focusFrom(r: Record<string, unknown>): FocusRow {
  return {
    focus_id: r['focus_id'] as string,
    pane: (r['pane'] as string | null) ?? null,
    session: (r['session'] as string | null) ?? null,
    node_id: r['node_id'] as string,
  };
}

// ---------------------------------------------------------------------------
// Atomic setters — each one a single-statement INSERT/UPDATE/DELETE.
// ---------------------------------------------------------------------------

/** INSERT a viewport. Throws on UNIQUE(node_id) if `node_id` already occupies
 *  another focus (or on PK conflict if `focus_id` exists) — by design. */
export function openFocusRow(
  focus_id: string,
  pane: string | null,
  session: string | null,
  node_id: string,
): void {
  openDb()
    .prepare('INSERT INTO focuses (focus_id, pane, session, node_id) VALUES (?, ?, ?, ?)')
    .run(focus_id, pane, session, node_id);
}

/** Hot-swap a focus's occupant — single-statement UPDATE. Respects
 *  UNIQUE(node_id): if `node_id` already occupies ANOTHER focus this throws
 *  (correct — vacate-first is retargetFocus's job, Step 6, not this setter's). */
export function setFocusOccupant(focus_id: string, node_id: string): void {
  openDb().prepare('UPDATE focuses SET node_id = ? WHERE focus_id = ?').run(node_id, focus_id);
}

/** Re-point a focus's durable pane + its derived session cache — for
 *  reconcileFocus / the daemon (Step 6). Single-statement UPDATE. */
export function setFocusPane(focus_id: string, pane: string | null, session: string | null): void {
  openDb()
    .prepare('UPDATE focuses SET pane = ?, session = ? WHERE focus_id = ?')
    .run(pane, session, focus_id);
}

/** DELETE a viewport. */
export function closeFocusRow(focus_id: string): void {
  openDb().prepare('DELETE FROM focuses WHERE focus_id = ?').run(focus_id);
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** The focus a node occupies (≤1, UNIQUE node_id), or null. */
export function getFocusByNode(node_id: string): FocusRow | null {
  const r = openDb()
    .prepare('SELECT * FROM focuses WHERE node_id = ?')
    .get(node_id) as Record<string, unknown> | undefined;
  return r ? focusFrom(r) : null;
}

/** The focus realized by a given pane (`%id`), or null. */
export function getFocusByPane(pane: string): FocusRow | null {
  const r = openDb()
    .prepare('SELECT * FROM focuses WHERE pane = ?')
    .get(pane) as Record<string, unknown> | undefined;
  return r ? focusFrom(r) : null;
}

/** A focus by its stable id, or null. Used by placement to read a row back by id
 *  (handFocusToManager / retargetFocus / registerRootFocus). */
export function getFocusById(focus_id: string): FocusRow | null {
  const r = openDb()
    .prepare('SELECT * FROM focuses WHERE focus_id = ?')
    .get(focus_id) as Record<string, unknown> | undefined;
  return r ? focusFrom(r) : null;
}

/** Every focus row, ordered by id. */
export function listFocuses(): FocusRow[] {
  return (
    openDb().prepare('SELECT * FROM focuses ORDER BY focus_id').all() as Record<string, unknown>[]
  ).map(focusFrom);
}
