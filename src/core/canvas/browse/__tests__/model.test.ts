import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DashboardRow } from '../../render.js';
import type { NodeStatus, Lifecycle } from '../../types.js';
import { buildTree, flatten, fuzzyMatch, pruneNode, tabPredicate, TABS, attentionTier, attentionMtime } from '../model.js';

// ── Fixture canvas ───────────────────────────────────────────────────────────
//   root1 (active)            ← rank 0
//     child-a (idle)
//       grand-x (done)
//     child-b (active, ⚑2)
//   root2 (done)              ← rank 2 (dormant root, but ancestor of a live node)
//     child-c (active)
//   lonely (idle)             ← straggler: in rows, no edge reaches it, not a root

function row(node_id: string, name: string, status: NodeStatus, asks = 0): DashboardRow {
  return { node_id, name, status, kind: 'general', mode: 'base', ctx_tokens: 0, asks, cwd: '/tmp/proj', created: '2026-01-01T00:00:00.000Z' };
}

function lrow(node_id: string, name: string, status: NodeStatus, lifecycle: Lifecycle): DashboardRow {
  return { ...row(node_id, name, status), lifecycle };
}

const ROWS: DashboardRow[] = [
  row('root1', 'root-one', 'active'),
  row('child-a', 'child-a', 'idle'),
  row('grand-x', 'grand-x', 'done'),
  row('child-b', 'child-b', 'active', 2),
  row('root2', 'root-two', 'done'),
  row('child-c', 'child-c', 'active'),
  row('lonely', 'lonely-node', 'idle'),
];

// rootIds intentionally unsorted to prove buildTree sorts live-first.
const ROOT_IDS = ['root2', 'root1'];

const CHILDREN: Record<string, string[]> = {
  root1: ['child-a', 'child-b'],
  'child-a': ['grand-x'],
  root2: ['child-c'],
};
const childIdsOf = (id: string): string[] => CHILDREN[id] ?? [];

function tree() {
  return buildTree(ROWS, ROOT_IDS, childIdsOf);
}

// ── fuzzyMatch ───────────────────────────────────────────────────────────────

test('fuzzyMatch: empty query matches everything', () => {
  assert.equal(fuzzyMatch('', 'whatever'), true);
});

test('fuzzyMatch: case-insensitive subsequence', () => {
  assert.equal(fuzzyMatch('abc', 'aXbXc'), true);
  assert.equal(fuzzyMatch('AB', 'xaYbz'), true);
  assert.equal(fuzzyMatch('grandx', 'grand-x'), true);
});

test('fuzzyMatch: out-of-order is not a match', () => {
  assert.equal(fuzzyMatch('abc', 'acb'), false);
  assert.equal(fuzzyMatch('zz', 'z'), false);
});

// ── buildTree ────────────────────────────────────────────────────────────────

test('buildTree: roots sorted live-first, stragglers appended', () => {
  const t = tree();
  assert.deepEqual(t.roots, ['root1', 'root2', 'lonely']);
});

test('buildTree: depth, parentId, childIds', () => {
  const t = tree();
  assert.equal(t.nodes.size, 7);
  assert.deepEqual(t.nodes.get('root1'), {
    row: ROWS[0], depth: 0, parentId: null, childIds: ['child-a', 'child-b'],
  });
  assert.equal(t.nodes.get('child-a')!.depth, 1);
  assert.equal(t.nodes.get('child-a')!.parentId, 'root1');
  assert.deepEqual(t.nodes.get('child-a')!.childIds, ['grand-x']);
  assert.equal(t.nodes.get('grand-x')!.depth, 2);
  assert.equal(t.nodes.get('grand-x')!.parentId, 'child-a');
  // straggler attaches at depth 0 with no parent
  assert.equal(t.nodes.get('lonely')!.depth, 0);
  assert.equal(t.nodes.get('lonely')!.parentId, null);
});

test('buildTree: unknown child ids are dropped (missing meta safe)', () => {
  const t = buildTree(ROWS, ['root1'], (id) => (id === 'root1' ? ['child-a', 'ghost'] : childIdsOf(id)));
  assert.deepEqual(t.nodes.get('root1')!.childIds, ['child-a']);
  assert.equal(t.nodes.has('ghost'), false);
});

