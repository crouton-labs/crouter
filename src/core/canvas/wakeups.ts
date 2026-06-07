// wakeups.ts — the WAKEUPS table data-access layer (canvas.db, migration v7).
//
// One-module-per-table (the focuses.ts precedent): ALL SQL that touches the
// `wakeups` table lives HERE and nowhere else — never appended to canvas.ts,
// which keeps the node/edge model. A WAKEUP is one durable row = "do <kind> at
// fire_at [every recur]", carrying a fire time, a kind, an optional payload, an
// optional recurrence cadence, a nullable TARGET node_id, and the owner_id of
// the node that ARMED it.
//
// Two anchors, two reap rules (design D1/D2):
//   - node_id  → the revive target AND the node-anchored cancel anchor; it
//     carries the `ON DELETE CASCADE` FK, so a pruned node's node-anchored wakes
//     are reaped FOR FREE in pruneNodes' same `DELETE FROM nodes` (canvas.ts is
//     UNTOUCHED — the cascade does it; there is no pruneNodes wakeups code).
//     NULL = canvas-detached (a deferred spawn / spawn-cron).
//   - owner_id → the armer; a PLAIN indexed column with NO FK, so a crashed-
//     then-pruned armer's detached cron is NOT cascade-dropped (Invariant E).
//     Reaped only by the explicit cancelWakesFor DELETE on deliberate close.
//
// Each function is a single-statement query mirroring the canvas.ts atomic-setter
// pattern (setStatus/setIntent/setPresence) — no read-modify-write, serialized by
// WAL. The data-access layer OWNS payload serialization: armWake JSON.stringifies
// the typed per-kind union on write; dueWakes/listWakes JSON.parse it back on read
// (Maj-1), so callers consume `payload.body` / `payload as SpawnChildOpts` directly.
//
// `wakeup_id` is CALLER-SUPPLIED (the command surface mints `wk-${newNodeId()}`):
// the canvas layer never imports newNodeId from runtime/nodes.ts — that would
// force a canvas → runtime → canvas import cycle (Min-1).

import { openDb } from './db.js';
import type { ArmWakeSpec, WakeKind, Wakeup, WakePayload } from './types.js';

/** A thrown integrity-backstop error from armWake. `code` is the AC-N3 code the
 *  command surface (the ONLY sanctioned caller of armWake) maps to a rendered
 *  error block — armWake carries integrity backstops only (empty body / recur-on-
 *  deadline / unknown kind); target-resolvability + recoverable-state + the
 *  per-owner cap live in the surface (Min-6), so a non-surface armer could insert
 *  a dangling wake — every armer MUST route through the surface. */
export class WakeArmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WakeArmError';
  }
}

/** Which wakes a listWakes call returns. Distinguished by which key is present
 *  (mirrors listNodes' filter shape):
 *   - { node }    — wakes anchored to this node (node_id = ?).
 *   - { owner }   — wakes this node ARMED (owner_id = ?); the per-owner cap count.
 *   - { subtree } — wakes anchored to any node in this id set (node_id IN (…)).
 *   - { due }     — wakes whose fire_at <= this ISO instant.
 *   - { canvas }  — every wake on the canvas. */
export type WakeScope =
  | { node: string }
  | { owner: string }
  | { subtree: string[] }
  | { due: string }
  | { canvas: true };

/** Hydrate a raw row into a Wakeup, JSON.parsing `payload` back into the typed
 *  per-kind union (NULL column → null). */
function wakeupFrom(r: Record<string, unknown>): Wakeup {
  const raw = r['payload'] as string | null;
  return {
    wakeup_id: r['wakeup_id'] as string,
    node_id: (r['node_id'] as string | null) ?? null,
    owner_id: r['owner_id'] as string,
    fire_at: r['fire_at'] as string,
    kind: r['kind'] as WakeKind,
    recur: (r['recur'] as string | null) ?? null,
    payload: raw == null ? null : (JSON.parse(raw) as WakePayload),
    created: r['created'] as string,
  };
}

// ---------------------------------------------------------------------------
// Writes — each a single-statement INSERT/UPDATE/DELETE.
// ---------------------------------------------------------------------------

/** INSERT one wakeup row from the pinned spec, returning its (caller-supplied)
 *  `wakeup_id`. JSON.stringifies the typed `payload` union into the TEXT column
 *  and stamps `created`.
 *
 *  Deadline upsert (design Q3, "≤1 deadline per node"): for `kind === 'deadline'`
 *  the node's existing deadline is canceled first, then the new one inserted — the
 *  partial unique index `idx_wakeups_deadline` is the schema-level backstop.
 *
 *  Integrity backstops (throw WakeArmError; the surface maps the code to AC-N3):
 *   - empty/whitespace note `body` for `noted`/`deadline` → `empty_note`.
 *   - non-NULL `recur` on a `deadline`                    → `deadline_cannot_recur`.
 *   - unknown `kind`                                      → `bad_kind`.
 *  NO target-resolvability / recoverable-state / cap backstop here (Min-6). */
