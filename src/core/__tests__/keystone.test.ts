// Phase 2 keystone — runtime authority moved into the WAL'd row.
//
// These four guard the load-bearing invariants of the split:
//   1. concurrency  — two writers of DIFFERENT runtime fields both land (the old
//                     whole-meta read-modify-write dropped one).
//   2. isolation    — a single-column setter never disturbs the other runtime
//                     fields (single-statement atomicity).
//   3. persistence  — meta.json on disk holds NO runtime fields, yet getNode
//                     still returns them (hydrated from the row).
//   4. backfill     — a v2-shaped db with runtime still in meta migrates (v3) so
//                     runtime lands in the authoritative row.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createNode,
  getNode,
  setStatus,
  setIntent,
  setPresence,
  recordPid,
  clearPid,
} from '../canvas/canvas.js';
import { openDb, closeDb, MIGRATIONS } from '../canvas/db.js';
import {
  nodeDir,
  nodeMetaPath,
  canvasDbPath,
  ensureHome,
} from '../canvas/paths.js';
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

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-keystone-'));
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

// 1. concurrency — both interleaved writers survive.
test('concurrency: an interleaved setStatus and recordPid both land', () => {
  createNode(node('a', { status: 'active', pi_pid: null }));

  // Two writers each take a STALE snapshot, exactly as the old cross-process
  // race did (the daemon stamping pi_pid while the node flips status).
  const snapDaemon = getNode('a');
  const snapNode = getNode('a');
  assert.equal(snapDaemon?.pi_pid ?? null, null);
  assert.equal(snapNode?.status, 'active');

  // Interleave their writes through the atomic per-column setters.
  recordPid('a', 4321); // writer 1 (daemon)
  setStatus('a', 'idle'); // writer 2 (node)

  // Under the OLD whole-meta read-modify-write, writer 2 writing back its stale
  // snapshot (pi_pid still null) would have CLOBBERED writer 1's pid. Atomic
  // single-column UPDATEs serialized by WAL keep BOTH.
  const m = getNode('a');
  assert.equal(m?.pi_pid, 4321, 'the pid write survived');
  assert.equal(m?.status, 'idle', 'the status write survived');
});

// 2. isolation — single-column atomicity in both directions.
test('isolation: setPresence and setStatus/setIntent never disturb each other', () => {
  createNode(node('a', { status: 'active', intent: 'refresh', pi_pid: 99 }));

  setPresence('a', { tmux_session: 's', window: '@1' });
  let m = getNode('a');
  assert.equal(m?.status, 'active', 'status undisturbed by setPresence');
  assert.equal(m?.intent, 'refresh', 'intent undisturbed by setPresence');
  assert.equal(m?.pi_pid, 99, 'pi_pid undisturbed by setPresence');
  assert.equal(m?.tmux_session, 's');
  assert.equal(m?.window, '@1');

  // The reverse: flipping status + intent leaves presence and pid intact.
  setStatus('a', 'done');
  setIntent('a', 'done');
  m = getNode('a');
  assert.equal(m?.status, 'done');
  assert.equal(m?.intent, 'done');
  assert.equal(m?.tmux_session, 's', 'tmux_session undisturbed by setStatus/setIntent');
  assert.equal(m?.window, '@1', 'window undisturbed by setStatus/setIntent');
  assert.equal(m?.pi_pid, 99, 'pi_pid undisturbed by setStatus/setIntent');

  clearPid('a');
  assert.equal(getNode('a')?.pi_pid, null, 'clearPid nulls only the pid');
  assert.equal(getNode('a')?.tmux_session, 's', 'clearPid leaves presence intact');
});

// 3. persistence-split — meta.json has no runtime; getNode still hydrates it.
test('persistence-split: meta.json holds no runtime fields, getNode hydrates them', () => {
  createNode(
    node('a', {
      status: 'active',
      intent: 'refresh',
      pi_pid: 7,
      tmux_session: 's',
      window: '@1',
    }),
  );
  setStatus('a', 'done');
  setPresence('a', { tmux_session: 's2', window: '@2' });

  const raw = JSON.parse(readFileSync(nodeMetaPath('a'), 'utf8')) as Record<string, unknown>;
  for (const k of ['status', 'intent', 'pi_pid', 'window', 'tmux_session']) {
    assert.ok(!(k in raw), `meta.json must NOT contain runtime field "${k}"`);
  }
  // identity is still on disk
  assert.equal(raw['kind'], 'general');
  assert.equal(raw['node_id'], 'a');

  // ...while the hydrated view returns runtime from the authoritative row.
  const m = getNode('a');
  assert.equal(m?.status, 'done');
  assert.equal(m?.tmux_session, 's2');
  assert.equal(m?.window, '@2');
  assert.equal(m?.intent, 'refresh');
  assert.equal(m?.pi_pid, 7);
});

// 4. backfill — v2-shaped db with runtime in meta migrates so runtime lands in
// the row.
test('backfill (v3): runtime in legacy meta.json is copied into the row', () => {
  ensureHome();

  // A legacy meta with runtime STILL on disk (pre-keystone shape).
  mkdirSync(nodeDir('n1'), { recursive: true });
  writeFileSync(
    nodeMetaPath('n1'),
    JSON.stringify(
      {
        node_id: 'n1',
        name: 'N1',
        created: '2020-01-01T00:00:00Z',
        cwd: '/tmp/work',
        kind: 'general',
        mode: 'base',
        lifecycle: 'terminal',
        // legacy runtime, still living in meta.json:
        status: 'idle',
        intent: 'refresh',
        pi_pid: 555,
        window: '@9',
        tmux_session: 'sess',
      },
      null,
      2,
    ),
  );

  // Hand-build a v2-shaped db: all columns present, runtime seeded NULL,
  // user_version 2 (so the runner runs ONLY v3 = backfill).
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
      created    TEXT NOT NULL,
      intent       TEXT,
      pi_pid       INTEGER,
      "window"     TEXT,
      tmux_session TEXT
    );
  `);
  raw
    .prepare(
      'INSERT INTO nodes (node_id, name, kind, mode, lifecycle, status, cwd, parent, created) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run('n1', 'N1', 'general', 'base', 'terminal', 'idle', '/tmp/work', null, '2020-01-01T00:00:00Z');
  raw.exec('PRAGMA user_version = 2;');
  // Precondition: runtime columns are NULL before the backfill.
  const before = raw
    .prepare('SELECT intent, pi_pid, "window", tmux_session FROM nodes WHERE node_id = ?')
    .get('n1') as Record<string, unknown>;
  assert.equal(before['intent'], null);
  assert.equal(before['pi_pid'], null);
  raw.close();

  // openDb() runs the migration runner forward → v3 backfill copies meta→row.
  const db = openDb();
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    MIGRATIONS.length,
  );
  const r = db
    .prepare('SELECT status, intent, pi_pid, "window", tmux_session FROM nodes WHERE node_id = ?')
    .get('n1') as Record<string, unknown>;
  assert.equal(r['status'], 'idle', 'status already mirrored — untouched');
  assert.equal(r['intent'], 'refresh', 'intent backfilled from meta');
  assert.equal(r['pi_pid'], 555, 'pi_pid backfilled from meta');
  assert.equal(r['window'], '@9', 'window backfilled from meta');
  assert.equal(r['tmux_session'], 'sess', 'tmux_session backfilled from meta');

  // And the hydrated view now reflects it.
  const m = getNode('n1');
  assert.equal(m?.intent, 'refresh');
  assert.equal(m?.pi_pid, 555);
  assert.equal(m?.window, '@9');
  assert.equal(m?.tmux_session, 'sess');
});
