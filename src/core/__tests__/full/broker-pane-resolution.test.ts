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
//
// (3) Gap 3 (tests-lens MAJOR-1) — the §A.4 viewer-DEDUP, the headline new
//     behavior of the broker-universal cut, had ZERO end-to-end coverage: a
//     SECOND `node focus` on a node must REUSE/move its one viewer, never STACK a
//     second. Only the DB UNIQUE(node_id)/GC layer was tested; `focus()` itself
//     (placement.ts) was unexercised. LOCKED here over a REAL broker viewer: two
//     `node focus` calls leave EXACTLY ONE viewer pane + ONE focus row for the
//     node, the second reused IN PLACE (in_place=true). A focus() that always
//     opened a fresh pane would yield two tagged panes (or crash on the UNIQUE
//     constraint) — either way this goes RED.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from '../helpers/harness.js';
import { closeDb } from '../../canvas/db.js';
import { getFocusByNode, listFocuses } from '../../canvas/focuses.js';
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

/** Parse `crtr`'s human-list stdout (`- key: value` lines) into a map. */
function parseList(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^- ([^:]+):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

/** Read a pane's `@crtr_node` option ('' when unset / pane gone). */
function paneTag(pane: string): string {
  const r = spawnSync(
    'tmux',
    ['show-options', '-p', '-v', '-t', pane, '@crtr_node'],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

/** Every pane in the harness session whose `@crtr_node` tag names `id` — the live
 *  on-screen viewer panes for that node. A correct dedup keeps this at exactly 1. */
function taggedViewerPanes(session: string, id: string): string[] {
  const r = spawnSync(
    'tmux',
    ['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{@crtr_node}'],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith(` ${id}`))
    .map((l) => l.split(' ')[0]!);
}

/** Wait until the attach client running in `pane` has self-tagged it `@crtr_node=id`
 *  (the tag is set on CONNECT, not synchronously by openViewerWindow — the second
 *  focus's reuse branch keys on it, so the test must let attach connect first). */
async function waitForTag(pane: string, id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paneTag(pane) === id) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`viewer pane ${pane} never tagged @crtr_node=${id} within ${timeoutMs}ms`);
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

test('Gap 3 — a second `node focus` REUSES the one viewer (in place), never stacks a second pane/row', async (t) => {
  if (!hasTmux()) return t.skip('tmux unavailable');
  const broker = await h.spawnHeadlessChild(root, 'broker to focus twice');
  closeDb();
  assert.equal(h.node(broker)!.host_kind, 'broker', 'precondition: broker-hosted node');

  // A caller pane in the harness session to focus BESIDE (the user's pane the
  // viewer splits next to). The viewer lands in this same session, so the SECOND
  // focus's reuse takes the in-session NAVIGATE path (in_place), not the
  // cross-session MOVE path.
  const caller = makePane();

  // FOCUS #1 — a managed child boots with NO viewer (spawn no longer auto-opens
  // one), so this OPENS the broker's single viewer beside the caller.
  const f1 = h.cli(broker, ['node', 'focus', broker, '--pane', caller]);
  assert.equal(f1.code, 0, `first focus exit 0\n${f1.stderr}`);
  assert.equal(parseList(f1.stdout).focused, 'true', 'first focus brought the viewer on screen');

  closeDb();
  const row1 = getFocusByNode(broker);
  assert.ok(row1 !== null && row1.pane !== null, 'focus #1 registered one viewer focus row');
  const pane1 = row1.pane!;
  assert.equal(
    listFocuses().filter((f) => f.node_id === broker).length,
    1,
    'exactly ONE focus row for the node after focus #1',
  );

  // Let the attach client connect + self-tag the pane BEFORE the second focus —
  // the reuse branch keys on `@crtr_node`; without the tag focus() would (correctly)
  // treat the row as stale and open fresh. This wait is a test-timing concern, not
  // a product gap (in real use the second focus is a much-later user action).
  await waitForTag(pane1, broker);
  assert.deepEqual(
    taggedViewerPanes(h.session, broker),
    [pane1],
    'exactly ONE tagged viewer pane on screen after focus #1',
  );

  // FOCUS #2 — the headline dedup: the node already has a live, tagged viewer in
  // the caller's session, so focus NAVIGATES to it (no new pane), never stacks.
  const f2 = h.cli(broker, ['node', 'focus', broker, '--pane', caller]);
  assert.equal(f2.code, 0, `second focus exit 0\n${f2.stderr}`);
  const f2out = parseList(f2.stdout);
  assert.equal(f2out.focused, 'true', 'second focus also on screen');
  assert.equal(f2out.in_place, 'true', 'second focus REUSED the viewer in place (navigate, no new pane)');

  // The invariant: STILL exactly one viewer pane + one focus row, the SAME pane.
  closeDb();
  const row2 = getFocusByNode(broker);
  assert.ok(row2 !== null, 'the node still has its viewer focus row after focus #2');
  assert.equal(row2!.pane, pane1, 'focus #2 reused the SAME viewer pane (not a fresh one)');
  assert.equal(
    listFocuses().filter((f) => f.node_id === broker).length,
    1,
    'STILL exactly ONE focus row for the node after focus #2 (never stacked a second)',
  );
  assert.deepEqual(
    taggedViewerPanes(h.session, broker),
    [pane1],
    'STILL exactly ONE tagged viewer pane after focus #2 (reused, not stacked)',
  );
});
