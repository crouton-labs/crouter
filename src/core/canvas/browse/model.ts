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

// ---------------------------------------------------------------------------
// Preview match snippet
// ---------------------------------------------------------------------------

/** One word-wrapped preview line: its text + the column indices WITHIN that text
 *  to highlight (the query match). */
export interface SnippetLine {
  text: string;
  hi: Set<number>;
}

/** Chars of leading context kept before the match start when windowing. */
const SNIPPET_LEAD = 12;

/** Highlight indices for the preview: the literal case-insensitive SUBSTRING span
 *  when present (so "where does this text appear?" is answered exactly), else the
 *  scattered subsequence indices, else empty (empty query). This is a different,
 *  stricter model than the subsequence super-search on purpose — a contiguous span
 *  is what reads as a highlight. */
export function highlightIndices(query: string, text: string): Set<number> {
  if (query === '') return new Set();
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const sub = lower.indexOf(q);
  if (sub >= 0) {
    const out = new Set<number>();
    for (let i = sub; i < sub + q.length; i++) out.add(i);
    return out;
  }
  return matchIndices(query, text);
}

/** Greedy word-wrap of single-spaced `s` (caller normalizes whitespace) to `width`
 *  cols × `maxLines` lines, returning each line's text AND its start offset in `s`.
 *  Only the single space at each wrap break is dropped, so a highlight index maps
 *  to a line column as `idx - line.start` with no drift across the wrap. */
function wrapTracked(s: string, width: number, maxLines: number): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  if (width <= 0 || maxLines <= 0) return out;
  const n = s.length;
  let i = 0;
  while (i < n && out.length < maxLines) {
    const lineStart = i;
    let lineEnd = i; // exclusive end of committed words
    let j = i;
    while (j < n) {
      let ws = j;
      while (ws < n && s[ws] === ' ') ws++;
      let we = ws;
      while (we < n && s[we] !== ' ') we++;
      if (ws === we) break; // only trailing spaces remain
      if (we - lineStart <= width || lineEnd === lineStart) {
        lineEnd = we; // include this word (always take ≥1; a huge word is clipped below)
        j = we;
      } else break;
    }
    let text = s.slice(lineStart, lineEnd);
    if (text.length > width) text = text.slice(0, width);
    out.push({ text, start: lineStart });
    i = lineEnd;
    if (i < n && s[i] === ' ') i++; // drop the single break space
  }
  return out;
}

/**
 * Build the preview snippet for `text` under the live `query`: up to `maxLines`
 * word-wrapped lines (each ≤ `width` cols), WINDOWED so the best match is visible
 * (long conversations: the match can be thousands of chars in), with the matched
 * columns flagged for highlight. Empty query (or empty text) → a plain wrap from
 * the start with no highlight. The snippet string itself is what carries the
 * highlight indices, so they never drift across the windowing.
 */
