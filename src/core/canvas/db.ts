// canvas.db — the topology skeleton. sqlite in WAL mode so the many concurrent
// writers a sisyphus-grade swarm produces don't contend on a single locked JSON.
//
// Node rows are a rebuildable index over each node's meta.json (the source of
// truth). The `subscribes_to` edges are the one genuinely-mutable part no meta
// owns, so the db is authoritative for them.

import { DatabaseSync } from 'node:sqlite';
import { canvasDbPath, ensureHome } from './paths.js';

const SCHEMA = `
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
`;

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
  db.exec(SCHEMA);
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
