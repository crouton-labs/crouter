// canvas-nav.ts — pi extension for pi-native canvas agent nodes.
//
// A BASE/GRAPH state machine drawn as chrome around the editor. The editor is
// "you" (this node); the chrome shows your place in the canvas graph.
//
//   BASE  (default, passive) — a vertical stack: your manager above the editor,
//         your live reports below it. Captures NO keys; typing is never touched.
//
//   GRAPH (modal, opt-in) — a NERDTree-style tree of your local graph (ancestry
//         root → you → your subtree, with peers) drawn into one tall widget.
//         While in GRAPH the extension consumes EVERY key and interprets it:
//           j/k move · h/l fold · g/G top/bottom · ↵ focus · m focus manager ·
//           e expand→tmux · x kill (y/n confirm) · esc back to BASE
//         plus any user-defined graphBinds (additive; built-ins are reserved).
//
// Enter/leave GRAPH with the `/graph` slash command, the `prefixKey` shortcut
// (default alt+g, configurable), or the tmux alt+c menu's `g` item. Inside tmux
// alt+c is a tmux display-menu (not a pi key), so prefix chords (m/e/1-9/custom)
// are tmux menu items that route through `crtr canvas chord`.
//
// Selection / liveness signals:
//   CURSOR (selected) = reverse-video bar (ESC[7m), full width — an attribute,
//                       not a colour, so it reads under NO_COLOR. Plus a ▸ caret.
//   ACTIVE (running)  = a coloured background bar (status 'active'); the dot
//                       glyph still carries the signal where colour is stripped.
//   SELF              = bold name — a quiet "you are here" marker.
//
// Folding is auto by default: a branch stays COLLAPSED unless its subtree holds
// a running ('active') agent or self. h/l override that per-node and persist.
//
// ⚑K pending-asks is PER-NODE, inline on each waiting node's own row (manager,
// reports, tree rows; self shows a trailing ⚑ line in BASE). ⤳M direct-children
// badge shows only on orchestrator rows.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session or legacy job agent).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, subscribersOf, subscriptionsOf, jobDir, fullName } from '../core/canvas/index.js';
import type { NodeMeta } from '../core/canvas/index.js';
import { readConfig } from '../core/config.js';
import type { CanvasNavConfig, CanvasBind } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids a hard dep on @earendil-works/*)
//
// Signatures sourced from pi-coding-agent's
//   dist/core/extensions/types.d.ts (setWidget / onTerminalInput / getEditorText)
//   docs/extensions.md (registerCommand / registerShortcut)
// ---------------------------------------------------------------------------

type PiEvents = 'session_start' | 'turn_end' | 'session_shutdown';

interface ExtensionWidgetOptions {
  placement?: 'aboveEditor' | 'belowEditor';
}

interface UIContext {
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  /** Raw key tap that fires BEFORE the editor. Return {consume:true} to swallow
   *  the key. Returns an unsub. */
  onTerminalInput?(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText?(): string;
  notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
}

interface ExtensionCtx {
  ui: UIContext;
}

interface CommandCtx {
  ui: UIContext;
}

interface PiLike {
  on(event: PiEvents, handler: (event: any, ctx: ExtensionCtx) => void | Promise<void>): void;
  registerCommand?(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
  ): void;
  registerShortcut?(
    shortcut: string,
    options: { description?: string; handler: (ctx: CommandCtx) => void | Promise<void> },
  ): void;
}

// ---------------------------------------------------------------------------
// Module-level state — persists across /reload so guards don't stack and fold
// state / current view survive a hot-swap.
// ---------------------------------------------------------------------------

/** The one live background timer. Cleared and replaced on every re-registration. */
let liveTimer: ReturnType<typeof setInterval> | undefined;

/** The one live onTerminalInput unsubscribe. Cleared/replaced on /reload so
 *  exactly one key tap exists (mirrors the liveTimer double-guard). */
let liveUnsub: (() => void) | undefined;

/** Current view. Reset to 'base' on every session_start (incl. /reload). */
type View = 'base' | 'graph';
let view: View = 'base';

