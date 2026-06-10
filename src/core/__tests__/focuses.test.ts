// Run with: node --import tsx/esm --test src/core/__tests__/focuses.test.ts
//
// The `focuses` table (canvas.db, migration v6) + its canvas setters + the
// placement reads that compose over them. The table is the CANONICAL focus store
// — there is no focus.ptr file and no dual-write bridge. Covers:
//   - migration v6 adds `focuses` to a fresh db (and a legacy v5 db migrates up);
//     idempotent / forward-only on re-run + re-open
//   - canvas setters/reads round-trip: open / setOccupant / setPane / close;
//     getFocusByNode / getFocusByPane / getFocusById / listFocuses
//   - UNIQUE(node_id): a second focus row (and an occupant UPDATE) for one node
//     is rejected (upholds "a node occupies <=1 focus", Q5)
//   - independent focus rows don't contend
//   - placement focusOf / isFocused / focusByPane / focusedNodes / listFocuses
//     GC dead-pane viewer rows on read (liveOrPrune), and pass null-pane rows
//     through (broker-host cut: placement reads self-heal the viewer registry)
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openFocusRow,
  setFocusOccupant,
  setFocusPane,
  closeFocusRow,
  getFocusByNode,
  getFocusByPane,
  getFocusById,
  listFocuses,
} from '../canvas/focuses.js';
import { openDb, closeDb, migrate, MIGRATIONS } from '../canvas/db.js';
import { canvasDbPath, ensureHome } from '../canvas/paths.js';
import {
  focusOf,
  isFocused,
  focusByPane,
  focusedNodes,
  listFocuses as placementListFocuses,
} from '../runtime/placement.js';

let home: string;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-focuses-'));
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
// Migration v6 — the additive `focuses` table.
// ---------------------------------------------------------------------------

test('a fresh db migrates to the latest version and has the focuses table', () => {
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.ok(tableNames(db).includes('focuses'), 'focuses table exists on a fresh db');
});

test('the focuses table has the v6 shape (UNIQUE node_id, nullable pane/session)', () => {
  const db = openDb();
  const cols = db.prepare('PRAGMA table_info(focuses)').all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(cols.map((c) => [c.name, c]));
  assert.equal(byName.get('focus_id')?.pk, 1, 'focus_id is the primary key');
  assert.equal(byName.get('node_id')?.notnull, 1, 'node_id is NOT NULL');
  assert.equal(byName.get('pane')?.notnull, 0, 'pane is nullable');
  assert.equal(byName.get('session')?.notnull, 0, 'session is nullable');
  // node_id carries a UNIQUE index.
  const idx = db.prepare('PRAGMA index_list(focuses)').all() as Array<{ unique: number }>;
  assert.ok(
    idx.some((i) => i.unique === 1),
    'a UNIQUE index exists (the node_id constraint)',
  );
});

test('a v5 db migrates forward, adding focuses without disturbing existing data', () => {
  // Hand-build a db at exactly v5: baseline + the four v2 runtime columns + the
  // v5 pane column + edges WITH the v4 FK shape, user_version=5 — the shape just
  // before v6.
  ensureHome();
  const raw = new DatabaseSync(canvasDbPath());
  raw.exec(`
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'base', lifecycle TEXT NOT NULL DEFAULT 'terminal',
      status TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL, parent TEXT,
      created TEXT NOT NULL,
      intent TEXT, pi_pid INTEGER, window TEXT, tmux_session TEXT, pane TEXT
    );
    CREATE TABLE edges (
      type TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL,
      PRIMARY KEY (type, from_id, to_id),
      FOREIGN KEY (from_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (to_id)   REFERENCES nodes(node_id) ON DELETE CASCADE
    );
    PRAGMA user_version = 5;
  `);
  raw
    .prepare('INSERT INTO nodes (node_id, name, kind, status, cwd, created, window, tmux_session, pane) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('legacy', 'Legacy', 'general', 'idle', '/tmp/work', '2020-01-01T00:00:00Z', '@9', 'crtr', '%3');
  assert.equal(userVersion(raw), 5);
  assert.ok(!tableNames(raw).includes('focuses'), 'precondition: no focuses table at v5');
  raw.close();

  // openDb() runs v6 forward.
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  assert.ok(tableNames(db).includes('focuses'), 'focuses table added by v6');

  // The pre-existing node row is intact (the v6 migration only adds a table).
  const row = db
    .prepare('SELECT status, window, tmux_session, pane FROM nodes WHERE node_id = ?')
    .get('legacy') as Record<string, unknown>;
  assert.equal(row['status'], 'idle', 'existing status untouched');
  assert.equal(row['window'], '@9', 'existing window untouched');
  assert.equal(row['tmux_session'], 'crtr', 'existing session untouched');
  assert.equal(row['pane'], '%3', 'existing pane untouched');

  // The fresh focuses table is empty.
  const n = (db.prepare('SELECT COUNT(*) AS n FROM focuses').get() as { n: number }).n;
  assert.equal(n, 0, 'a fresh focuses table starts empty');
});

test('the v6 migration is idempotent / forward-only on re-run and re-open', () => {
  const db = openDb();
  assert.equal(userVersion(db), MIGRATIONS.length);
  // Re-running migrate() is a no-op — the gate skips applied steps. The CREATE
  // TABLE IF NOT EXISTS would be harmless anyway, but the gate must not re-fire.
  assert.doesNotThrow(() => migrate(db));
  assert.equal(userVersion(db), MIGRATIONS.length);
  // Re-opening from disk is likewise a no-op.
  closeDb();
  const db2 = openDb();
  assert.equal(userVersion(db2), MIGRATIONS.length);
  assert.ok(tableNames(db2).includes('focuses'));
});

// ---------------------------------------------------------------------------
// Canvas setters / reads — open / setOccupant / setPane / close round-trip.
// ---------------------------------------------------------------------------

test('open / setOccupant / close round-trip with the reads', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A');

  // getFocusByNode / getFocusByPane / getFocusById all resolve the same row.
  const byNode = getFocusByNode('A');
  assert.deepEqual(byNode, { focus_id: 'f1', pane: '%a', session: 'Sa', node_id: 'A' });
  assert.deepEqual(getFocusByPane('%a'), byNode);
  assert.deepEqual(getFocusById('f1'), byNode);
  assert.deepEqual(listFocuses(), [byNode]);

  // setFocusOccupant hot-swaps the occupant in place (same focus_id/pane).
  setFocusOccupant('f1', 'B');
  assert.equal(getFocusByNode('A'), null, 'A no longer occupies the focus');
  assert.deepEqual(getFocusByNode('B'), { focus_id: 'f1', pane: '%a', session: 'Sa', node_id: 'B' });

  // setFocusPane re-points the pane + session cache after a viewer move.
  setFocusPane('f1', '%a2', 'Sa2');
  assert.deepEqual(getFocusById('f1'), { focus_id: 'f1', pane: '%a2', session: 'Sa2', node_id: 'B' });
  assert.equal(getFocusByPane('%a'), null, 'the old pane no longer resolves');
  assert.deepEqual(getFocusByPane('%a2')?.node_id, 'B');

  // closeFocusRow deletes the viewport.
  closeFocusRow('f1');
  assert.equal(getFocusByNode('B'), null);
  assert.equal(getFocusById('f1'), null);
  assert.deepEqual(listFocuses(), []);
});