// ── pruneNode ────────────────────────────────────────────────────────────────
// Regression: pressing `x` in canvas browse on an EMPTY active node looked like a
// no-op — closeNode hard-deletes (reaps) an empty node, but doClose never removed
// it from the in-memory tree, so the stale active row kept painting. pruneNode is
// the splice doClose now applies for a reaped (getNode===null) close.

test('pruneNode: reaping a leaf removes it from its parent and the node map', () => {
  const t = tree();
  pruneNode(t, 'grand-x'); // leaf under child-a
  assert.equal(t.nodes.has('grand-x'), false);
  assert.deepEqual(t.nodes.get('child-a')!.childIds, []);
});

test('pruneNode: reaping a mid-tree node re-homes its children to its parent', () => {
  const t = tree();
  pruneNode(t, 'child-a'); // child-a (under root1) owns grand-x
  assert.equal(t.nodes.has('child-a'), false);
  // grand-x lifts into child-a's slot in root1's child order (before child-b).
  assert.deepEqual(t.nodes.get('root1')!.childIds, ['grand-x', 'child-b']);
  assert.equal(t.nodes.get('grand-x')!.parentId, 'root1');
});

test('pruneNode: reaping a root lifts its children into the root list', () => {
  const t = tree();
  const rootIdx = t.roots.indexOf('root2');
  pruneNode(t, 'root2'); // root2 owns child-c
  assert.equal(t.nodes.has('root2'), false);
  assert.equal(t.roots.includes('root2'), false);
  assert.equal(t.roots[rootIdx], 'child-c'); // child-c took root2's slot
  assert.equal(t.nodes.get('child-c')!.parentId, null);
});

test('pruneNode: absent id is a no-op', () => {
  const t = tree();
  const before = t.nodes.size;
  pruneNode(t, 'ghost');
  assert.equal(t.nodes.size, before);
});

// ── tab predicates ───────────────────────────────────────────────────────────

test('tabPredicate: All / Live / Dormant / Flagged', () => {
  assert.deepEqual([...TABS], ['All', 'Live', 'Dormant', 'Flagged']);
  const active = ROWS[0]!; // root1 active
  const idle = ROWS[1]!;   // child-a idle
  const done = ROWS[2]!;   // grand-x done
  const flagged = ROWS[3]!; // child-b active asks 2

  assert.equal(tabPredicate('All', done), true);
  assert.equal(tabPredicate('Live', active), true);
  assert.equal(tabPredicate('Live', idle), true);
  assert.equal(tabPredicate('Live', done), false);
  assert.equal(tabPredicate('Dormant', done), true);
  assert.equal(tabPredicate('Dormant', active), false);
  assert.equal(tabPredicate('Flagged', flagged), true);
  assert.equal(tabPredicate('Flagged', active), false);
});

// ── flatten: collapse / expand ───────────────────────────────────────────────

const allCollapsed = (): Set<string> =>
  new Set(['root1', 'child-a', 'root2']); // every node with children

test('flatten: default-collapsed shows only top-level', () => {
  const v = flatten(tree(), { collapsed: allCollapsed(), tab: 'All', query: '' });
  assert.deepEqual(v.map((r) => r.id), ['root1', 'root2', 'lonely']);
  // root1 has children and is collapsed → glyph state
  assert.equal(v[0]!.hasChildren, true);
  assert.equal(v[0]!.collapsed, true);
  assert.equal(v[2]!.hasChildren, false); // lonely is a leaf
});

test('flatten: expanding a root reveals its (still-collapsed) children', () => {
  const collapsed = allCollapsed();
  collapsed.delete('root1');
  const v = flatten(tree(), { collapsed, tab: 'All', query: '' });
  assert.deepEqual(v.map((r) => r.id), ['root1', 'child-a', 'child-b', 'root2', 'lonely']);
  // child-a still collapsed → grand-x hidden
  assert.equal(v.find((r) => r.id === 'child-a')!.collapsed, true);
});

