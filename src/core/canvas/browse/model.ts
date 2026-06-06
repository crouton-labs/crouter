// model.ts — pure, TTY-free logic for the canvas browser.
//
// Everything here is a pure function of its inputs (no db, no stdin, no ANSI) so
// it is exhaustively unit-testable. The app layer (app.ts) wires the canvas data
// access (dashboardRowsAll / listNodes / subscriptionsOf) into buildTree, then
// drives flatten() on each keystroke.

import type { DashboardRow } from '../render.js';
import type { NodeStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type Tab = 'All' | 'Live' | 'Dormant' | 'Flagged';

export const TABS: readonly Tab[] = ['All', 'Live', 'Dormant', 'Flagged'] as const;

// ---------------------------------------------------------------------------
// Sort modes
// ---------------------------------------------------------------------------

/** How the visible rows are ordered.
 *    tree      — spanning-tree order, ancestors shown for context (the default).
 *    relevance — FLAT list, best query match first (super-search).
 *    recency   — FLAT list, newest `created` first. */
export type SortMode = 'tree' | 'relevance' | 'recency';

export const SORTS: readonly SortMode[] = ['tree', 'relevance', 'recency'] as const;

/** Does a node belong to this tab's slice?
 *    All      — every node.
 *    Live     — active | idle.
 *    Dormant  — done | dead | canceled.
 *    Flagged  — has > 0 pending human asks. */
export function tabPredicate(tab: Tab, row: DashboardRow): boolean {
  switch (tab) {
    case 'All':     return true;
    case 'Live':    return row.status === 'active' || row.status === 'idle';
    case 'Dormant': return row.status === 'done' || row.status === 'dead' || row.status === 'canceled';
    case 'Flagged': return row.asks > 0;
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  row: DashboardRow;
  depth: number;
  parentId: string | null;
  childIds: string[];
}

export interface Tree {
  /** Ordered root ids (live-first, then stragglers). */
  roots: string[];
  nodes: Map<string, TreeNode>;
}

/** Sort rank for roots/stragglers — live first (active, then idle), dormant
 *  after. Mirrors render.ts / canvas-resume.ts statusRank. */
export function statusRank(status: NodeStatus): number {
  switch (status) {
    case 'active':   return 0;
    case 'idle':     return 1;
    case 'done':     return 2;
    case 'canceled': return 3;
    case 'dead':     return 4;
    default:         return 5;
  }
}

/**
 * Build a spanning tree of the whole canvas.
 *   - `rows`       — one DashboardRow per node (display text + status/asks).
 *   - `rootIds`    — node ids whose `parent === null` (raw, unsorted).
 *   - `childIdsOf` — a node's children = the nodes it subscribes to (its
 *                    reports), in edge order. (= subscriptionsOf(id) node ids.)
 *
 * Roots are sorted live-first. The graph is walked DFS-preorder; the FIRST
 * parent to reach a node owns it (cycle-/multi-parent-safe via `visited`). Any
 * node never reached from a root (orphaned by a missing subscription edge) is
 * appended as a depth-0 straggler so "All" is genuinely the whole canvas.
 */
export function buildTree(
  rows: DashboardRow[],
  rootIds: string[],
  childIdsOf: (id: string) => string[],
): Tree {
  const rowMap = new Map(rows.map((r) => [r.node_id, r] as const));
  const nodes = new Map<string, TreeNode>();
  const orderedRoots: string[] = [];
  const visited = new Set<string>();

  const rankOf = (id: string): number => {
    const r = rowMap.get(id);
    return r !== undefined ? statusRank(r.status) : 99;
  };

  const walk = (id: string, depth: number, parentId: string | null): void => {
    if (visited.has(id)) return; // cycle, or already claimed by an earlier parent
    const row = rowMap.get(id);
    if (row === undefined) return; // id in the graph but no row (missing meta)
    visited.add(id);
    const childIds = childIdsOf(id).filter((c) => rowMap.has(c) && !visited.has(c));
    nodes.set(id, { row, depth, parentId, childIds });
    for (const c of childIds) walk(c, depth + 1, id);
  };

  const sortedRoots = [...rootIds].filter((id) => rowMap.has(id)).sort((a, b) => rankOf(a) - rankOf(b));
  for (const r of sortedRoots) {
    if (visited.has(r)) continue;
    orderedRoots.push(r);
    walk(r, 0, null);
  }

  // Stragglers: any row never reached from a declared root. Attach live-first as
  // depth-0 pseudo-roots so the whole canvas stays reachable.
  const stragglers = rows
    .map((r) => r.node_id)
    .filter((id) => !visited.has(id))
    .sort((a, b) => rankOf(a) - rankOf(b));
  for (const s of stragglers) {
    if (visited.has(s)) continue;
    orderedRoots.push(s);
    walk(s, 0, null);
  }

  return { roots: orderedRoots, nodes };
}

// ---------------------------------------------------------------------------
// Fuzzy match
// ---------------------------------------------------------------------------

/** Case-insensitive subsequence match: every char of `query` appears in `text`
 *  in order (gaps allowed). Empty query matches everything. Substrings are a
 *  subsequence, so this subsumes substring matching too. */
export function fuzzyMatch(query: string, text: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Indices in `text` consumed by a greedy left-to-right subsequence match of
 *  `query` — the same walk as `fuzzyMatch`, but returning WHICH chars matched so
 *  the renderer can highlight them. Empty set when `query` is empty OR does not
 *  fully match (no partial highlights). */
export function matchIndices(query: string, text: string): Set<number> {
  const out = new Set<number>();
  if (query === '') return out;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { out.add(ti); qi++; }
  }
  if (qi < q.length) out.clear(); // no full match → no highlight
  return out;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Does this row match the live query? Super-search spans name (which already
 *  folds in the pi-generated description), kind, short-id, AND the spawn prompt
 *  (`row.goal`). Empty query matches everything. */
export function queryMatch(query: string, row: DashboardRow): boolean {
  if (query === '') return true;
  return (
    fuzzyMatch(query, row.name) ||
    fuzzyMatch(query, row.kind) ||
    fuzzyMatch(query, shortId(row.node_id)) ||
    (row.goal !== undefined && fuzzyMatch(query, row.goal))
  );
}

// ---------------------------------------------------------------------------
// Relevance scoring (super-search)
// ---------------------------------------------------------------------------

/** Score how well `query` matches one field, 0 (no match) → 1 (exact). Tiers:
 *  exact > prefix > word-boundary substring > interior substring > subsequence.
 *  An interior match decays slightly the later it starts so leading matches win. */
export function fieldScore(query: string, text: string): number {
  if (query === '' || text === '') return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return t.length === q.length ? 1 : 0.85;          // exact | prefix
  if (idx > 0) {
    const prev = t[idx - 1] ?? '';
    const boundary = /[\s_\-/.:]/.test(prev) ? 0.1 : 0;            // word-boundary bonus
    return 0.55 + boundary - Math.min(0.2, idx / 400);             // interior, decays late
  }
  return fuzzyMatch(q, t) ? 0.2 : 0;                                // scattered subsequence
}

/** Per-field weights — name (handle + description) dominates, the spawn prompt
 *  is the long-tail super-search field. */
const FIELD_WEIGHTS = { name: 4, kind: 2, id: 1, goal: 1.5 } as const;

/** Weighted relevance of a row to the query across all searched fields. 0 means
 *  no field matched (excluded from relevance results, same as `queryMatch`). */
export function scoreRow(query: string, row: DashboardRow): number {
  if (query === '') return 0;
  return (
    FIELD_WEIGHTS.name * fieldScore(query, row.name) +
    FIELD_WEIGHTS.kind * fieldScore(query, row.kind) +
    FIELD_WEIGHTS.id * fieldScore(query, shortId(row.node_id)) +
    FIELD_WEIGHTS.goal * (row.goal !== undefined ? fieldScore(query, row.goal) : 0)
  );
}

// ---------------------------------------------------------------------------
// Flatten — the ordered list of visible rows
// ---------------------------------------------------------------------------

export interface VisibleRow {
  id: string;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  matched: boolean;
}

export interface FlattenOpts {
  collapsed: Set<string>;
  tab: Tab;
  query: string;
  /** cwd-scope filter: only rows pinned to this dir are directly-matched. null /
   *  undefined = All dirs (no cwd filter). Like the tab predicate, it gates the
   *  matched set — ancestors from other dirs still render dimmed for tree context. */
  cwdScope?: string | null;
  /** Ordering. `tree` keeps the spanning tree + ancestor context; `relevance` /
   *  `recency` produce a FLAT ranked list of directly-matched rows. */
  sort?: SortMode;
}

/** Is this row inside the active cwd scope? No scope (null/undefined) = All dirs. */
export function cwdMatch(scope: string | null | undefined, row: DashboardRow): boolean {
  return scope === null || scope === undefined || row.cwd === scope;
}

/**
 * Flatten the tree to the ordered list of currently-visible rows.
 *
 * Inclusion: a node is shown when it directly matches (tab predicate AND query)
 * — flagged `matched:true` — OR it is an ANCESTOR of a directly-matched node
 * (shown for tree context, `matched:false`, dimmed by the renderer).
 *
 * Collapse: children are emitted only under an EXPANDED node. A node is expanded
 * when it is not in `collapsed` — except under a non-empty query, where every
 * ancestor-of-a-match is force-expanded regardless of `collapsed` so matches are
 * always reachable.
 */
export function flatten(tree: Tree, opts: FlattenOpts): VisibleRow[] {
  const { collapsed, tab, query, cwdScope, sort = 'tree' } = opts;

  // 1. Directly-matched nodes: tab predicate AND cwd scope AND query.
  const matched = new Set<string>();
  for (const [id, node] of tree.nodes) {
    if (tabPredicate(tab, node.row) && cwdMatch(cwdScope, node.row) && queryMatch(query, node.row)) {
      matched.add(id);
    }
  }

  // FLAT ranked modes (relevance / recency): no tree, no ancestors — just the
  // directly-matched rows in ranked order. Relevance falls back to recency when
  // the query is empty (every score would be 0).
  if (sort !== 'tree') {
    const ids = [...matched];
    const createdOf = (id: string): string => tree.nodes.get(id)?.row.created ?? '';
    const byRecency = (a: string, b: string): number => createdOf(b).localeCompare(createdOf(a));
    if (sort === 'recency' || query === '') {
      ids.sort(byRecency);
    } else {
      const score = new Map<string, number>();
      for (const id of ids) score.set(id, scoreRow(query, tree.nodes.get(id)!.row));
      ids.sort((a, b) => (score.get(b)! - score.get(a)!) || byRecency(a, b));
    }
    return ids.map((id) => ({ id, depth: 0, hasChildren: false, collapsed: false, matched: true }));
  }

  // 2. Ancestors of matches (for tree context + force-expand under query).
  const ancestors = new Set<string>();
  for (const id of matched) {
    let p = tree.nodes.get(id)?.parentId ?? null;
    while (p !== null && !ancestors.has(p)) {
      ancestors.add(p);
      p = tree.nodes.get(p)?.parentId ?? null;
    }
  }

  const included = (id: string): boolean => matched.has(id) || ancestors.has(id);
  const isExpanded = (id: string): boolean => {
    if (query !== '' && ancestors.has(id)) return true; // force-expand to reveal matches
    return !collapsed.has(id);
  };

  // 3. Walk the tree in order, emitting included nodes and descending only into
  //    expanded ones.
  const out: VisibleRow[] = [];
  const walk = (id: string): void => {
    const node = tree.nodes.get(id);
    if (node === undefined) return;
    if (included(id)) {
      const hasChildren = node.childIds.length > 0;
      out.push({
        id,
        depth: node.depth,
        hasChildren,
        collapsed: hasChildren && !isExpanded(id),
        matched: matched.has(id),
      });
    }
    if (isExpanded(id)) {
      for (const c of node.childIds) walk(c);
    }
  };
  for (const r of tree.roots) walk(r);
  return out;
}
