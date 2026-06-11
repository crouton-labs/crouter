// Bug-regression: on-read doc injection "fires a second time per session".
//
// The on-read substrate hook dedups so a doc surfaces at most once per
// conversation. That dedup set USED to live only in the pi process heap (cleared
// on session_start). But a node's logical session — the .jsonl transcript —
// spans MULTIPLE pi processes: a dormancy → revive(resume) cycle exits the old
// process and launches a fresh `pi --session` that REUSES the same transcript.
// The fresh process started with an empty set, so any doc already injected
// before dormancy got injected AGAIN on the next read.
//
// The fix persists the set to nodes/<id>/injected-docs.json: a resume rehydrates
// it (dedup holds), and only the FRESH-transcript launch paths clear it. These
// tests lock in both halves: the store round-trip, and the dedup surviving a
// simulated revive(resume) while re-surfacing after a fresh launch.
//
// Run: node --import tsx/esm --test src/core/__tests__/on-read-dedup-resume.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../canvas/db.js';
import { injectedDocsPath } from '../canvas/paths.js';
import { spawnNode } from '../runtime/nodes.js';
import { renderOnReadDocs } from '../substrate/on-read.js';
import {
  loadInjectedDocs,
  saveInjectedDocs,
  clearInjectedDocs,
} from '../substrate/injected-store.js';

const FIXTURE_BODY = 'Fixture body that must surface exactly once.';

let home: string;
let work: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-onread-home-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  work = mkdtempSync(join(tmpdir(), 'crtr-onread-work-'));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

test('injected-store round-trips and clears', () => {
  const node = spawnNode({ kind: 'general', cwd: work, parent: null }).node_id;
  assert.deepEqual([...loadInjectedDocs(node)], [], 'cold load is empty');

  saveInjectedDocs(node, new Set(['/a', '/b']));
  assert.deepEqual([...loadInjectedDocs(node)].sort(), ['/a', '/b'], 'save then load round-trips');

  clearInjectedDocs(node);
  assert.ok(!existsSync(injectedDocsPath(node)), 'clear removes the file');
  assert.deepEqual([...loadInjectedDocs(node)], [], 'load after clear is empty');
});

test('on-read doc surfaces once, stays deduped across a revive(resume), re-surfaces after a fresh launch', () => {
  const node = spawnNode({ kind: 'general', cwd: work, parent: null }).node_id;

  // A positional substrate doc in a `.crouter/memory/` ancestor of the read file.
  const memDir = join(work, '.crouter', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'onread-fixture.md'),
    '---\nkind: knowledge\n' +
      'when-and-why-to-read: When reading work files, this reference should be read because it is the on-read regression fixture\n' +
      'file-read-visibility: content\n---\n' +
      `${FIXTURE_BODY}\n`,
  );
  const readFile = join(work, 'src', 'file.ts');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(readFile, 'export const x = 1;\n');

  // --- pi process #1: cold load; first read surfaces the doc ---
  const seen = loadInjectedDocs(node);
  const first = renderOnReadDocs(node, readFile, seen);
  assert.match(first, new RegExp(FIXTURE_BODY.replace(/[.]/g, '\\.')), 'first read surfaces the doc body');
  saveInjectedDocs(node, seen);

  // Same process, repeat read of the same file → deduped in-memory.
  assert.ok(
    !renderOnReadDocs(node, readFile, seen).includes(FIXTURE_BODY),
    'same-process repeat read is deduped',
  );

  // --- dormancy → revive(resume): NEW process rehydrates the set from disk ---
  const seenAfterRevive = loadInjectedDocs(node);
  assert.deepEqual(seenAfterRevive, seen, 'revive(resume) rehydrates the persisted dedup set');
  assert.ok(
    !renderOnReadDocs(node, readFile, seenAfterRevive).includes(FIXTURE_BODY),
    'resumed process does NOT re-inject the doc (the bug)',
  );

  // --- fresh launch (revive resume=false, e.g. a refresh-yield) clears the set ---
  clearInjectedDocs(node);
  const seenFresh = loadInjectedDocs(node);
  assert.ok(
    renderOnReadDocs(node, readFile, seenFresh).includes(FIXTURE_BODY),
    'a fresh transcript surfaces the doc again',
  );
});