export function previewSnippet(query: string, text: string, width: number, maxLines: number): SnippetLine[] {
  const norm = text.replace(/\s+/g, ' ').trim();
  if (norm === '' || width <= 0 || maxLines <= 0) return [];

  // 1. Locate the match in the normalized text + choose a window start that keeps
  //    a little leading context, snapped to a word boundary.
  let matchStart = -1;
  if (query !== '') {
    const sub = norm.toLowerCase().indexOf(query.toLowerCase());
    if (sub >= 0) matchStart = sub;
    else { const ix = matchIndices(query, norm); if (ix.size > 0) matchStart = Math.min(...ix); }
  }
  let windowStart = 0;
  if (matchStart > SNIPPET_LEAD) {
    let s = matchStart - SNIPPET_LEAD;
    while (s < matchStart && norm[s] !== ' ') s++; // forward to the next word boundary
    windowStart = s < matchStart ? s + 1 : matchStart;
  }
  const snippet = (windowStart > 0 ? '… ' : '') + norm.slice(windowStart);

  // 2. Recompute highlight indices on the FINAL snippet string (no drift), then
  //    word-wrap with offset tracking and split the highlight into per-line cols.
  const hi = highlightIndices(query, snippet);
  return wrapTracked(snippet, width, maxLines).map(({ text: lt, start }) => {
    const lhi = new Set<number>();
    for (const idx of hi) if (idx >= start && idx < start + lt.length) lhi.add(idx - start);
    return { text: lt, hi: lhi };
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The searchable conversation text for a row: EVERY user prompt across the pi
 *  session (`prompts`) when present, else the spawn prompt (`goal`) for a
 *  never-revived node that has no session yet. Searched by super-search and
 *  windowed in the preview, so search matches a prompt from ANYWHERE in the
 *  conversation, not just the first one. */
export function promptText(row: DashboardRow): string {
  return row.prompts ?? row.goal ?? '';
}

/** Does this row match the live query? Super-search spans name (which already
 *  folds in the pi-generated description), kind, short-id, AND every user prompt
 *  in the conversation (`promptText`). Empty query matches everything. */
export function queryMatch(query: string, row: DashboardRow): boolean {
  if (query === '') return true;
  const prompt = promptText(row);
  return (
    fuzzyMatch(query, row.name) ||
    fuzzyMatch(query, row.kind) ||
    fuzzyMatch(query, shortId(row.node_id)) ||
    (prompt !== '' && fuzzyMatch(query, prompt))
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

/** Per-field weights — name (handle + description) dominates, the conversation
 *  prompts are the long-tail super-search field. */
const FIELD_WEIGHTS = { name: 4, kind: 2, id: 1, prompt: 1.5 } as const;

/** Weighted relevance of a row to the query across all searched fields. 0 means
 *  no field matched (excluded from relevance results, same as `queryMatch`). */
export function scoreRow(query: string, row: DashboardRow): number {
  if (query === '') return 0;
  const prompt = promptText(row);
  return (
    FIELD_WEIGHTS.name * fieldScore(query, row.name) +
    FIELD_WEIGHTS.kind * fieldScore(query, row.kind) +
    FIELD_WEIGHTS.id * fieldScore(query, shortId(row.node_id)) +
    FIELD_WEIGHTS.prompt * (prompt !== '' ? fieldScore(query, prompt) : 0)
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
  /** Lifecycle filter: when true, `terminal` (one-shot worker) nodes are kept out
   *  of the TOP-LEVEL rows and the flat search results — but, in tree mode, still
   *  appear when you manually expand their parent fold (drilling into a resident).
   *  The resume picker defaults this ON. Undefined/false = every lifecycle. */
  residentsOnly?: boolean;
  /** Ordering. `tree` keeps the spanning tree + ancestor context; `relevance` /
   *  `recency` produce a FLAT ranked list of directly-matched rows. */
  sort?: SortMode;
}

/** Is this row inside the active cwd scope? No scope (null/undefined) = All dirs. */
export function cwdMatch(scope: string | null | undefined, row: DashboardRow): boolean {
  return scope === null || scope === undefined || row.cwd === scope;
}

/** Is this row inside the active lifecycle filter? `residentsOnly` hides `terminal`
 *  nodes; off (false/undefined) = every lifecycle. A row with an unknown lifecycle
 *  (older snapshot field absent) is treated as resident so it is never hidden. */
export function lifecycleMatch(residentsOnly: boolean | undefined, row: DashboardRow): boolean {
  return residentsOnly !== true || row.lifecycle !== 'terminal';
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
  const { collapsed, tab, query, cwdScope, residentsOnly, sort = 'tree' } = opts;

  // 1. Directly-matched nodes: tab predicate AND cwd scope AND lifecycle AND query.
  //    `matched` honors the residents-only filter (drives top-level rows, ancestor
  //    context, force-expand, and the flat search results below). `matchedAll` is
  //    the same set WITHOUT the lifecycle gate — it's how a terminal node becomes
  //    visible once you expand the resident parent that owns it (the fold-reveal
  //    below), so residents-only de-clutters the top level + search yet still lets
  //    you drill into a fold and see everything under it.
  const matched = new Set<string>();
  const matchedAll = new Set<string>();
  for (const [id, node] of tree.nodes) {
    if (tabPredicate(tab, node.row) && cwdMatch(cwdScope, node.row) && queryMatch(query, node.row)) {
      matchedAll.add(id);
      if (lifecycleMatch(residentsOnly, node.row)) matched.add(id);
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

  // 3. Walk the tree in order, emitting shown nodes and descending only into
  //    expanded ones. A node is shown when it is `included` (matched or ancestor),
  //    OR — under residents-only — when its already-shown parent is expanded and the
  //    node matches everything but the lifecycle gate (`matchedAll`). That is the
  //    fold-reveal: a terminal worker hidden from the top level reappears the moment
  //    you open the resident fold that owns it. `parentShown` threads that down.
  const out: VisibleRow[] = [];
  const walk = (id: string, parentShown: boolean): void => {
    const node = tree.nodes.get(id);
    if (node === undefined) return;
    const show =
      included(id) || (residentsOnly === true && parentShown && matchedAll.has(id));
    if (show) {
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
      for (const c of node.childIds) walk(c, show);
    }
  };
  for (const r of tree.roots) walk(r, false);
  return out;
}
