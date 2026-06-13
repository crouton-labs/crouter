// Run with: node --import tsx/esm --test src/core/__tests__/human-surface-target.test.ts
//
// BUG REGRESSION: `crtr human ask|review|notify` surfaced its humanloop
// TUI in the backstage `crtr` session (the asking node's own pane) — a session
// the user never watches — because spawnAndDetach was called with no `-t`
// target. The fix routes the TUI to the HIGHEST FOCUSED node of the asking
// node's graph (the viewport the user is actually watching the work in).
//
// This locks in the PURE selection (`graphSurfaceTarget`, db-only, no tmux):
// walk the asking node's spine to its root, enumerate the tree root-first, and
// return the focus row of the node closest to the root that occupies a viewport.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, subscribe } from '../canvas/canvas.js';
import { openFocusRow, closeFocusRow, getFocusByNode } from '../canvas/focuses.js';
import { closeDb } from '../canvas/db.js';
import { graphSurfaceTarget } from '../runtime/placement.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;
let savedTmux: string | undefined;

function node(id: string, parent: string | null): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    parent,
  } as NodeMeta;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-human-surface-'));
  process.env['CRTR_HOME'] = home;
  savedTmux = process.env['TMUX'];
  delete process.env['TMUX']; // PURE: graphSurfaceTarget never touches tmux
});

after(() => {
  closeDb();
  if (savedTmux !== undefined) process.env['TMUX'] = savedTmux;
  rmSync(home, { recursive: true, force: true });
});

// Graph R → M → W (parent edges + the auto-subscribe spine the runtime builds:
// a parent subscribes_to its child, so view(R) walks down to M then W).
beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'crtr-human-surface-'));
  process.env['CRTR_HOME'] = home;
  createNode(node('R', null));
  createNode(node('M', 'R'));
  createNode(node('W', 'M'));
  subscribe('R', 'M');
  subscribe('M', 'W');
});

test('highest focused = the root when only the root is on screen', () => {
  openFocusRow('f-r', '%10', 'work', 'R');
  const t = graphSurfaceTarget('W');
  assert.equal(t?.node_id, 'R');
  assert.equal(t?.pane, '%10');
});

test('falls to the focused mid-orchestrator when the root is NOT on screen', () => {
  openFocusRow('f-m', '%20', 'work', 'M');
  assert.equal(graphSurfaceTarget('W')?.node_id, 'M');
});

test('picks the SHALLOWEST focused node when several are on screen', () => {
  openFocusRow('f-m', '%20', 'work', 'M');
  openFocusRow('f-w', '%30', 'work', 'W');
  // M is closer to the root than W → M wins.
  assert.equal(graphSurfaceTarget('W')?.node_id, 'M');

  openFocusRow('f-r', '%10', 'work', 'R');
  // Root trumps everything.
  assert.equal(graphSurfaceTarget('W')?.node_id, 'R');
});

test('null when nothing in the graph is on screen (caller falls back)', () => {
  assert.equal(graphSurfaceTarget('W'), null);
});

test('a focus row with no pane is skipped, not selected', () => {
  openFocusRow('f-r', null, null, 'R'); // focus exists but not yet placed on a pane
  openFocusRow('f-m', '%20', 'work', 'M');
  assert.equal(graphSurfaceTarget('W')?.node_id, 'M');
});

test('the asking node itself, when it is the focused root, is returned', () => {
  openFocusRow('f-r', '%10', 'work', 'R');
  assert.equal(graphSurfaceTarget('R')?.node_id, 'R');
});

test('sanity: a closed focus drops out of the selection', () => {
  openFocusRow('f-m', '%20', 'work', 'M');
  assert.equal(graphSurfaceTarget('W')?.node_id, 'M');
  closeFocusRow('f-m');
  assert.equal(getFocusByNode('M'), null);
  assert.equal(graphSurfaceTarget('W'), null);
});