export function armWake(spec: ArmWakeSpec): string {
  const { kind } = spec;
  if (kind !== 'bare' && kind !== 'noted' && kind !== 'deadline' && kind !== 'spawn') {
    throw new WakeArmError('bad_kind', `unknown wake kind: ${String(kind)}`);
  }
  if (kind === 'noted' || kind === 'deadline') {
    const body = (spec.payload as { body?: unknown } | null | undefined)?.body;
    if (typeof body !== 'string' || body.trim() === '') {
      throw new WakeArmError('empty_note', `a ${kind} wake requires a non-empty note body.`);
    }
  }
  if (kind === 'deadline' && spec.recur != null) {
    throw new WakeArmError('deadline_cannot_recur', 'a deadline wake cannot recur.');
  }
  // Deadline upsert: clear the node's existing deadline before inserting the new one.
  if (kind === 'deadline' && spec.node_id != null) {
    cancelDeadlinesFor(spec.node_id);
  }
  const payloadText = spec.payload == null ? null : JSON.stringify(spec.payload);
  openDb()
    .prepare(
      `INSERT INTO wakeups (wakeup_id, node_id, owner_id, fire_at, kind, recur, payload, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      spec.wakeup_id,
      spec.node_id ?? null,
      spec.owner_id,
      spec.fire_at,
      kind,
      spec.recur ?? null,
      payloadText,
      new Date().toISOString(),
    );
  return spec.wakeup_id;
}

/** UPDATE the next fire time — recurrence advancement (the daemon settles a
 *  recurring row to its next slot BEFORE enacting, crash-safe; design D4). */
export function advanceWake(wakeup_id: string, nextFireIso: string): void {
  openDb().prepare('UPDATE wakeups SET fire_at = ? WHERE wakeup_id = ?').run(nextFireIso, wakeup_id);
}

/** DELETE one wakeup by id — one-shot consumption (the daemon settles a one-shot
 *  row BEFORE enacting, crash-safe; design D4). */
export function consumeWake(wakeup_id: string): void {
  openDb().prepare('DELETE FROM wakeups WHERE wakeup_id = ?').run(wakeup_id);
}

/** DELETE one wakeup by id — the explicit user/surface cancel. Idempotent:
 *  0 rows ⇒ no error (AC-C2). */
export function cancelWake(wakeup_id: string): void {
  openDb().prepare('DELETE FROM wakeups WHERE wakeup_id = ?').run(wakeup_id);
}

/** DELETE every wake anchored to this node AND every detached wake it ARMED —
 *  deliberate close/reap (ruling A). Hooked at transition('cancel'). */
export function cancelWakesFor(node_id: string): void {
  openDb()
    .prepare('DELETE FROM wakeups WHERE node_id = ? OR owner_id = ?')
    .run(node_id, node_id);
}

/** DELETE this node's one-shot self-alarms (recur IS NULL); node-anchored crons
 *  SURVIVE — finalize is the instance finishing, not a teardown of standing
 *  schedules (design Q1). Hooked at transition('finalize'). */
export function cancelSelfAlarms(node_id: string): void {
  openDb().prepare('DELETE FROM wakeups WHERE node_id = ? AND recur IS NULL').run(node_id);
}

/** DELETE this node's pending deadline(s) — cancel-on-wake (design §6.4).
 *  Hooked at reviveNode, so the deadline always belongs to the dormancy left. */
export function cancelDeadlinesFor(node_id: string): void {
  openDb().prepare("DELETE FROM wakeups WHERE node_id = ? AND kind = 'deadline'").run(node_id);
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** The daemon's per-tick due query: every row whose fire_at has arrived, in
 *  fire_at order, with `payload` parsed into the typed union. Returns exactly ONE
 *  row per recurring wake regardless of missed slots — coalescing is structural
 *  (AC-E2). */
export function dueWakes(nowIso: string): Wakeup[] {
  return (
    openDb()
      .prepare('SELECT * FROM wakeups WHERE fire_at <= ? ORDER BY fire_at')
      .all(nowIso) as Record<string, unknown>[]
  ).map(wakeupFrom);
}

/** List wakes for a scope (node / owner / subtree / due / canvas), `payload`
 *  parsed as in dueWakes. The subtree variant binds the id set with `?`
 *  placeholders (mirroring listNodes — the codebase's one safe dynamic-IN spot);
 *  ids are NEVER string-concatenated (Min-10). */
export function listWakes(scope: WakeScope): Wakeup[] {
  const db = openDb();
  let rows: Record<string, unknown>[];
  if ('node' in scope) {
    rows = db
      .prepare('SELECT * FROM wakeups WHERE node_id = ? ORDER BY fire_at')
      .all(scope.node) as Record<string, unknown>[];
  } else if ('owner' in scope) {
    rows = db
      .prepare('SELECT * FROM wakeups WHERE owner_id = ? ORDER BY fire_at')
      .all(scope.owner) as Record<string, unknown>[];
  } else if ('subtree' in scope) {
    if (scope.subtree.length === 0) return [];
    const placeholders = scope.subtree.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT * FROM wakeups WHERE node_id IN (${placeholders}) ORDER BY fire_at`)
      .all(...scope.subtree) as Record<string, unknown>[];
  } else if ('due' in scope) {
    rows = db
      .prepare('SELECT * FROM wakeups WHERE fire_at <= ? ORDER BY fire_at')
      .all(scope.due) as Record<string, unknown>[];
  } else {
    rows = db.prepare('SELECT * FROM wakeups ORDER BY fire_at').all() as Record<string, unknown>[];
  }
  return rows.map(wakeupFrom);
}

/** True if the node has ANY pending self-anchored wake (of any kind). Consumed by
 *  the stop-guard self-wake seam so a no-child poll node releases dormant after
 *  arming instead of being nagged to finish (AC-X3/AC-R1). */
export function hasPendingSelfWake(node_id: string): boolean {
  return (
    openDb().prepare('SELECT 1 FROM wakeups WHERE node_id = ? LIMIT 1').get(node_id) !== undefined
  );
}