/** Manual fold OVERRIDES in GRAPH, keyed by id (so a topology change can't
 *  corrupt them; stale ids are ignored). They override the default policy —
 *  collapsed UNLESS the subtree holds a running ('active') agent or self (see
 *  computeDefaultExpanded). `h` collapses → userCollapsed; `l` expands →
 *  userExpanded. Both survive renders AND BASE↔GRAPH toggles. */
const userCollapsed = new Set<string>();
const userExpanded = new Set<string>();

/** GRAPH cursor (a node id, not an index — indices shift as topology changes). */
let cursorId: string | undefined;

/** GRAPH viewport scroll offset (row index of the top visible row). */
let scrollTop = 0;

/** Transient y/n confirm gate inside GRAPH (kill / confirm-binds). */
let pendingConfirm: { label: string; action: () => void } | undefined;

/** Per-node pending-ask counts, refreshed by the timer; renders read this. */
let asksMap: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const ASK_POLL_MS = 5_000;
const RENDER_DEBOUNCE_MS = 150;
/** pi's InteractiveMode.MAX_WIDGET_LINES — the hard cap on lines in a string
 *  array widget; anything beyond it pi truncates with its own "... (widget
 *  truncated)". Our GRAPH viewport stays at/under this and scrolls internally. */
const PI_MAX_WIDGET_LINES = 10;
const VIEWPORT_FALLBACK_ROWS = 30;

// ---------------------------------------------------------------------------
// ANSI styling. pi renders embedded escapes in widget lines and measures width
// ANSI-aware, so raw escapes are safe and need no pi-tui dependency. The cursor
// (selected row) uses a theme-agnostic ATTRIBUTE (reverse), so it reads under
// NO_COLOR; the active-row tint is a background COLOUR, but the differing dot
// glyph (●/○/✓/✗) keeps the running signal even where colour is stripped.
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
/** Dark-green background bar marking a running ('active') node — distinct from
 *  the cursor's reverse-video bar; chosen so default-fg text stays readable. */
