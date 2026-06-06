// Run with: node --import tsx/esm --test src/core/__tests__/focuses.test.ts
//
// STEP 4 of the placement/focus migration: the `focuses` table + canvas setters
// + placement reads + the transitional focus.ptr dual-write bridge. Purely
// ADDITIVE: the table is populated in lockstep with the legacy `focus.ptr`, but
// nothing reads it as authority yet (that switch is Step 6). Covers:
//   - migration v6 adds `focuses` to a fresh db (and a legacy v5 db migrates up);
//     idempotent / forward-only on re-run + re-open
//   - canvas setters/reads round-trip: open / setOccupant / setPane / close;
//     getFocusByNode / getFocusByPane / getFocusById / listFocuses
//   - UNIQUE(node_id): a second focus row (and an occupant UPDATE) for one node
//     is rejected (upholds "a node occupies <=1 focus", Q5)
//   - independent focus rows don't contend
//   - placement focusOf / isFocused / focusByPane / focusedNodes / listFocuses
//     agree with the rows
//   - dual-write: setFocus populates the table; getFocus falls back to the table
//     when focus.ptr is absent; setFocus('') clears both
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
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
import { canvasDbPath, ensureHome, crtrHome } from '../canvas/paths.js';
import {
  focusOf,
  isFocused,
  focusByPane,
  focusedNodes,
  listFocuses as placementListFocuses,
} from '../runtime/placement.js';
import { setFocus, getFocus } from '../runtime/presence.js';

let home: string;
// Saved/restored so the bridge always exercises its deterministic no-tmux path
// regardless of whether the suite is run from inside a tmux session.
let savedTmux: string | undefined;

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
  savedTmux = process.env['TMUX'];
  delete process.env['TMUX'];
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  if (savedTmux !== undefined) process.env['TMUX'] = savedTmux;
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

  // setFocusPane re-points the pane + session cache (reconcileFocus, Step 6).
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
  // (the Q5 vacate-first is retargetFocus's job, Step 6, not this setter's).
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
// Placement reads — focusOf / isFocused / focusByPane / focusedNodes / listFocuses
// agree with the rows.
// ---------------------------------------------------------------------------

test('placement focus reads agree with the focus rows', () => {
  openDb();
  openFocusRow('f1', '%a', 'Sa', 'A');
  openFocusRow('f2', '%b', 'Sb', 'B');

  assert.deepEqual(focusOf('A'), { focus_id: 'f1', pane: '%a', session: 'Sa', node_id: 'A' });
  assert.equal(focusOf('Z'), null, 'an unfocused node has no focus');
  assert.equal(isFocused('A'), true);
  assert.equal(isFocused('Z'), false);
  assert.deepEqual(focusByPane('%b'), { focus_id: 'f2', pane: '%b', session: 'Sb', node_id: 'B' });
  assert.deepEqual(focusedNodes(), new Set(['A', 'B']));
  assert.deepEqual(
    placementListFocuses().map((f) => f.node_id),
    ['A', 'B'],
  );
});

// ---------------------------------------------------------------------------
// Dual-write bridge — setFocus populates the table; getFocus falls back to the
// table when focus.ptr is absent; setFocus('') clears both.
// ---------------------------------------------------------------------------

function focusPtrPath(): string {
  return join(crtrHome(), 'focus.ptr');
}

test('setFocus populates the focuses table in lockstep with focus.ptr', () => {
  openDb();
  setFocus('A');
  assert.equal(getFocus(), 'A', 'focus.ptr reads back');
  const row = getFocusByNode('A');
  assert.ok(row, 'a canonical focus row mirrors the current focus');
  assert.equal(row?.node_id, 'A');
  assert.equal(isFocused('A'), true, 'placement.isFocused agrees');
  assert.deepEqual(focusOf('A')?.node_id, 'A', 'placement.focusOf agrees with getFocus');

  // Re-focusing a different node re-points the SAME canonical row (no stray rows,
  // UNIQUE(node_id) upheld).
  setFocus('B');
  assert.equal(getFocus(), 'B');
  assert.equal(getFocusByNode('A'), null, 'the old occupant is dropped');
  assert.equal(getFocusByNode('B')?.node_id, 'B');
  assert.equal(listFocuses().length, 1, 'still exactly one canonical row');
});

test('getFocus falls back to the table when focus.ptr is absent', () => {
  openDb();
  setFocus('A'); // writes both focus.ptr and the canonical row
  // Simulate a missing pointer (a writer that reached only the table, or a lost
  // file): delete focus.ptr and confirm getFocus recovers the focus from the row.
  if (existsSync(focusPtrPath())) unlinkSync(focusPtrPath());
  assert.equal(getFocus(), 'A', 'getFocus recovers the focus from the table');
});

test("setFocus('') clears both the pointer and the canonical focus row", () => {
  openDb();
  setFocus('A');
  assert.equal(getFocus(), 'A');
  assert.ok(getFocusByNode('A'), 'precondition: row present');

  setFocus('');
  assert.equal(getFocus(), null, 'getFocus is null after clear (ptr empty, no row)');
  assert.equal(getFocusByNode('A'), null, 'the canonical row was closed');
  assert.deepEqual(listFocuses(), [], 'no focus rows remain');
});

test('a focus row written directly (no focus.ptr) is visible through getFocus + placement', () => {
  openDb();
  // A writer that reached only the table (the canonical bridge row), with no
  // focus.ptr on disk at all.
  openFocusRow('__focus_ptr__', null, null, 'X');
  assert.ok(!existsSync(focusPtrPath()), 'precondition: no focus.ptr file');
  assert.equal(getFocus(), 'X', 'getFocus falls back to the canonical row');
  assert.equal(isFocused('X'), true);
});