test('flatten: fully expanded shows the whole subtree', () => {
  const collapsed = new Set<string>(); // nothing collapsed
  const v = flatten(tree(), { collapsed, tab: 'All', query: '' });
  assert.deepEqual(v.map((r) => r.id), ['root1', 'child-a', 'grand-x', 'child-b', 'root2', 'child-c', 'lonely']);
});

// ── flatten: tab filtering + ancestor context ────────────────────────────────

test('flatten: Live tab dims dormant ancestors, keeps live matches', () => {
  const v = flatten(tree(), { collapsed: allCollapsed(), tab: 'Live', query: '' });
  assert.deepEqual(v.map((r) => r.id), ['root1', 'root2', 'lonely']);
  const byId = Object.fromEntries(v.map((r) => [r.id, r]));
  assert.equal(byId['root1']!.matched, true);  // active
  assert.equal(byId['lonely']!.matched, true); // idle
  assert.equal(byId['root2']!.matched, false); // dormant, shown only as ancestor of child-c
});

test('flatten: Dormant tab excludes live-only branches', () => {
  const v = flatten(tree(), { collapsed: new Set(), tab: 'Dormant', query: '' });
  const ids = v.map((r) => r.id);
  assert.ok(ids.includes('grand-x')); // done
  assert.ok(ids.includes('root2'));   // done
  assert.ok(!ids.includes('child-b')); // active → excluded
  assert.ok(!ids.includes('lonely'));  // idle → excluded
});

// ── flatten: query auto-expands ancestors of matches ─────────────────────────

test('flatten: query force-expands ancestors even when collapsed', () => {
  // Everything collapsed; query targets a deep leaf. Its ancestors must appear.
  const v = flatten(tree(), { collapsed: allCollapsed(), tab: 'All', query: 'grandx' });
  assert.deepEqual(v.map((r) => r.id), ['root1', 'child-a', 'grand-x']);
  const byId = Object.fromEntries(v.map((r) => [r.id, r]));
  assert.equal(byId['grand-x']!.matched, true);  // the actual match
  assert.equal(byId['child-a']!.matched, false); // ancestor for context
  assert.equal(byId['root1']!.matched, false);   // ancestor for context
});

test('flatten: query with no matches yields nothing', () => {
  const v = flatten(tree(), { collapsed: allCollapsed(), tab: 'All', query: 'zzzznope' });
  assert.deepEqual(v, []);
});

// ── flatten: residentsOnly fold-reveal ───────────────────────────────────────
//   resident-root → terminal-worker (child) → terminal-grand (grandchild)
//   resident-only must hide the terminals from the TOP LEVEL + flat search, yet
//   still reveal them once you expand the resident fold that owns them.

const RES_ROWS: DashboardRow[] = [
  lrow('res-root', 'resident-root', 'idle', 'resident'),
  lrow('term-a', 'worker-a', 'active', 'terminal'),
  lrow('term-g', 'worker-grand', 'active', 'terminal'),
  lrow('term-root', 'lone-worker', 'active', 'terminal'), // pure-terminal root
];
const RES_CHILDREN: Record<string, string[]> = { 'res-root': ['term-a'], 'term-a': ['term-g'] };
function resTree() {
  return buildTree(RES_ROWS, ['res-root', 'term-root'], (id) => RES_CHILDREN[id] ?? []);
}

test('flatten: residentsOnly hides terminal top-level rows (incl. terminal roots)', () => {
  // Everything collapsed → only the resident root shows; the lone terminal root
  // and the worker subtree are hidden at the top level.
  const v = flatten(resTree(), { collapsed: new Set(['res-root', 'term-a']), tab: 'All', query: '', residentsOnly: true });
  assert.deepEqual(v.map((r) => r.id), ['res-root']);
});

test('flatten: residentsOnly reveals terminal children once their fold is expanded', () => {
  // Expand the resident root → its terminal worker appears (still collapsed, so
  // its own terminal grandchild stays hidden).
  const v1 = flatten(resTree(), { collapsed: new Set(['term-a']), tab: 'All', query: '', residentsOnly: true });
  assert.deepEqual(v1.map((r) => r.id), ['res-root', 'term-a']);
  // Expand the worker too → the terminal grandchild is revealed.
  const v2 = flatten(resTree(), { collapsed: new Set(), tab: 'All', query: '', residentsOnly: true });
  assert.deepEqual(v2.map((r) => r.id), ['res-root', 'term-a', 'term-g']);
});

