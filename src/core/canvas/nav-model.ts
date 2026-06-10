// nav-model.ts — the pure model/render layer of the canvas graph-nav chrome.
//
// Extracted from src/pi-extensions/canvas-nav.ts so a SINGLE source feeds both
// the legacy pi extension (canvas-nav) and the headless `crtr attach` viewer.
// Everything here is pi-API-free: it reads the canvas (sqlite + meta.json + node
// telemetry) and produces ANSI-styled strings + a flattened graph model. The
// extension-host wiring (widgets, key taps, the ask-poll timer, run/focus
// shelling) stays in canvas-nav.ts and drives these functions.
//
// Mutable interaction state that the legacy extension held at module scope —
// the per-node ask counts and the manual fold overrides — is threaded through
// parameters here (see `asks` and `FoldState`) so this layer owns no singletons
// and each consumer keeps its own state.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, subscribersOf, subscriptionsOf, jobDir, listFocuses } from './index.js';
import type { NodeMeta, SubscriptionRef } from './index.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** pi's InteractiveMode.MAX_WIDGET_LINES — the hard cap on lines in a string
 *  array widget; anything beyond it pi truncates with its own "... (widget
 *  truncated)". Our GRAPH viewport stays at/under this and scrolls internally. */
export const PI_MAX_WIDGET_LINES = 10;
export const VIEWPORT_FALLBACK_ROWS = 30;

// ---------------------------------------------------------------------------
// ANSI styling. pi renders embedded escapes in widget lines and measures width
// ANSI-aware, so raw escapes are safe and need no pi-tui dependency. The cursor
// (selected row) uses a theme-agnostic ATTRIBUTE (reverse), so it reads under
// NO_COLOR; the attached-row tint is a background COLOUR, while the dot glyph
// (●/○/✓/✗) carries the running signal independently, even where colour is
// stripped.
// ---------------------------------------------------------------------------

export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const REVERSE = `${ESC}7m`;
/** Dark-green background bar marking an ATTACHED node (a human is currently
 *  watching it) — distinct from the cursor's reverse-video bar; chosen so
 *  default-fg text stays readable. */
export const BG_ATTACHED = `${ESC}48;5;22m`;
export const GREEN = `${ESC}32m`;
export const RED = `${ESC}31m`;
export const YELLOW = `${ESC}33m`;
export const CYAN = `${ESC}36m`;
export const GRAY = `${ESC}90m`;

/** Status glyph colored by state: active green, idle dim, done cyan, dead red. */
export function coloredGlyph(node: NodeMeta | null): string {
  if (node === null) return '?';
  switch (node.status) {
    case 'active': return `${GREEN}●${RESET}`;
    case 'idle':   return `${GRAY}○${RESET}`;
    case 'done':   return `${CYAN}✓${RESET}`;
    case 'dead':   return `${RED}✗${RESET}`;
    case 'canceled': return `${YELLOW}⊘${RESET}`;
    default:       return '?';
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Truncate to `max` VISIBLE columns: escape sequences are copied through
 *  verbatim (so a cut never lands mid-escape) and the result always ends in
 *  RESET, so a clipped style can't bleed into the editor below. */
export function truncate(s: string, max = fillWidth()): string {
  if (visibleWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length && w < max - 1) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i];
    w++;
    i++;
  }
  return `${out}…${RESET}`;
}

/** Visible columns available to ONE widget line — the cap for every line we
 *  emit, and the width a full-width reverse-video SELF bar fills to.
 *
 *  pi does NOT clip widget lines; it WRAPS them. Each string line is wrapped in
 *  a `Text(paddingX = 1)` inside a full-terminal-width container, so the usable
 *  content width is `columns - 2` (a 1-col margin on each side). A line wider
 *  than that wraps, and the overflow spills onto a second row as a stray
 *  reverse-video block (the bug this guards against). Clamp to `columns - 2`. */
export function fillWidth(): number {
  return Math.max(20, Math.min((process.stdout.columns ?? 80) - 2, 180));
}

/** Wrap `content` in a full-width background bar opened by `open` (REVERSE for
 *  the cursor, BG_ATTACHED for a human-watched node). `open` is re-asserted after every
 *  embedded RESET so a coloured cell (the status dot) can't punch a hole in the
 *  bar; the visible width is padded out to `width`; the line closes with a real
 *  RESET so the style never bleeds into the editor below. */
