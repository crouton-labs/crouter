import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DashboardRow } from '../../render.js';
import type { NodeStatus } from '../../types.js';
import { buildTree, flatten, fuzzyMatch, tabPredicate, TABS } from '../model.js';

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
