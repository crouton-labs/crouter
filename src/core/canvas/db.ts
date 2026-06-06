// canvas.db — the topology skeleton. sqlite in WAL mode so the many concurrent
// writers a sisyphus-grade swarm produces don't contend on a single locked JSON.
//
// Node rows are a rebuildable index over each node's meta.json (the source of
// truth). The `subscribes_to` edges are the one genuinely-mutable part no meta
// owns, so the db is authoritative for them.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { canvasDbPath, ensureHome, nodesRoot, nodeMetaPath } from './paths.js';

// --- Schema as a forward-only migration list ------------------------------
//
// The schema is the migration list: one place a schema change is expressed,
// one gate (`PRAGMA user_version`) that applies it. `migrate()` runs every
// pending step in order and bumps `user_version` after each, so a fresh db and
// the live fleet (all at `user_version 0`) converge on the same final shape.
// Migrations are append-only and forward-only — never edit a shipped step.

/** v1 — the baseline tables + indexes. `IF NOT EXISTS` makes this a no-op on
 *  any existing db (the live fleet already has these tables). */
function baselineSchema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  node_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'base',
  lifecycle  TEXT NOT NULL DEFAULT 'terminal',
  status     TEXT NOT NULL DEFAULT 'active',
  cwd        TEXT NOT NULL,
  parent     TEXT,
  created    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  type     TEXT NOT NULL,           -- 'subscribes_to' | 'spawned_by'
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  created  TEXT NOT NULL,
  PRIMARY KEY (type, from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(type, from_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
`);
}

/** v2 — additive runtime columns the keystone (Phase 2) will make
 *  authoritative: `intent, pi_pid, window, tmux_session`. `status` already
 *  lives in the baseline row, so it is NOT re-added here. All four default to
 *  NULL, so nothing observes a behavior change until a later phase reads them. */
function addRuntimeColumns(db: DatabaseSync): void {
  db.exec(`ALTER TABLE nodes ADD COLUMN intent       TEXT;`);
  db.exec(`ALTER TABLE nodes ADD COLUMN pi_pid       INTEGER;`);
  db.exec(`ALTER TABLE nodes ADD COLUMN window       TEXT;`);
  db.exec(`ALTER TABLE nodes ADD COLUMN tmux_session TEXT;`);
}

/** v3 — DATA backfill (keystone, Phase 2). The runtime fields
 *  (`intent, pi_pid, window, tmux_session`) become authoritative in the row;
 *  copy each existing node's values out of its meta.json into the row columns
 *  once, so the version boundary loses no live state. `status` already mirrors
 *  the row, so it is not re-copied.
 *
 *  LAYERING NOTE (explicitly sanctioned by the runtime-fix plan): a *data*
 *  migration must read meta.json, which db.ts normally would not. Reading it
 *  directly here — via paths.ts, a one-time, clearly-labeled boot-time data
 *  migration — is the deliberate choice over splitting the `user_version`
 *  counter across two modules. Idempotent and gated: it runs exactly once at the
 *  v2→v3 boundary. An UPDATE for a node with no row yet hits 0 rows (harmless). */
function backfillRuntime(db: DatabaseSync): void {
  const root = nodesRoot();
  if (!existsSync(root)) return;
  const upd = db.prepare(
    'UPDATE nodes SET intent = ?, pi_pid = ?, "window" = ?, tmux_session = ? WHERE node_id = ?',
  );
  for (const id of readdirSync(root)) {
    const p = nodeMetaPath(id);
    if (!existsSync(p)) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // a single unreadable meta never aborts the migration
    }
    upd.run(
      (meta['intent'] as string | null) ?? null,
      (meta['pi_pid'] as number | null) ?? null,
      (meta['window'] as string | null) ?? null,
      (meta['tmux_session'] as string | null) ?? null,
      id,
    );
  }
}

/** v4 — edges referential integrity (IRREVERSIBLE table rebuild). Rebuild the
 *  `edges` table so `from_id`/`to_id` are FOREIGN KEYs to `nodes(node_id)` with
 *  `ON DELETE CASCADE`: after this, deleting a node can NEVER orphan an edge —
 *  the schema GCs them, so prune (and any future delete) doesn't have to. The
 *  cargo-cult `PRAGMA foreign_keys = ON` (openDb) finally enforces something.
 *
 *  GOTCHA — pre-existing orphan edges. Nothing ever deleted a node before this
 *  phase, but manual dir removals / failed spawns can have left `edges` whose
 *  endpoint has no `nodes` row. Copying those into the FK-constrained table
 *  would violate the constraint, so the rebuild runs with `foreign_keys = OFF`
 *  (it MUST be toggled in autocommit — a no-op inside a txn) and the
 *  INSERT…SELECT FILTERS orphans: only edges whose BOTH endpoints have a row
 *  survive. `PRAGMA foreign_key_check` then confirms the rebuilt table is clean,
 *  and a row-count assertion guards that every NON-orphan edge is preserved.
 *
 *  CRASH-SAFETY — the whole rebuild is one transaction. A throw ROLLs it back to
 *  the pre-v4 state (the `edges_new` scratch table and all copies vanish) and
 *  `user_version` stays at 3, so the next open re-runs v4 cleanly: no half-state.
 *  Even a crash between COMMIT and the version bump is safe — re-running v4 over
 *  an already-rebuilt (clean) `edges` is idempotent in effect. */
function edgesForeignKeyCascade(db: DatabaseSync): void {
  // Degenerate db with no `edges` table (a real db always has it — v1 created it
  // — but a hand-seeded fixture may not). Nothing to rebuild; create the
  // FK-shaped table fresh so the schema still converges, then we're done.
  const hasEdges =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edges'")
      .get() !== undefined;
  if (!hasEdges) {
    db.exec(`
CREATE TABLE edges (
  type     TEXT NOT NULL,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  created  TEXT NOT NULL,
  PRIMARY KEY (type, from_id, to_id),
  FOREIGN KEY (from_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES nodes(node_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(type, from_id);
`);
    return;
  }

  // FK enforcement must be toggled OUTSIDE a transaction (a no-op within one).
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    // Non-orphan edges that MUST survive the rebuild (both endpoints present).
    const expected = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE from_id IN (SELECT node_id FROM nodes)
             AND to_id   IN (SELECT node_id FROM nodes)`,
        )
        .get() as { n: number }
    ).n;

    db.exec('BEGIN');
    try {
      db.exec(`
CREATE TABLE edges_new (
  type     TEXT NOT NULL,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  created  TEXT NOT NULL,
  PRIMARY KEY (type, from_id, to_id),
  FOREIGN KEY (from_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES nodes(node_id) ON DELETE CASCADE
);
INSERT INTO edges_new (type, from_id, to_id, active, created)
  SELECT type, from_id, to_id, active, created FROM edges
  WHERE from_id IN (SELECT node_id FROM nodes)
    AND to_id   IN (SELECT node_id FROM nodes);
DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(type, from_id);
`);

      // Row-count assertion: every non-orphan edge preserved across the rebuild.
      const after = (
        db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
      ).n;
      if (after !== expected) {
        throw new Error(
          `edges FK rebuild lost rows: expected ${expected} non-orphan edge(s), got ${after}`,
        );
      }

      // Belt-and-suspenders: the rebuilt table must hold no FK violations (the
      // orphan filter above should guarantee this).
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(
          `edges FK rebuild left ${violations.length} foreign-key violation(s)`,
        );
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** v5 — additive runtime column `pane`: LOCATION's authoritative handle, the
 *  durable tmux `%pane_id` a node's pane is anchored on. Unlike the derived
 *  `window`/`tmux_session` cache (v2), the pane id survives a user
 *  `move-pane`/`join-pane`/`break-pane` and window renumbering, so a later step
 *  reconciles window/session FROM it and uses pane-existence for liveness.
 *  Defaults NULL — nothing reads it until the placement layer lands, so this
 *  observes no behavior change. Additive, forward-only. */
function addPaneColumn(db: DatabaseSync): void {
  db.exec(`ALTER TABLE nodes ADD COLUMN pane TEXT;`);
}

/** v6 — the `focuses` table: durable, PLURAL on-screen viewports, one row per
 *  viewport (Q7 widens canvas.db from "topology" to "topology + focuses"). Each
 *  row is anchored on the durable tmux `%pane_id`; `session` is a derived cache
 *  reconciled from the pane; `node_id` is UNIQUE so a node occupies at most one
 *  focus (Q5). Additive, forward-only — nothing reads it as authority yet (Step 4
 *  populates it in lockstep with the legacy `focus.ptr` via a transitional
 *  dual-write; the switch to table-as-authority lands in Step 6). */
function addFocusesTable(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS focuses (
  focus_id  TEXT PRIMARY KEY,   -- stable internal id for the viewport
  pane      TEXT,               -- the durable %pane_id realizing the focus
  session   TEXT,               -- derived cache of the user session (reconciled from pane)
  node_id   TEXT NOT NULL UNIQUE -- the node shown; UNIQUE → a node occupies <=1 focus
);
`);
}

/** The ordered migration list. Index `i` is migration version `i + 1`; the db's
 *  `user_version` tracks how many have been applied. Append only. */
export const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  /* v1 */ baselineSchema,
  /* v2 */ addRuntimeColumns,
  /* v3 */ backfillRuntime,
  /* v4 */ edgesForeignKeyCascade,
  /* v5 */ addPaneColumn,
  /* v6 */ addFocusesTable,
];

/** Bring `db` up to the latest schema version. Reads `user_version`, runs each
 *  pending migration in order, and bumps `user_version` after each so the work
 *  is gated and idempotent: re-running is a no-op once `user_version` reaches
 *  `MIGRATIONS.length`. Forward-only. */
export function migrate(db: DatabaseSync): void {
  let v = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  for (; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v]!(db);
    // `user_version` takes no bound parameters; v is a controlled integer.
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
}

const handles = new Map<string, DatabaseSync>();

/** Open (or reuse) the canvas db at the current `CRTR_HOME`, initializing the
 *  schema and WAL on first open. Keyed by path so tests with distinct homes get
 *  independent handles. */
export function openDb(): DatabaseSync {
  const path = canvasDbPath();
  const existing = handles.get(path);
  if (existing) return existing;

  ensureHome();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // Load-bearing as of migration v4: the edges→nodes FK (ON DELETE CASCADE)
  // needs this ON at the deleting connection so a node delete reaps its edges.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  handles.set(path, db);
  return db;
}

/** Close and forget the handle for the current home. Mainly for tests. */
export function closeDb(): void {
  const path = canvasDbPath();
  const db = handles.get(path);
  if (db) {
    db.close();
    handles.delete(path);
  }
}