export function fillBar(content: string, width: number, open: string): string {
  const clipped = truncate(content, width);
  const reasserted = clipped.replace(/\x1b\[0m/g, `${RESET}${open}`);
  const pad = Math.max(0, width - visibleWidth(clipped));
  return `${open}${reasserted}${' '.repeat(pad)}${RESET}`;
}

// ---------------------------------------------------------------------------
// Per-frame read cache
//
// One render fans the SAME handful of nodes out 5-10× each: computeSubtreeActivity
// walks the whole tree (getNode + subscriptions per node), buildGraphModel walks it
// again (climbRoot, sortedChildIds), then every visible row re-reads getNode +
// telemetry + subscriptions for its badges. getNode alone is an fs.readFileSync of
// meta.json plus a sqlite row read, and readTelemetry another readFileSync — so on a
// modest graph a single 'j' keystroke fanned out to DOZENS of redundant disk reads.
// That redundancy is the GRAPH view's open/scroll lag.
//
// Each render is a synchronous snapshot, so we memoize the read primitives for the
// duration of one frame and clear at the top of render(): the next keystroke (or the
// ask-poll / inbox render) re-reads fresh, so a killed node, a new spawn, or a status
// flip all surface on the very next frame. Nothing here writes, so a stale entry can
// at worst be one frame old — and render() always reruns immediately after any action.
// ---------------------------------------------------------------------------

const frameNodes = new Map<string, NodeMeta | null>();
const frameTelem = new Map<string, Telemetry>();
const frameSubs = new Map<string, SubscriptionRef[]>();
const frameMgrs = new Map<string, SubscriptionRef[]>();

export function beginFrame(): void {
  frameNodes.clear();
  frameTelem.clear();
  frameSubs.clear();
  frameMgrs.clear();
}

/** getNode memoized for the current frame (meta.json read + sqlite row). */
export function cNode(id: string): NodeMeta | null {
  if (frameNodes.has(id)) return frameNodes.get(id) ?? null;
  const v = getNode(id);
  frameNodes.set(id, v);
  return v;
}

/** subscriptionsOf (a node's reports) memoized for the current frame. */
export function cSubscriptions(id: string): SubscriptionRef[] {
  const hit = frameSubs.get(id);
  if (hit !== undefined) return hit;
  let v: SubscriptionRef[];
  try { v = subscriptionsOf(id); } catch { v = []; }
  frameSubs.set(id, v);
  return v;
}

/** subscribersOf (a node's managers) memoized for the current frame. */
export function cSubscribers(id: string): SubscriptionRef[] {
  const hit = frameMgrs.get(id);
  if (hit !== undefined) return hit;
  let v: SubscriptionRef[];
  try { v = subscribersOf(id); } catch { v = []; }
  frameMgrs.set(id, v);
  return v;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface Telemetry {
  /** Live context-window size (pi's getContextUsage) — the figure pi's own footer
   *  shows. This is the node's window fill, NOT a per-turn delta. */
  context_tokens?: number;
  /** One-line "what is it doing" cue (`tool: detail`), written on every tool start. */
  last_activity?: string;
}

export function readTelemetry(nodeId: string): Telemetry {
  const hit = frameTelem.get(nodeId);
  if (hit !== undefined) return hit;
  let v: Telemetry;
  try {
    const p = join(jobDir(nodeId), 'telemetry.json');
    v = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Telemetry) : {};
  } catch {
    v = {};
  }
  frameTelem.set(nodeId, v);
  return v;
}

export function fmtTokens(n: number): string {
  return n < 1_000 ? `${n}` : `${Math.round(n / 1_000)}k`;
}

/** The context-window cell — live window fill rounded to the nearest 1k (the same
 *  figure pi's footer shows), NOT a per-turn token delta. */
export function tokensCell(id: string): string {
  return fmtTokens(readTelemetry(id).context_tokens ?? 0);
}

/** Dimmed live "what is it doing" cue for an ACTIVE node — the last tool it ran.
 *  Empty for non-active rows (stale once a node parks) and when none is recorded. */
export function activityCell(id: string, node: NodeMeta | null): string {
  if (node?.status !== 'active') return '';
  const a = (readTelemetry(id).last_activity ?? '').trim();
  return a === '' ? '' : ` ${DIM}· ${a}${RESET}`;
}

/** Revive-count badge (meta.cycles). Hidden on the first cycle (0) to cut noise. */
export function cycleBadge(node: NodeMeta | null): string {
  const c = node?.cycles ?? 0;
  return c > 0 ? ` ${DIM}⟳${c}${RESET}` : '';
}

/** Short on-screen label: the explicit handle when set, else the pi-generated
 *  description, else the bare name. fullName joins BOTH (`handle description`);
 *  the nav chrome shows just the first so rows stay compact. */
export function navLabel(node: NodeMeta | null, id: string): string {
  if (node === null) return shortId(id);
  const handle = node.name && node.name !== node.kind ? node.name : '';
  if (handle !== '') return handle;
  const desc = (node.description ?? '').trim();
  return desc !== '' ? desc : node.name;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Attachment — is a human currently WATCHING a node? A separate axis from
// running (status 'active' = the engine is live on its host, which may be an
// unwatched backstage pane or a paneless broker). Two hosts, two signals:
//   tmux   — a `focuses` row points at the node (one cheap sqlite read per
//            render pass; pane-existence alone is NOT the signal).
//   broker — the broker persists its helloed-viewer count to job/attach.json
//            on every viewer change (src/core/runtime/broker.ts). Trusted only
//            while the node is 'active': a broker crash can leave a stale file.
// ---------------------------------------------------------------------------

/** Node ids currently shown in a tmux focus viewport. Built once per render. */
export function focusedNodeIds(): Set<string> {
  try {
    return new Set(listFocuses().map((f) => f.node_id));
  } catch {
    return new Set();
  }
}

/** True when a human is watching `id` right now (tmux focus or broker viewer). */
export function isAttached(id: string, node: NodeMeta | null, focused: ReadonlySet<string>): boolean {
  if (focused.has(id)) return true;
  if (node?.status !== 'active') return false; // stale attach.json from a crash
  try {
    const p = join(jobDir(id), 'attach.json');
    if (!existsSync(p)) return false;
    const rec = JSON.parse(readFileSync(p, 'utf8')) as { viewers?: number };
    return typeof rec.viewers === 'number' && rec.viewers > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-node ask counts — ONE shell-out per poll. `crtr canvas attention map`
// buckets a whole sub-DAG's pending asks by node in a single process, so the
// timer stays cheap (< 2 s) regardless of how many nodes are visible. --json
// gives a parseable {counts} blob (the default render is XML chrome).
// ---------------------------------------------------------------------------

export function fetchAsksMap(rootId: string): Record<string, number> {
  try {
    const raw = execFileSync('crtr', ['canvas', 'attention', 'map', '--view', rootId, '--json'], {
      timeout: 2_500,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw.trim()) as { counts?: Record<string, number> };
    return parsed.counts ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Graph queries (dependency-free, straight off the canvas db)
// ---------------------------------------------------------------------------

/** First manager (by created) — the UP step for the ancestry spine. */
export function managerOf(id: string): string | undefined {
  return cSubscribers(id)[0]?.node_id;
}

/** A kind:'human' node is a control-plane ASK (a humanloop deck on the human's
 *  screen), NOT a pi conversation — it has no session, so focusing/reviving it
 *  boots a confused blank "you have been revived" pi. Its pending-ask signal
 *  already rides the ⚑ badge on the ASKING node (attention.ts attributes asks by
 *  source.nodeId, never to the human node), so the row carries no signal of its
 *  own. Drop it from every navigable list (the tree, BASE reports, child counts,
 *  subtree expansion) so it can never be selected. */
export function isHumanAsk(id: string): boolean {
  return cNode(id)?.kind === 'human';
}

/** A node's direct children that are navigable conversations — human-ask nodes
 *  dropped. The one place the nav chrome enumerates children. */
export function convoChildIds(id: string): string[] {
  return cSubscriptions(id).map((s) => s.node_id).filter((cid) => !isHumanAsk(cid));
}

/** Live reports (active|idle) of a node — the DOWN set in BASE. */
export function liveReports(id: string): string[] {
  return convoChildIds(id).filter((cid) => {
    const st = cNode(cid)?.status;
    return st === 'active' || st === 'idle';
  });
}

/** Direct navigable children — used for the ⤳ badge and fold counts (human-ask
 *  nodes excluded, so the count matches what the tree actually shows). */
export function childCount(id: string): number {
  return convoChildIds(id).length;
}

/** Climb first-manager edges from `self` to the ancestry root (cycle-guarded). */
export function climbRoot(self: string): string {
  let cur = self;
  const seen = new Set<string>([cur]);
  for (;;) {
    const mgr = managerOf(cur);
    if (mgr === undefined || seen.has(mgr)) break;
    seen.add(mgr);
    cur = mgr;
  }
  return cur;
}

/** Space-joined ids of a node's subtree (cursor-relative {subtree} var). */
export function subtreeIds(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([root]);
  const q = convoChildIds(root);
  while (q.length > 0) {
    const id = q.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const cid of convoChildIds(id)) if (!seen.has(cid)) q.push(cid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared cell builders
// ---------------------------------------------------------------------------

/** ⤳M direct-children badge — only on orchestrator rows. */
export function childBadge(node: NodeMeta | null): string {
  if (node === null || node.mode !== 'orchestrator') return '';
  const m = childCount(node.node_id);
  return m > 0 ? ` ${DIM}⤳${m}${RESET}` : '';
}

/** ⚑K pending-asks badge for a node, read from the supplied per-node ask map. */
export function askBadge(id: string, asks: Record<string, number>): string {
  const k = asks[id] ?? 0;
  return k > 0 ? ` ${YELLOW}⚑${k}${RESET}` : '';
}

/** "Live work below" badge — green ⇣N when this node is NOT itself active but has
 *  N active descendants. The one signal that an idle/parked node isn't dead: real
 *  work is still running beneath it. Count comes from the single subtree-activity
 *  pass (no per-row walk). Suppressed on active rows (their own ● already says so). */
export function liveBelowBadge(node: NodeMeta | null, activeBelow: ReadonlyMap<string, number>): string {
  if (node === null || node.status === 'active') return '';
  const n = activeBelow.get(node.node_id) ?? 0;
  return n > 0 ? ` ${GREEN}⇣${n}${RESET}` : '';
}

/** Sort rank for sibling ordering — live nodes (active, then idle) ahead of
 *  terminal ones, so sessions still running surface at the TOP of each child
 *  group instead of being buried under finished/failed ones. */
export function statusRank(id: string): number {
  switch (cNode(id)?.status) {
    case 'active':   return 0;
    case 'idle':     return 1;
    case 'done':     return 2;
    case 'canceled': return 3;
    case 'dead':     return 4;
    default:         return 5;
  }
}

/** Direct children, live-first — the sibling order used both when flattening
 *  the tree and when stepping into a subtree (`l`). Array.sort is stable, so
 *  equal-status siblings keep their creation order. */
export function sortedChildIds(id: string): string[] {
  return convoChildIds(id).sort((a, b) => statusRank(a) - statusRank(b));
}

// ---------------------------------------------------------------------------
// GRAPH model — flatten the local graph fold-aware. Rebuilt every render (cheap
// sqlite reads) so a finished child / new spawn shows live; the manual fold
// overrides and the cursor id are the only persisted state.
// ---------------------------------------------------------------------------

export interface FlatRow {
  id: string;
  hasKids: boolean;
  isSelf: boolean;
  branch: string;     // tree connector prefix drawn before the caret/dot
  cycle: boolean;     // a re-encountered id (back-ref), not recursed into
  collapsed: boolean; // currently folded (default policy or manual override)
}

/** Manual fold OVERRIDES, keyed by id. `userCollapsed` forces a fold, `userExpanded`
 *  forces an unfold; both override the default activity-driven policy. Held by the
 *  consumer (the extension / viewer) and threaded into buildGraphModel so this layer
 *  carries no mutable singletons. */
export interface FoldState {
  userExpanded: ReadonlySet<string>;
  userCollapsed: ReadonlySet<string>;
}

/** One bottom-up O(N) pass over the local graph, computing TWO things at once so
 *  the render path never walks twice:
 *   - `expand`: which nodes auto-UNFOLD — a node expands when a child subtree holds
 *     a running ('active') agent or self, so the path to any live agent (and to
 *     you) is revealed while quiescent branches stay folded.
 *   - `activeBelow`: per node, the count of ACTIVE descendants (excluding itself) —
 *     drives the ⇣N "live work below" badge on idle/parked nodes.
 *  Cycle-guarded (the graph is declared acyclic; a re-seen id contributes only
 *  its own status, never its subtree again, so counts can't double or loop). */
export interface SubtreeActivity {
  expand: Set<string>;
  activeBelow: Map<string, number>;
}
export function computeSubtreeActivity(root: string, self: string): SubtreeActivity {
  const expand = new Set<string>();
  const activeBelow = new Map<string, number>();
  const seen = new Set<string>();
  // Returns the count of active nodes in subtree(id) INCLUDING id, and whether
  // that subtree is worth revealing (holds an active node or self).
  const visit = (id: string): { active: number; reveal: boolean } => {
    const selfActive = cNode(id)?.status === 'active';
    if (seen.has(id)) return { active: selfActive ? 1 : 0, reveal: selfActive || id === self };
    seen.add(id);
    let below = 0;
    let childReveal = false;
    for (const c of convoChildIds(id)) {
      const r = visit(c);
      below += r.active;
      if (r.reveal) childReveal = true;
    }
    activeBelow.set(id, below);
    if (childReveal) expand.add(id); // a descendant is worth revealing → unfold id
    return { active: below + (selfActive ? 1 : 0), reveal: childReveal || selfActive || id === self };
  };
  visit(root);
  return { expand, activeBelow };
}

/** Fold policy alone — thin wrapper over computeSubtreeActivity for the keypress
 *  path (buildGraphModel without a precomputed set). The render path computes the
 *  activity once and threads `expand` in, so it never recomputes here. */
export function computeDefaultExpanded(root: string, self: string): Set<string> {
  return computeSubtreeActivity(root, self).expand;
}

export function buildGraphModel(self: string, folds: FoldState, expand?: ReadonlySet<string>): FlatRow[] {
  const rootId = climbRoot(self);
  const defaultExpanded = expand ?? computeDefaultExpanded(rootId, self);
  // userExpanded / userCollapsed override the auto policy; absent → policy decides.
  const isFolded = (id: string): boolean =>
    folds.userExpanded.has(id) ? false : folds.userCollapsed.has(id) ? true : !defaultExpanded.has(id);
  const rows: FlatRow[] = [];
  const visited = new Set<string>();

  const walk = (id: string, prefix: string, isRoot: boolean, isLast: boolean): void => {
    if (visited.has(id)) {
      const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
      rows.push({ id, hasKids: false, isSelf: id === self, branch: prefix + connector, cycle: true, collapsed: false });
      return;
    }
    visited.add(id);
    const kids = sortedChildIds(id);
    const folded = isFolded(id);
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    rows.push({ id, hasKids: kids.length > 0, isSelf: id === self, branch: prefix + connector, cycle: false, collapsed: folded });
    if (folded) return; // folded — don't descend
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    for (let i = 0; i < kids.length; i++) walk(kids[i]!, childPrefix, false, i === kids.length - 1);
  };

  walk(rootId, '', true, true);
  return rows;
}

/** Render one GRAPH row. CURSOR (selected) → reverse-video bar; an ATTACHED
 *  (human-watched) node → a coloured background bar; SELF → bold name. The
 *  cursor outranks the attached tint when both land on the same row. Running
 *  is signaled by the dot glyph alone (● green = active engine). */
export function renderGraphRow(
  r: FlatRow,
  isCursor: boolean,
  focused: ReadonlySet<string>,
  activeBelow: ReadonlyMap<string, number>,
  asks: Record<string, number>,
): string {
  const wrap = (line: string, attached: boolean): string =>
    isCursor ? fillBar(line, fillWidth(), REVERSE)
    : attached ? fillBar(line, fillWidth(), BG_ATTACHED)
    : truncate(line);
  if (r.cycle) {
    const line = `${r.branch}  ${DIM}↺ ${shortId(r.id)}${RESET}`;
    return wrap(line, false);
  }
  const node = cNode(r.id);
  const dot = coloredGlyph(node);
  const rawName = navLabel(node, r.id);
  const name = r.isSelf ? `${BOLD}${rawName}${RESET}` : rawName;
  const kind = `${DIM}${node?.kind ?? ''}${RESET}`;
  const tokens = `${DIM}${tokensCell(r.id)}${RESET}`;
  // ▸ marks an expandable (collapsed-with-kids) row. The cursor row gets no
  // caret — its reverse-video bar already distinguishes it — so the triangle
  // reads purely as "this unfolds".
  const expandable = r.hasKids && r.collapsed;
  const caret = !isCursor && expandable ? `${DIM}▸${RESET} ` : '  ';
  const fold = expandable ? ` ${DIM}[+${childCount(r.id)}]${RESET}` : '';
  const line = `${r.branch}${caret}${dot} ${name} ${kind} ${tokens}${cycleBadge(node)}${childBadge(node)}${liveBelowBadge(node, activeBelow)}${fold}${askBadge(r.id, asks)}${activityCell(r.id, node)}`;
  return wrap(line, isAttached(r.id, node, focused));
}

/** Total lines the GRAPH widget may emit. pi hard-caps extension widgets at
 *  MAX_WIDGET_LINES — anything past that pi truncates itself, eating our own
 *  scroll chrome — so never exceed it (and shrink on a very short terminal).
 *  The viewport scrolls WITHIN this cap as the cursor moves. */
export function graphWidgetBudget(): number {
  const rows = process.stdout.rows ?? VIEWPORT_FALLBACK_ROWS;
  return Math.max(4, Math.min(PI_MAX_WIDGET_LINES, rows - 4));
}

export const GRAPH_HINT = `${DIM}jk move · hl fold · ↵ focus · e expand · x kill · m mgr · esc${RESET}`;