const BG_ACTIVE = `${ESC}48;5;22m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;

/** Status glyph colored by state: active green, idle dim, done cyan, dead red. */
function coloredGlyph(node: NodeMeta | null): string {
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
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Truncate to `max` VISIBLE columns: escape sequences are copied through
 *  verbatim (so a cut never lands mid-escape) and the result always ends in
 *  RESET, so a clipped style can't bleed into the editor below. */
function truncate(s: string, max = fillWidth()): string {
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
function fillWidth(): number {
  return Math.max(20, Math.min((process.stdout.columns ?? 80) - 2, 180));
}

/** Wrap `content` in a full-width background bar opened by `open` (REVERSE for
 *  the cursor, BG_ACTIVE for a running node). `open` is re-asserted after every
 *  embedded RESET so a coloured cell (the status dot) can't punch a hole in the
 *  bar; the visible width is padded out to `width`; the line closes with a real
 *  RESET so the style never bleeds into the editor below. */
function fillBar(content: string, width: number, open: string): string {
  const clipped = truncate(content, width);
  const reasserted = clipped.replace(/\x1b\[0m/g, `${RESET}${open}`);
  const pad = Math.max(0, width - visibleWidth(clipped));
  return `${open}${reasserted}${' '.repeat(pad)}${RESET}`;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

interface Telemetry {
  tokens_in?: number;
}

function readTelemetry(nodeId: string): Telemetry {
  try {
    const p = join(jobDir(nodeId), 'telemetry.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) as Telemetry;
  } catch {
    return {};
  }
}

function fmtTokens(n: number): string {
  return n < 1_000 ? `${n}` : `${Math.round(n / 1_000)}k`;
}

function tokensCell(id: string): string {
  return fmtTokens(readTelemetry(id).tokens_in ?? 0);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Per-node ask counts — ONE shell-out per poll. `crtr canvas attention map`
// buckets a whole sub-DAG's pending asks by node in a single process, so the
// timer stays cheap (< 2 s) regardless of how many nodes are visible. --json
// gives a parseable {counts} blob (the default render is XML chrome).
// ---------------------------------------------------------------------------

function fetchAsksMap(rootId: string): Record<string, number> {
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
function managerOf(id: string): string | undefined {
  try { return subscribersOf(id)[0]?.node_id; } catch { return undefined; }
}

/** A kind:'human' node is a control-plane ASK (a humanloop deck on the human's
 *  screen), NOT a pi conversation — it has no session, so focusing/reviving it
 *  boots a confused blank "you have been revived" pi. Its pending-ask signal
 *  already rides the ⚑ badge on the ASKING node (attention.ts attributes asks by
 *  source.nodeId, never to the human node), so the row carries no signal of its
 *  own. Drop it from every navigable list (the tree, BASE reports, child counts,
 *  subtree expansion) so it can never be selected. */
function isHumanAsk(id: string): boolean {
  return getNode(id)?.kind === 'human';
}

/** A node's direct children that are navigable conversations — human-ask nodes
 *  dropped. The one place the nav chrome enumerates children. */
function convoChildIds(id: string): string[] {
  try {
    return subscriptionsOf(id).map((s) => s.node_id).filter((cid) => !isHumanAsk(cid));
  } catch {
    return [];
  }
}

/** Live reports (active|idle) of a node — the DOWN set in BASE. */
function liveReports(id: string): string[] {
  return convoChildIds(id).filter((cid) => {
    const st = getNode(cid)?.status;
    return st === 'active' || st === 'idle';
  });
}

/** Direct navigable children — used for the ⤳ badge and fold counts (human-ask
 *  nodes excluded, so the count matches what the tree actually shows). */
function childCount(id: string): number {
  return convoChildIds(id).length;
}

/** Climb first-manager edges from `self` to the ancestry root (cycle-guarded). */
function climbRoot(self: string): string {
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
function subtreeIds(root: string): string[] {
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
function childBadge(node: NodeMeta | null): string {
  if (node === null || node.mode !== 'orchestrator') return '';
  const m = childCount(node.node_id);
  return m > 0 ? ` ${DIM}⤳${m}${RESET}` : '';
}

/** ⚑K pending-asks badge for a node, read from the cached map. */
function askBadge(id: string): string {
  const k = asksMap[id] ?? 0;
  return k > 0 ? ` ${YELLOW}⚑${k}${RESET}` : '';
}

/** Sort rank for sibling ordering — live nodes (active, then idle) ahead of
 *  terminal ones, so sessions still running surface at the TOP of each child
 *  group instead of being buried under finished/failed ones. */
function statusRank(id: string): number {
  switch (getNode(id)?.status) {
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
function sortedChildIds(id: string): string[] {
  return convoChildIds(id).sort((a, b) => statusRank(a) - statusRank(b));
}

// ---------------------------------------------------------------------------
// GRAPH model — flatten the local graph fold-aware. Rebuilt every render (cheap
// sqlite reads) so a finished child / new spawn shows live; the manual fold
// overrides and the cursor id are the only persisted state.
// ---------------------------------------------------------------------------

interface FlatRow {
  id: string;
  hasKids: boolean;
  isSelf: boolean;
  branch: string;     // tree connector prefix drawn before the caret/dot
  cycle: boolean;     // a re-encountered id (back-ref), not recursed into
  collapsed: boolean; // currently folded (default policy or manual override)
}

/** Default fold policy: which nodes auto-EXPAND. A node expands only when one
 *  of its child subtrees holds a running ('active') agent or self — so the path
 *  to any live agent (and to you) is revealed while quiescent branches stay
 *  folded. One bottom-up O(N) pass from the ancestry root; cycle-guarded. */
function computeDefaultExpanded(root: string, self: string): Set<string> {
  const expand = new Set<string>();
  const seen = new Set<string>();
  // Returns whether subtree(id), INCLUDING id, holds an active node or self.
  const visit = (id: string): boolean => {
    if (seen.has(id)) return id === self || getNode(id)?.status === 'active';
    seen.add(id);
    let childRevealing = false;
    for (const c of convoChildIds(id)) if (visit(c)) childRevealing = true;
    if (childRevealing) expand.add(id); // a descendant is worth revealing → unfold id
    return childRevealing || id === self || getNode(id)?.status === 'active';
  };
  visit(root);
  return expand;
}

function buildGraphModel(self: string): FlatRow[] {
  const rootId = climbRoot(self);
  const defaultExpanded = computeDefaultExpanded(rootId, self);
  // userExpanded / userCollapsed override the auto policy; absent → policy decides.
  const isFolded = (id: string): boolean =>
    userExpanded.has(id) ? false : userCollapsed.has(id) ? true : !defaultExpanded.has(id);
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

/** Render one GRAPH row. CURSOR (selected) → reverse-video bar; an ACTIVE
 *  (running) node → a coloured background bar; SELF → bold name. The cursor
 *  outranks the active tint when both land on the same row. */
function renderGraphRow(r: FlatRow, isCursor: boolean): string {
  const wrap = (line: string, active: boolean): string =>
    isCursor ? fillBar(line, fillWidth(), REVERSE)
    : active ? fillBar(line, fillWidth(), BG_ACTIVE)
    : truncate(line);
  if (r.cycle) {
    const line = `${r.branch}  ${DIM}↺ ${shortId(r.id)}${RESET}`;
    return wrap(line, false);
  }
  const node = getNode(r.id);
  const dot = coloredGlyph(node);
  const rawName = node !== null ? fullName(node) : shortId(r.id);
  const name = r.isSelf ? `${BOLD}${rawName}${RESET}` : rawName;
  const kind = `${DIM}${node?.kind ?? ''}${RESET}`;
  const tokens = `${DIM}${tokensCell(r.id)}${RESET}`;
  const caret = isCursor ? `${BOLD}▸${RESET} ` : '  ';
  const fold = r.hasKids && r.collapsed ? ` ${DIM}[+${childCount(r.id)}]${RESET}` : '';
  const line = `${r.branch}${caret}${dot} ${name} ${kind} ${tokens}${childBadge(node)}${fold}${askBadge(r.id)}`;
  return wrap(line, node?.status === 'active');
}

/** Total lines the GRAPH widget may emit. pi hard-caps extension widgets at
 *  MAX_WIDGET_LINES — anything past that pi truncates itself, eating our own
 *  scroll chrome — so never exceed it (and shrink on a very short terminal).
 *  The viewport scrolls WITHIN this cap as the cursor moves. */
function graphWidgetBudget(): number {
  const rows = process.stdout.rows ?? VIEWPORT_FALLBACK_ROWS;
  return Math.max(4, Math.min(PI_MAX_WIDGET_LINES, rows - 4));
}

const GRAPH_HINT = `${DIM}jk move · hl fold · ↵ focus · e expand · x kill · m mgr · esc${RESET}`;

// ---------------------------------------------------------------------------
// Key decoding — recognizers tolerant of legacy, kitty/CSI-u and
// modifyOtherKeys encodings (pi enables the kitty / modifyOtherKeys protocols,
// and tmux with `extended-keys csi-u` delivers modified keys as CSI-u, not the
// legacy ESC-prefix form). Mirrors pi-tui's parseKey, kept dependency-free.
// ---------------------------------------------------------------------------

const CSI_U_RE = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/;
const MOK_RE = /^\x1b\[27;(\d+);(\d+)~$/;

/** True when a decoded CSI-u modifier (already `mod-1`) is Alt and nothing else
 *  besides lock keys. */
function isAltOnly(mod: number): boolean {
  return (mod & 2) !== 0 && (mod & (1 | 4 | 8 | 16 | 32)) === 0;
}

/** Recognize Alt+<letter> across legacy, kitty/CSI-u and modifyOtherKeys. */
function isAltKey(data: string, letter: string): boolean {
  const code = letter.charCodeAt(0);
  if (data === `\x1b${letter}`) return true;
  const u = CSI_U_RE.exec(data);
  if (u !== null) {
    const mod = u[2] !== undefined ? parseInt(u[2], 10) - 1 : 0;
    return parseInt(u[1], 10) === code && isAltOnly(mod);
  }
  const m = MOK_RE.exec(data);
  if (m !== null) {
    return parseInt(m[2], 10) === code && isAltOnly(parseInt(m[1], 10) - 1);
  }
  return false;
}

/** Recognize a PLAIN letter (no Alt) across the bare byte and kitty CSI-u
 *  single-char form. Uppercase letters also match lowercase-code + Shift. */
function isPlain(data: string, ch: string): boolean {
  if (data === ch) return true;
  const lower = ch.toLowerCase();
  const needShift = ch !== lower;
  const code = lower.charCodeAt(0);
  const m = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(data);
  if (m !== null) {
    if (parseInt(m[1], 10) !== code) return false;
    const mod = m[2] !== undefined ? parseInt(m[2], 10) - 1 : 0;
    return needShift ? (mod & 1) !== 0 && (mod & ~1) === 0 : mod === 0;
  }
  return false;
}

/** Plain Enter across legacy and kitty (ESC [ 13 u). */
function isEnterKey(data: string): boolean {
  return data === '\r' || data === '\n' || /^\x1b\[13(?:;1)?u$/.test(data);
}

/** Plain Escape across legacy and kitty (ESC [ 27 u). */
function isEscKey(data: string): boolean {
  return data === '\x1b' || /^\x1b\[27(?:;1)?u$/.test(data);
}

/** Extract the bare letter of an `alt+<letter>` prefix spec (else undefined). */
function altLetterOf(spec: string | undefined): string | undefined {
  const m = /^alt\+([a-zA-Z])$/.exec(spec ?? '');
  return m ? m[1]!.toLowerCase() : undefined;
}

// Built-in GRAPH keys are reserved; graphBinds may only ADD other keys.
const RESERVED_GRAPH_KEYS = new Set(['j', 'k', 'h', 'l', 'g', 'G', 'm', 'e', 'x', 'y', 'n']);

/** Split a `run` string argv-style and interpolate {id|self|name|manager|lane|
 *  subtree}. A bare `{subtree}` token expands to several argv elements; every
 *  other placeholder substitutes in place (kept as one element so a multi-word
 *  name survives as a single argument under execFile). */
function interpolateArgv(run: string, vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const tok of run.split(/\s+/).filter((t) => t !== '')) {
    if (tok === '{subtree}') {
      for (const part of (vars['subtree'] ?? '').split(/\s+/).filter((p) => p !== '')) out.push(part);
      continue;
    }
    out.push(tok.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the canvas nav chrome on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasNav(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  // Captured from session_start; used in every subsequent render.
  let ui: UIContext | undefined;
  let renderScheduled = false;

  // Cache config once (binds rarely change within a session; readConfig is sync
  // and never throws). prefixKey drives the non-tmux GRAPH toggle shortcut.
  let navConfig: CanvasNavConfig;
  try { navConfig = readConfig('user').canvasNav; } catch { navConfig = { prefixBinds: {}, graphBinds: {} }; }
  const prefixAltLetter = altLetterOf(navConfig.prefixKey);

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------

  /** BASE: manager line above the editor, reports stack below it. */
  const renderBase = (): void => {
    if (ui === undefined) return;

    const mgr = managerOf(nodeId);
    if (mgr === undefined) {
      // Root node: no manager → drop the widget rather than show "↑ (root)" chrome.
      ui.setWidget('crtr-managers', undefined, { placement: 'aboveEditor' });
    } else {
      const mn = getNode(mgr);
      const name = mn !== null ? fullName(mn) : shortId(mgr);
      const mgrLine = truncate(
        `↑ ${name} ${coloredGlyph(mn)} ${DIM}${mn?.kind ?? ''}${RESET} ${DIM}${tokensCell(mgr)}${RESET}${childBadge(mn)}${askBadge(mgr)}`,
      );
      ui.setWidget('crtr-managers', [mgrLine], { placement: 'aboveEditor' });
    }

    const reports = liveReports(nodeId);
    const lines: string[] = [];
    // Report rows only — no "↓ reports (N)" header (the label carries no signal).
    if (reports.length > 0) {
      const nameW = Math.min(20, Math.max(...reports.map((id) => {
        const n = getNode(id);
        return (n !== null ? fullName(n) : shortId(id)).length;
      })));
      for (const id of reports) {
        const n = getNode(id);
        const name = (n !== null ? fullName(n) : shortId(id)).padEnd(nameW);
        const kind = `${DIM}${(n?.kind ?? '').padEnd(6)}${RESET}`;
        const tokens = `${DIM}${tokensCell(id).padStart(5)}${RESET}`;
        lines.push(truncate(`  ${coloredGlyph(n)} ${name} ${kind} ${tokens}${childBadge(n)}${askBadge(id)}`));
      }
    }
    // Self's own pending asks (no self row in BASE) → a trailing inline line.
    const selfAsks = asksMap[nodeId] ?? 0;
    if (selfAsks > 0) lines.push(`${YELLOW}⚑${selfAsks}${RESET}`);
    // Nothing to show → drop the widget rather than render an empty bar.
    ui.setWidget('crtr-base', lines.length > 0 ? lines : undefined, { placement: 'belowEditor' });

    // Drop GRAPH chrome so nothing bleeds through.
    ui.setWidget('crtr-graph', undefined, { placement: 'belowEditor' });
  };

  /** GRAPH: the fold-aware tree + a one-line hint/footer, viewport-bounded. */
  const renderGraph = (): void => {
    if (ui === undefined) return;

    const rows = buildGraphModel(nodeId);

    // Re-resolve the cursor id → row (it may have vanished under a fold or a
    // close); clamp to nearest visible row.
    let cursorIdx = rows.findIndex((r) => r.id === cursorId);
    if (cursorIdx < 0) {
      cursorIdx = rows.findIndex((r) => r.id === nodeId);
      if (cursorIdx < 0) cursorIdx = 0;
    }
    cursorId = rows[cursorIdx]?.id ?? nodeId;

    // Budget WITHIN pi's widget cap (see graphWidgetBudget): reserve 1 line for
    // the footer hint, up to 2 for the ↑/↓ "more" indicators, the rest for tree
    // rows. The window then tracks the cursor, so j/k scrolls through the WHOLE
    // list rather than hitting pi's hard truncation. The passes settle the
    // mutual dependency between "how many rows fit" and "are indicators shown":
    // each ↑/↓ indicator steals a tree row, which can push the cursor out of
    // view, which moves the window, which changes whether an indicator shows.
    // This needs up to 3 passes to converge (an indicator appearing shrinks the
    // window, the smaller window re-homes scrollTop, that re-home can toggle the
    // *other* indicator). Bailing early (the old 2-pass cap) left the cursor one
    // row off-screen for a single keypress near the bottom — the arrow vanished
    // and only the NEXT press scrolled. 4 passes always settles to a stable,
    // cursor-visible window.
    const treeArea = Math.max(2, graphWidgetBudget() - 1);
    let viewportH = treeArea;
    for (let pass = 0; pass < 4; pass++) {
      if (cursorIdx < scrollTop) scrollTop = cursorIdx;
      if (cursorIdx >= scrollTop + viewportH) scrollTop = cursorIdx - viewportH + 1;
      scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - viewportH)));
      const fit = treeArea - (scrollTop > 0 ? 1 : 0) - (scrollTop + viewportH < rows.length ? 1 : 0);
      if (fit === viewportH) break;
      viewportH = Math.max(1, fit);
    }
    const end = Math.min(rows.length, scrollTop + viewportH);

    const lines: string[] = [];
    if (scrollTop > 0) lines.push(`${DIM}  ↑ ${scrollTop} more${RESET}`);
    for (let i = scrollTop; i < end; i++) lines.push(renderGraphRow(rows[i]!, i === cursorIdx));
    if (end < rows.length) lines.push(`${DIM}  ↓ ${rows.length - end} more${RESET}`);

    const hint = pendingConfirm !== undefined
      ? `${YELLOW}${pendingConfirm.label} ${BOLD}y/n${RESET}`
      : GRAPH_HINT;
    lines.push(truncate(`${hint}  ${DIM}${cursorIdx + 1}/${rows.length}${RESET}`));

    ui.setWidget('crtr-graph', lines, { placement: 'belowEditor' });
    // Drop BASE chrome.
    ui.setWidget('crtr-managers', undefined, { placement: 'aboveEditor' });
    ui.setWidget('crtr-base', undefined, { placement: 'belowEditor' });
  };

  const render = (): void => {
    if (ui === undefined) return;
    try {
      if (view === 'graph') renderGraph();
      else renderBase();
    } catch {
      /* render is best-effort; never throw out of a handler */
    }
  };

  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout((): void => {
      renderScheduled = false;
      render();
    }, RENDER_DEBOUNCE_MS);
  };

  // -------------------------------------------------------------------------
  // Actions (all shell out; the extension stays tmux/revive-free)
  // -------------------------------------------------------------------------

  const shellCrtr = (argv: string[], onDone?: () => void): void => {
    try {
      execFile('crtr', argv, (err): void => {
        if (err != null && ui?.notify != null) {
          try { ui.notify(`crtr ${argv[0]} failed`, 'error'); } catch { /* best-effort */ }
        }
        if (onDone !== undefined) { try { onDone(); } catch { /* best-effort */ } }
      });
    } catch {
      /* best-effort */
    }
  };

  const focusTarget = (id: string): void => shellCrtr(['node', 'focus', id]);

  const enterGraph = (): void => {
    view = 'graph';
    pendingConfirm = undefined;
    scrollTop = 0;
    if (cursorId === undefined || getNode(cursorId) === null) cursorId = nodeId;
    render();
  };
  const exitGraph = (): void => {
    view = 'base';
    pendingConfirm = undefined;
    render();
  };
  const toggleGraph = (): void => {
    if (view === 'graph') exitGraph();
    else enterGraph();
  };

  /** Template vars for a graphBind, resolved against the CURSOR node. */
  const graphVars = (cur: string): Record<string, string> => {
    const cn = getNode(cur);
    return {
      id: cur,
      self: nodeId,
      lane: cur,
      name: cn !== null ? fullName(cn) : cur,
      manager: managerOf(cur) ?? '',
      subtree: subtreeIds(cur).join(' '),
    };
  };

  // -------------------------------------------------------------------------
  // GRAPH modal key handler — consumes EVERY key while in GRAPH.
  // -------------------------------------------------------------------------
  const handleGraphKey = (data: string): { consume?: boolean; data?: string } | undefined => {
    // y/n confirm gate takes precedence over everything.
    if (pendingConfirm !== undefined) {
      if (isPlain(data, 'y')) {
        const act = pendingConfirm.action;
        pendingConfirm = undefined;
        act();
        render();
        return { consume: true };
      }
      pendingConfirm = undefined; // any other key cancels
      render();
      return { consume: true };
    }

    // Let the prefix shortcut (alt+g) through so pi's registerShortcut can
    // toggle us back to BASE; esc also exits, handled below.
    if (prefixAltLetter !== undefined && isAltKey(data, prefixAltLetter)) return undefined;

    if (isEscKey(data)) { exitGraph(); return { consume: true }; }

    const rows = buildGraphModel(nodeId);
    let idx = rows.findIndex((r) => r.id === cursorId);
    if (idx < 0) idx = Math.max(0, rows.findIndex((r) => r.id === nodeId));
    const cur = rows[idx];

    if (isPlain(data, 'j')) { idx = Math.min(rows.length - 1, idx + 1); cursorId = rows[idx]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'k')) { idx = Math.max(0, idx - 1); cursorId = rows[idx]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'g')) { cursorId = rows[0]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'G')) { cursorId = rows[rows.length - 1]?.id ?? cursorId; render(); return { consume: true }; }

    if (isPlain(data, 'h')) {
      if (cur !== undefined && cur.hasKids && !cur.collapsed) {
        userCollapsed.add(cur.id);
        userExpanded.delete(cur.id);
      } else {
        const p = managerOf(cursorId ?? nodeId);
        if (p !== undefined && rows.some((r) => r.id === p)) cursorId = p;
      }
      render();
      return { consume: true };
    }
    if (isPlain(data, 'l')) {
      if (cur !== undefined && cur.collapsed && cur.hasKids) {
        userExpanded.add(cur.id);
        userCollapsed.delete(cur.id);
      } else if (cur !== undefined && cur.hasKids) {
        const c = sortedChildIds(cur.id)[0];
        if (c !== undefined) cursorId = c;
      }
      render();
      return { consume: true };
    }

    if (isEnterKey(data)) { if (cursorId !== undefined) focusTarget(cursorId); render(); return { consume: true }; }
    if (isPlain(data, 'm')) { const mgr = managerOf(nodeId); if (mgr !== undefined) focusTarget(mgr); render(); return { consume: true }; }
    if (isPlain(data, 'e')) { shellCrtr(['canvas', 'tmux-spread', nodeId]); return { consume: true }; }
    if (isPlain(data, 'x')) {
      const target = cursorId ?? nodeId;
      const n = getNode(target);
      const nm = n !== null ? fullName(n) : shortId(target);
      pendingConfirm = { label: `kill ${nm}?`, action: () => shellCrtr(['node', 'close', '--node', target], render) };
      render();
      return { consume: true };
    }

    // Custom graphBinds — additive only (built-in keys reserved).
    for (const [key, bind] of Object.entries(navConfig.graphBinds) as [string, CanvasBind][]) {
      if (key.length !== 1 || RESERVED_GRAPH_KEYS.has(key)) continue;
      if (!isPlain(data, key)) continue;
      const target = cursorId ?? nodeId;
      const argv = interpolateArgv(bind.run, graphVars(target));
      if (argv.length === 0) return { consume: true };
      if (bind.confirm === true) {
        const n = getNode(target);
        const nm = n !== null ? fullName(n) : shortId(target);
        pendingConfirm = { label: `${bind.desc ?? bind.run} ${nm}?`, action: () => shellCrtr(argv, render) };
      } else {
        shellCrtr(argv, render);
      }
      render();
      return { consume: true };
    }

    // Modal: swallow everything else so stray keys never reach the editor.
    return { consume: true };
  };

  // Pre-editor key tap. BASE passes EVERY key through (composing is never
  // disturbed); GRAPH is fully modal. One persistent tap (preserving the
  // /reload single-unsub guard); its body branches on `view`.
  const handleKey = (data: string): { consume?: boolean; data?: string } | undefined => {
    try {
      if (ui === undefined) return undefined;
      if (view === 'base') return undefined;
      return handleGraphKey(data);
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // Slash command + shortcut to toggle GRAPH (registered once per load, like
  // canvas-commands.ts; pi dedupes duplicate names on /reload).
  // -------------------------------------------------------------------------
  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand('graph', {
      description: 'Toggle the canvas GRAPH view (NERDTree of your local graph)',
      handler: async (_args, ctx): Promise<void> => {
        if (ui === undefined) ui = ctx.ui;
        toggleGraph();
      },
    });
  }
  if (typeof pi.registerShortcut === 'function' && navConfig.prefixKey !== undefined && navConfig.prefixKey !== '') {
    try {
      pi.registerShortcut(navConfig.prefixKey, {
        description: 'Toggle the canvas GRAPH view',
        handler: async (ctx): Promise<void> => {
          if (ui === undefined) ui = ctx.ui;
          toggleGraph();
        },
      });
    } catch {
      /* shortcut spec rejected by pi — /graph + the alt+c menu still work */
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  pi.on('session_start', (_event: any, ctx: ExtensionCtx): void => {
    ui = ctx.ui;

    // Fresh session / hot-swap: start in BASE and clear any legacy or
    // inactive-view widgets so nothing stale bleeds through.
    view = 'base';
    pendingConfirm = undefined;
    for (const key of ['crtr-asks', 'crtr-siblings', 'crtr-reports', 'crtr-graph']) {
      try { ctx.ui.setWidget(key, undefined, { placement: 'belowEditor' }); } catch { /* ignore */ }
      try { ctx.ui.setWidget(key, undefined, { placement: 'aboveEditor' }); } catch { /* ignore */ }
    }

    // Register the modal key tap once. Double-guard against /reload stacking
    // (mirrors liveTimer): clear any previous tap before adding ours.
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
    try {
      if (typeof ctx.ui.onTerminalInput === 'function') {
        liveUnsub = ctx.ui.onTerminalInput(handleKey);
      }
    } catch {
      /* onTerminalInput unavailable — chrome stays display-only */
    }

    scheduleRender();
  });

  pi.on('turn_end', (_event: any, _ctx: ExtensionCtx): void => {
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Background timer — per-node ask polling (one shell-out) + periodic refresh
  // -------------------------------------------------------------------------
  if (liveTimer !== undefined) clearInterval(liveTimer);

  const timer = setInterval((): void => {
    try {
      const rootId = climbRoot(nodeId);
      const fresh = fetchAsksMap(rootId);
      // Repaint only when the map actually changed — avoids constant flicker.
      if (JSON.stringify(fresh) !== JSON.stringify(asksMap)) {
        asksMap = fresh;
        scheduleRender();
      }
    } catch {
      /* timer is best-effort */
    }
  }, ASK_POLL_MS);

  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  pi.on('session_shutdown', (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
  });
}

export default registerCanvasNav;
