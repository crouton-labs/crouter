// Run with: node --import tsx/esm --test src/core/__tests__/full/broker-pane-resolution.test.ts
//
// REGRESSION — broker-hosted nodes were second-class in the tmux command
// surface (audit: findings-headless-default.md, Gaps 1 + 2). Two real bugs,
// both observable only with a REAL tmux pane, so this is a FULL-tier test.
//
// (1) Gap 1 — `nodeInPane()` (src/commands/node.ts) resolved a pane via
//     window→node ONLY. A broker engine runs DETACHED with window=null, and its
//     on-screen presence is a `crtr attach` VIEWER pane, so the window lookup
//     never found it: `node cycle`/`recycle`/`close`/`demote`/`lifecycle` all
//     broke when the current pane was a broker viewer. The fix has attach
//     self-tag its pane `@crtr_node=<id>` and nodeInPane resolve that tag first.
//     LOCKED: an untagged pane over a broker resolves undefined (the bug); the
//     SAME pane, once tagged, resolves the broker (the fix).
//
// (2) Gap 2 — `recycleNode()` (src/core/runtime/recycle.ts) always respawned the
//     pane into a fresh TMUX pi root, even for a broker node — silently turning
//     the viewer pane into a tmux engine and dropping out of the broker host
//     model. The fix preserves host_kind: recycling a broker node finalizes it,
//     tears the broker down, and boots a fresh BROKER root the pane re-attaches
//     to. LOCKED: the recycled node is finalized (done) and the fresh root is
//     broker-hosted, not tmux.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from '../helpers/harness.js';
import { closeDb } from '../../canvas/db.js';
import { nodeInPane } from '../../../commands/node.js';
import { recycleNode } from '../../runtime/recycle.js';

let h: Harness;
let root: string;

before(async () => {
  h = await createHarness({ sessionPrefix: 'crtr-brkpane' });
  root = h.spawnRoot('host root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

/** Split a throwaway pane in the harness session; return its %id. */
function makePane(): string {
  const r = spawnSync(
    'tmux',
    ['split-window', '-d', '-t', h.session, '-P', '-F', '#{pane_id}', 'sleep 100000'],
    { encoding: 'utf8' },
  );
  const pane = (r.stdout ?? '').trim();
  assert.ok(pane.startsWith('%'), `expected a %pane_id, got "${pane}" (stderr: ${r.stderr})`);
  return pane;
}

function tagPane(pane: string, value: string): void {
  spawnSync('tmux', ['set-option', '-p', '-t', pane, '@crtr_node', value], { stdio: 'ignore' });
}

test('Gap 1 — nodeInPane resolves a broker node from its tagged viewer pane (undefined when untagged)', async (t) => {
  if (!hasTmux()) return t.skip('tmux unavailable');
  const broker = await h.spawnHeadlessChild(root, 'broker worker');
  closeDb();
  assert.equal(h.node(broker)!.host_kind, 'broker', 'spawned a broker-hosted node');
  assert.equal(h.node(broker)!.window ?? null, null, 'broker engine has window=null (paneless)');

  const viewer = makePane();

  // BUG REPRODUCTION: an untagged pane over a broker is invisible — no node owns
  // this pane's window, and a broker has no window to find, so resolution fails.
  closeDb();
  assert.equal(nodeInPane(viewer), undefined, 'untagged viewer pane → broker is invisible (the bug)');

  // FIX: the viewer self-tag (`@crtr_node`) is the broker's pane handle.
  tagPane(viewer, broker);
  closeDb();
  assert.equal(nodeInPane(viewer), broker, 'tagged viewer pane → resolves the broker (the fix)');

  // A stale tag pointing at a DONE node is ignored (must be live: active/idle).
  spawnSync('tmux', ['kill-pane', '-t', viewer], { stdio: 'ignore' });
});

test('Gap 2 — recycle preserves the broker host: finalizes the node, boots a fresh BROKER root', async (t) => {
  if (!hasTmux()) return t.skip('tmux unavailable');
  const broker = await h.spawnHeadlessChild(root, 'broker to recycle');
  const viewer = makePane();
  tagPane(viewer, broker);
  closeDb();
  assert.equal(nodeInPane(viewer), broker, 'precondition: viewer resolves the broker');

  const res = await recycleNode(broker, viewer);

  closeDb();
  assert.equal(h.node(broker)!.status, 'done', 'recycled broker node is finalized (done)');
  assert.ok(res.newRoot, 'a fresh root was spawned');
  const fresh = h.node(res.newRoot!)!;
  assert.equal(fresh.host_kind, 'broker', 'fresh root PRESERVES the broker host (not a tmux pi root)');
  assert.equal(fresh.parent ?? null, null, 'fresh root is a root (parent=null)');
});