test('flatten: residentsOnly keeps terminals out of flat (relevance) search results', () => {
  // A query that matches the workers must not surface them in the flat search —
  // resident-only de-clutters search even though the fold would reveal them.
  const v = flatten(resTree(), { collapsed: new Set(), tab: 'All', query: 'worker', residentsOnly: true, sort: 'relevance' });
  assert.deepEqual(v.map((r) => r.id), []);
});

test('flatten: residentsOnly off shows every lifecycle at the top level', () => {
  // Roots are live-first: term-root (active) ranks ahead of res-root (idle).
  const v = flatten(resTree(), { collapsed: new Set(['res-root', 'term-a']), tab: 'All', query: '', residentsOnly: false });
  assert.deepEqual(v.map((r) => r.id), ['term-root', 'res-root']);
});

// ── attention sort (default tiered ordering) ────────────────────────────────
//   Each row carries cheap fields: viewed / streaming / status + a session mtime
//   (mtimeMs). Tiers: T0 viewed&streaming, T1 viewed, T2 streaming, T3 live,
//   T4 dormant; newest-message-first WITHIN each tier.

type AttnRow = DashboardRow & { mtimeMs?: number };
function arow(node_id: string, status: NodeStatus, opts: { viewed?: boolean; streaming?: boolean; mtimeMs?: number }): AttnRow {
  return { ...row(node_id, node_id, status), ...opts };
}

test('attentionTier: classifies each cheap-field combination', () => {
  assert.equal(attentionTier(arow('x', 'active', { viewed: true, streaming: true })), 0);
  assert.equal(attentionTier(arow('x', 'active', { viewed: true })), 1);
  assert.equal(attentionTier(arow('x', 'active', { streaming: true, viewed: false })), 2);
  assert.equal(attentionTier(arow('x', 'active', {})), 3);
  assert.equal(attentionTier(arow('x', 'idle', {})), 3);
  assert.equal(attentionTier(arow('x', 'done', {})), 4);
  assert.equal(attentionTier(arow('x', 'dead', {})), 4);
  assert.equal(attentionTier(arow('x', 'canceled', {})), 4);
});

test('attentionMtime: prefers mtimeMs, falls back to created', () => {
  assert.equal(attentionMtime(arow('x', 'active', { mtimeMs: 1234 })), 1234);
  // No mtimeMs → epoch-ms of the ISO `created` (fixture is 2026-01-01T00:00:00Z).
  assert.equal(attentionMtime(arow('x', 'active', {})), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('flatten: attention sort tiers rows (attached/streaming/live first)', () => {
  // One row per tier, deliberately shuffled in input order.
  const rows: AttnRow[] = [
    arow('dormant', 'done', { mtimeMs: 100 }),       // T4
    arow('live', 'active', { mtimeMs: 100 }),         // T3
    arow('streaming', 'active', { streaming: true, mtimeMs: 100 }), // T2
    arow('attached', 'idle', { viewed: true, mtimeMs: 100 }),       // T1
    arow('both', 'active', { viewed: true, streaming: true, mtimeMs: 100 }), // T0
  ];
  const t = buildTree(rows, [], () => []);
  const v = flatten(t, { collapsed: new Set(), tab: 'All', query: '', sort: 'attention' });
  assert.deepEqual(v.map((r) => r.id), ['both', 'attached', 'streaming', 'live', 'dormant']);
});

test('flatten: attention sort orders newest-message-first WITHIN a tier', () => {
  // All dormant (T4) → ordering is purely by mtime, newest first.
  const rows: AttnRow[] = [
    arow('old', 'done', { mtimeMs: 1000 }),
    arow('newest', 'done', { mtimeMs: 3000 }),
    arow('mid', 'done', { mtimeMs: 2000 }),
  ];
  const t = buildTree(rows, [], () => []);
  const v = flatten(t, { collapsed: new Set(), tab: 'All', query: '', sort: 'attention' });
  assert.deepEqual(v.map((r) => r.id), ['newest', 'mid', 'old']);
});
