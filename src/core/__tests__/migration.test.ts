import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, closeDb, migrate, MIGRATIONS } from '../canvas/db.js';
import { canvasDbPath, ensureHome } from '../canvas/paths.js';

const RUNTIME_COLUMNS = ['intent', 'pi_pid', 'window', 'tmux_session'] as const;

let home: string;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

function nodeColumns(db: DatabaseSync): string[] {
  return (
    db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>
  ).map((r) => r.name);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-migration-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  // Fresh db + dirs per test for isolation.
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

test('opening a fresh home migrates to the latest user_version', () => {
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
});

test('a fresh db has the four additive runtime columns', () => {
  const db = openDb();
  const cols = nodeColumns(db);
  for (const c of RUNTIME_COLUMNS) {
    assert.ok(cols.includes(c), `expected nodes.${c} to exist`);
  }
  // `status` predates Phase 1 and must not be duplicated.
  assert.equal(
    cols.filter((c) => c === 'status').length,
    1,
    'status must appear exactly once',
  );
});

test('a simulated v0 db migrates forward without data loss', () => {
  // Build a v0 db by hand: the baseline tables only, user_version 0, no runtime
  // columns — exactly the shape of the live fleet before this phase.
  ensureHome();
  const raw = new DatabaseSync(canvasDbPath());
  raw.exec(`
    CREATE TABLE nodes (
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
    CREATE TABLE edges (
      type     TEXT NOT NULL,
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      active   INTEGER NOT NULL DEFAULT 1,
      created  TEXT NOT NULL,
      PRIMARY KEY (type, from_id, to_id)
    );
  `);
  raw.exec('PRAGMA user_version = 0;');
  raw
    .prepare(
      'INSERT INTO nodes (node_id, name, kind, status, cwd, created) VALUES (?,?,?,?,?,?)',
    )
    .run('n1', 'N1', 'general', 'done', '/tmp/work', '2020-01-01T00:00:00Z');
  raw
    .prepare(
      'INSERT INTO edges (type, from_id, to_id, created) VALUES (?,?,?,?)',
    )
    .run('subscribes_to', 'n1', 'n1', '2020-01-01T00:00:00Z');
  // Precondition: genuinely a v0 db with no runtime columns.
  assert.equal(userVersion(raw), 0);
  assert.ok(!nodeColumns(raw).includes('intent'));
  raw.close();

  // openDb() runs the migration runner forward.
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);

  // Runtime columns now exist.
  const cols = nodeColumns(db);
  for (const c of RUNTIME_COLUMNS) {
    assert.ok(cols.includes(c), `expected nodes.${c} after migration`);
  }

  // Pre-existing data is intact — no loss, no mutation of existing columns.
  const row = db
    .prepare('SELECT node_id, status, cwd FROM nodes WHERE node_id = ?')
    .get('n1') as { node_id: string; status: string; cwd: string };
  assert.equal(row.node_id, 'n1');
  assert.equal(row.status, 'done');
  assert.equal(row.cwd, '/tmp/work');
  const edgeCount = (
    db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
  ).n;
  assert.equal(edgeCount, 1);

  // The new columns are seeded NULL for the migrated row — nothing observed.
  const rt = db
    .prepare('SELECT intent, pi_pid, "window", tmux_session FROM nodes WHERE node_id = ?')
    .get('n1') as Record<string, unknown>;
  assert.equal(rt['intent'], null);
  assert.equal(rt['pi_pid'], null);
  assert.equal(rt['window'], null);
  assert.equal(rt['tmux_session'], null);
});

test('migration is idempotent on re-open and on re-run', () => {
  // First open migrates v0 -> latest.
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);

  // Re-running migrate() directly is a no-op (the gate skips applied steps).
  // If the gate were broken, the second ALTER ADD COLUMN would throw.
  assert.doesNotThrow(() => migrate(db));
  assert.equal(userVersion(db), MIGRATIONS.length);

  // Re-opening from disk is likewise a no-op — no duplicate-column error.
  closeDb();
  const db2 = openDb();
  assert.equal(userVersion(db2), MIGRATIONS.length);
  const cols = nodeColumns(db2);
  for (const c of RUNTIME_COLUMNS) {
    assert.ok(cols.includes(c), `expected nodes.${c} to persist`);
  }
});
