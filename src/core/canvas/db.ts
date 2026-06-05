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

/** The ordered migration list. Index `i` is migration version `i + 1`; the db's
 *  `user_version` tracks how many have been applied. Append only. */
export const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  /* v1 */ baselineSchema,
  /* v2 */ addRuntimeColumns,
  /* v3 */ backfillRuntime,
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
