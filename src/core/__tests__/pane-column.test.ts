// Run with: node --import tsx/esm --test src/core/__tests__/pane-column.test.ts
//
// STEP 2 of the placement/focus migration: the `pane` runtime column —
// LOCATION's authoritative handle (the durable tmux `%pane_id`). This step is
// PURELY ADDITIVE: the column exists, setPresence writes it, getNode/getRow read
// it back, but nothing READS it for behavior yet (population wires up in Steps
// 3+). Covers:
//   - migration v5 adds `pane` to a fresh db (and a legacy v4 db migrates up)
//   - createNode seeds pane; setPresence writes it atomically with window/session
//   - getNode (hydrated view) + getRow (row) both read pane back
//   - a row never given a pane reads pane=null (legacy/back-compat)
//   - the migration is idempotent / forward-only (re-open is a no-op)
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createNode, getNode, getRow, setPresence } from '../canvas/canvas.js';
import { openDb, closeDb, migrate, MIGRATIONS } from '../canvas/db.js';
import { canvasDbPath, ensureHome } from '../canvas/paths.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function nodeColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-pane-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

// ---------------------------------------------------------------------------
// Migration v5 — the additive `pane` column.
// ---------------------------------------------------------------------------

test('a fresh db migrates to the latest version and has the pane column', () => {
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.ok(nodeColumns(db).includes('pane'), 'nodes.pane exists on a fresh db');
});

test('a v4 db migrates forward, adding pane=NULL without disturbing existing data', () => {
  // Hand-build a db at exactly v4: baseline + the four v2 runtime columns +
  // edges WITH the v4 FK shape, user_version=4 — the shape just before v5.
  ensureHome();
  const raw = new DatabaseSync(canvasDbPath());
  raw.exec(`
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'base', lifecycle TEXT NOT NULL DEFAULT 'terminal',
      status TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL, parent TEXT,
      created TEXT NOT NULL,
      intent TEXT, pi_pid INTEGER, window TEXT, tmux_session TEXT
    );
    CREATE TABLE edges (
      type TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL,
      PRIMARY KEY (type, from_id, to_id),
      FOREIGN KEY (from_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (to_id)   REFERENCES nodes(node_id) ON DELETE CASCADE
    );
    PRAGMA user_version = 4;
  `);
  raw
    .prepare('INSERT INTO nodes (node_id, name, kind, status, cwd, created, window, tmux_session) VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy', 'Legacy', 'general', 'idle', '/tmp/work', '2020-01-01T00:00:00Z', '@9', 'crtr');
  assert.equal(userVersion(raw), 4);
  assert.ok(!nodeColumns(raw).includes('pane'), 'precondition: no pane column at v4');
  raw.close();

  // openDb() runs v5 forward.
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.ok(nodeColumns(db).includes('pane'), 'pane column added by v5');

  // The pre-existing row is intact; its pane backfills NULL (additive default).
  const row = db
    .prepare('SELECT status, window, tmux_session, pane FROM nodes WHERE node_id = ?')
    .get('legacy') as Record<string, unknown>;
  assert.equal(row['status'], 'idle', 'existing status untouched');
  assert.equal(row['window'], '@9', 'existing window untouched');
  assert.equal(row['tmux_session'], 'crtr', 'existing session untouched');
  assert.equal(row['pane'], null, 'pane defaults NULL for a legacy row');
});

test('the migration is idempotent / forward-only on re-run and re-open', () => {
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  // Re-running migrate() is a no-op — the gate skips applied steps, so the v5
  // ALTER ADD COLUMN never fires twice (which would throw "duplicate column").
  assert.doesNotThrow(() => migrate(db));
  assert.equal(userVersion(db), MIGRATIONS.length);
  // Re-opening from disk is likewise a no-op.
  closeDb();
  const db2 = openDb();
  assert.equal(userVersion(db2), MIGRATIONS.length);
  assert.ok(nodeColumns(db2).includes('pane'));
});

// ---------------------------------------------------------------------------
// Round-trip: pane is a RUNTIME field, authoritative in the row, read back by
// both the hydrated view (getNode) and the row (getRow).
// ---------------------------------------------------------------------------

test('createNode seeds pane and getNode/getRow read it back', () => {
  createNode(node('n', { tmux_session: 'crtr', window: '@1', pane: '%5' }));
  assert.equal(getNode('n')?.pane, '%5', 'getNode hydrates pane from the row');
  assert.equal(getRow('n')?.pane, '%5', 'getRow returns pane on the NodeRow');
});

test('a node created without a pane reads pane=null (legacy / back-compat)', () => {
  createNode(node('n', { tmux_session: 'crtr', window: '@1' }));
  assert.equal(getNode('n')?.pane, null, 'no pane given → null on the hydrated view');
  assert.equal(getRow('n')?.pane, null, 'no pane given → null on the row');
});

test('setPresence writes pane atomically alongside window + session', () => {
  createNode(node('n'));
  setPresence('n', { tmux_session: 'user-sess', window: '@2', pane: '%7' });

  const m = getNode('n');
  assert.equal(m?.pane, '%7', 'setPresence wrote the pane');
  assert.equal(m?.window, '@2', 'setPresence wrote the window in the same statement');
  assert.equal(m?.tmux_session, 'user-sess', 'setPresence wrote the session in the same statement');
});

test('setPresence without pane writes null (the Step-2 contract: nobody reads pane yet)', () => {
  createNode(node('n', { pane: '%7' }));
  assert.equal(getNode('n')?.pane, '%7');
  // A presence write that omits pane resets it to null — fine for Step 2 because
  // no reader depends on pane until the placement layer lands (Steps 3+).
  setPresence('n', { tmux_session: 'crtr', window: '@3' });
  assert.equal(getNode('n')?.pane, null, 'omitted pane → null (no half-written LOCATION)');
});

test('pane is a RUNTIME field — it never leaks into meta.json identity', () => {
  createNode(node('n', { pane: '%5' }));
  setPresence('n', { pane: '%9', window: '@1', tmux_session: 'crtr' });
  // meta.json is durable identity only; the runtime pane lives in the row.
  const onDisk = openDb().prepare('SELECT pane FROM nodes WHERE node_id = ?').get('n') as { pane: string };
  assert.equal(onDisk.pane, '%9', 'pane is authoritative in the row');
});