test('UNIQUE(node_id): a second focus row for the same node is rejected', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A');
  // A second viewport occupied by the SAME node violates UNIQUE(node_id) — this
  // is the constraint that upholds "a node occupies <=1 focus" (Q5).
  assert.throws(() => openFocusRow('f2', '%b', 'Sb', 'A'), /UNIQUE|constraint/i);
  // The first row is untouched; no stray second row was created.
  assert.deepEqual(
    listFocuses().map((f) => f.focus_id),
    ['f1'],
  );
});

test('UNIQUE(node_id): hot-swapping an occupant onto an already-focused node is rejected', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A');
  openFocusRow('f2', '%b', 'Sb', 'B');
  // B already occupies f2 — moving it onto f1 via setFocusOccupant must throw
  // (the Q5 vacate-first is placement.focus()'s job, not this setter's).
  assert.throws(() => setFocusOccupant('f1', 'B'), /UNIQUE|constraint/i);
  assert.deepEqual(getFocusByNode('A'), { focus_id: 'f1', pane: '%a', session: 'Sa', node_id: 'A' });
  assert.deepEqual(getFocusByNode('B'), { focus_id: 'f2', pane: '%b', session: 'Sb', node_id: 'B' });
});

test('independent focus rows do not contend', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A');
  openFocusRow('f2', '%b', 'Sb', 'B');
  // Mutating one viewport leaves the other entirely intact.
  setFocusOccupant('f1', 'C');
  setFocusPane('f1', '%a2', 'Sa2');
  assert.deepEqual(getFocusByNode('B'), { focus_id: 'f2', pane: '%b', session: 'Sb', node_id: 'B' });
  closeFocusRow('f1');
  assert.deepEqual(getFocusByNode('B'), { focus_id: 'f2', pane: '%b', session: 'Sb', node_id: 'B' });
  assert.deepEqual(
    listFocuses().map((f) => f.focus_id),
    ['f2'],
  );
});

// ---------------------------------------------------------------------------
// Placement reads — focusOf / isFocused / focusByPane / focusedNodes /
// listFocuses GC dead-pane viewer rows on read (broker-host cut: liveOrPrune).
// A row whose viewer pane no longer exists is pruned the next time it is read,
// so the registry self-heals without a sweeper; a row with a null pane (a
// registered-but-not-yet-realized viewer) is passed through. A live tmux pane
// can't be fabricated in the fast tier, so we cover the prune + null-pane paths
// here; the live-pane read is covered in the full-tier broker lifecycle suite.
// ---------------------------------------------------------------------------

test('placement reads GC dead-pane viewer rows and keep null-pane rows', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A'); // %a is not a live tmux pane → pruned on read
  openFocusRow('f2', null, 'Sb', 'B'); // null pane (not realized yet) → kept

  // The dead-pane row is GC'd on read: placement returns null AND the row is
  // removed from the canvas table (self-healing registry).
  assert.equal(focusOf('A'), null, 'a viewer whose pane is gone is pruned on read');
  assert.equal(getFocusByNode('A'), null, 'the pruned row is closed in the db');
  assert.equal(isFocused('A'), false);
  assert.equal(focusByPane('%a'), null, 'focusByPane prunes the dead pane too');

  // The null-pane row survives (liveOrPrune only prunes a non-null dead pane).
  assert.deepEqual(focusOf('B'), { focus_id: 'f2', pane: null, session: 'Sb', node_id: 'B' });
  assert.equal(isFocused('B'), true);
  assert.equal(focusOf('Z'), null, 'an unfocused node has no focus');
  assert.equal(isFocused('Z'), false);
  assert.deepEqual(focusedNodes(), new Set(['B']));
  assert.deepEqual(
    placementListFocuses().map((f) => f.node_id),
    ['B'],
  );
});
