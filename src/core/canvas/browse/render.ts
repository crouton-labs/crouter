// render.ts — pure frame rendering for the canvas browser.
//
// renderFrame(state, size, caps) → a full-screen string. The app writes it
// verbatim on every keystroke. Redraw is flicker-free: home the cursor (\x1b[H),
// clear each line to EOL (\x1b[K), and clear below the last line (\x1b[J) so a
// shrunk frame leaves no stale rows. A full frame per keypress is fine for a
// picker.
//
// COLOR is browse-only and *reinforces* the status glyphs (`● ○ ✓ ✗ ⊘`) which
// stay the primary, color-free encoding (colorblind / light-bg / NO_COLOR safe).
// Every hue (fg / bg color) is gated on `caps.color`; structural SGR (bold/dim/
// reverse) is allowed always. See detectColorCaps() for the gate, and the
// canvas-browse color spec for the rationale + palette.

import type { NodeStatus } from '../types.js';
import type { DashboardRow } from '../render.js';
import type { Tab, Tree, VisibleRow, SortMode } from './model.js';
import { TABS, matchIndices, promptText, previewSnippet, type SnippetLine } from './model.js';
// Span/color primitives live in core/tui/draw.ts (one copy, shared with the
// `crtr view` host). Re-export the color caps so browse's importers + tests keep
// resolving them from this module.
import { clip, assemble, detectColorCaps, type Span, type ColorCaps } from '../../tui/draw.js';
export { detectColorCaps };
export type { ColorCaps };

// Fixed chrome heights, shared with app.ts so its viewport math never drifts
// from what renderFrame actually draws.
//   header = title + tab bar + status line + separator (+ search input when searching)
//   preview = separator + meta line + PROMPT_LINES (spawn/match) + REPLY_LINES (last reply)
export const PROMPT_LINES = 3;
export const REPLY_LINES = 3;
export const PREVIEW_BODY = PROMPT_LINES + REPLY_LINES;
export const PREVIEW_HEIGHT = PREVIEW_BODY + 2;
//   header = title + tab bar + status line + column header + separator (+ search input)
export function headerHeight(search: boolean): number {
  return 5 + (search ? 1 : 0);
}

// ── Row table layout ──────────────────────────────────────────────────────────
// A row is three zones: a fixed-width STATUS rail (glyph + word) on the left, the
// flexible tree-indented NAME in the middle, and a flush-right METADATA cluster
// (kind/mode · ctx · age · project) whose fixed-width segments align into clean
// vertical columns down the right edge. Wide terminals widen the name; narrow ones
// clip the name (and drop the cluster) first. The status WORD — not a lone glyph —
// is the legible, NO_COLOR-safe state signal.
const STATUS_W = 10; // glyph + ' ' + longest word ('active'/'cancel') + trailing gap
const KM_W = 22;     // kind/mode column
const CTX_W = 6;     // ctx tokens column
const AGE_W = 5;     // age column
const PROJ_W = 16;   // project (~basename) column, only across All dirs
const COL_GAP = '  ';

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const REVERSE = `${ESC}7m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CURSOR_BG = `${ESC}48;5;236m`; // subtle dark-gray cursor-row bg (256-color)

// Basic-16 ANSI fg codes used by the palette.
const FG_GREEN = '32';
const FG_YELLOW = '33';
const FG_RED = '31';
const FG_CYAN = '36';
const FG_GRAY = '90'; // bright-black
const FG_BRIGHT_YELLOW = '93';
const FG_BRIGHT_GREEN = '92'; // streaming pulse (brighter than the active-status green)
const FG_BRIGHT_CYAN = '96'; // query-match highlight (ties to the cyan search accent)

const STATUS_GLYPH: Record<NodeStatus, string> = {
  active:   '●',
  idle:     '○',
  done:     '✓',
  dead:     '✗',
  canceled: '⊘',
};

/** The load-bearing color: glyph hue per status. Single source of truth, mirrors
 *  STATUS_GLYPH. Reinforces the glyph everywhere it appears (rows + summary). */
const STATUS_COLOR: Record<NodeStatus, string> = {
  active:   FG_GREEN,
  idle:     FG_YELLOW,
  done:     FG_CYAN,
  dead:     FG_RED,
  canceled: FG_GRAY,
};

// ── Color capability ──────────────────────────────────────────────────────────

// ColorCaps + detectColorCaps now live in core/tui/draw.ts (re-exported above).

export interface RenderState {
  tree: Tree;
  visible: VisibleRow[];
  tab: Tab;
  cursor: number;      // index into `visible`
  scrollOffset: number;
  query: string;
  search: boolean;
  totalNodes: number;
  /** Active cwd-scope filter; null = All dirs. Shown on the status line. */
  cwdScope: string | null;
  /** Active ordering — status line + (flat modes) row presentation. */
  sort: SortMode;
  /** Whether the bottom preview panel is drawn. */
  preview: boolean;
  /** Lifecycle filter: when true, `terminal` (one-shot worker) nodes are hidden
   *  — surfaced as a status-line cue. */
  residentsOnly: boolean;
  /** When set, a close-out (`x`) is awaiting y/n confirmation because the node (or
   *  a descendant) is actively streaming. Holds the node id being confirmed; the
   *  footer becomes the y/n prompt. null/undefined = no pending confirm. */
  pendingClose?: string | null;
}

function fmtCtx(tokens: number): string {
  if (tokens <= 0) return '0k';
  return `${Math.floor(tokens / 1000)}k`;
}

/** Tiered ctx-budget hue: dim under 50k, yellow 50–100k, red ≥100k. `undefined`
 *  → dim (structural), so low budgets recede. */
function ctxColorCode(tokens: number): string | undefined {
  if (tokens >= 100_000) return FG_RED;
  if (tokens >= 50_000) return FG_YELLOW;
  return undefined;
}

/** Compact relative age, e.g. `45s` `12m` `3h` `5d` `2w` `4mo`. Empty on a bad
 *  timestamp. Drives the per-row recency cue + the preview meta line. */
function relAge(created: string, now: number): string {
  const t = Date.parse(created);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

/** Last path segment of a cwd — the project name shown as the All-dirs cue. */
function baseDir(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

// ── Styled spans ──────────────────────────────────────────────────────────────
//
// A row is built from styled spans, then assembled to a width-clipped line. This
// lets each cell carry its own hue (status glyph, ctx tier, asks, match highlight)
// while clipping by VISIBLE width — ANSI bytes don't count toward the column
// budget. `fg` is hue (gated on `color`); `bold`/`dim` are structural (always).

// Span / styleSpan / assemble now live in core/tui/draw.ts (imported above).

/** Status tallies across the whole canvas, for the right-aligned header. Memoized
 *  per tree — the snapshot is immutable for a browse session, so counting is done
 *  once, not O(N) on every keystroke (the "massive canvas" target). */
const summaryCache = new WeakMap<Tree, { status: NodeStatus; count: number }[]>();
function statusCounts(tree: Tree): { status: NodeStatus; count: number }[] {
  const cached = summaryCache.get(tree);
  if (cached !== undefined) return cached;
  const counts: Record<NodeStatus, number> = { active: 0, idle: 0, done: 0, dead: 0, canceled: 0 };
  for (const node of tree.nodes.values()) counts[node.row.status]++;
  const parts: { status: NodeStatus; count: number }[] = [];
  for (const s of ['active', 'idle', 'done', 'dead', 'canceled'] as NodeStatus[]) {
    if (counts[s] > 0) parts.push({ status: s, count: counts[s] });
  }
  summaryCache.set(tree, parts);
  return parts;
}

function tabBar(active: Tab, color: boolean): string {
  return TABS.map((t) => {
    if (t === active) {
      // Keep the [ ] brackets in BOTH paths so the active tab reads without color.
      return color ? `${BOLD}${ESC}${FG_CYAN}m[ ${t} ]${RESET}` : `${REVERSE}[ ${t} ]${RESET}`;
    }
    return color ? `${DIM}  ${t}  ${RESET}` : `  ${t}  `;
  }).join('');
}

const EMPTY_HI: ReadonlySet<number> = new Set();

/** Name → spans, splitting out the query-matched chars (bold + bright-cyan) so
 *  matches are scannable. Non-matched chars carry the row's name style (dim for
 *  terminal status, bold on the cursor row). */
function nameSpans(name: string, query: string, style: { dim: boolean; bold: boolean }): Span[] {
  const hi = query === '' ? EMPTY_HI : matchIndices(query, name);
  if (hi.size === 0) return [{ text: name, style: { dim: style.dim, bold: style.bold } }];
  const out: Span[] = [];
  let buf = '';
  let bufHi = false;
  const flush = (): void => {
    if (buf === '') return;
    if (bufHi) out.push({ text: buf, style: { fg: FG_BRIGHT_CYAN, bold: true } });
    else out.push({ text: buf, style: { dim: style.dim, bold: style.bold } });
    buf = '';
  };
  for (let i = 0; i < name.length; i++) {
    const h = hi.has(i);
    if (h !== bufHi) { flush(); bufHi = h; }
    buf += name[i];
  }
  flush();
  return out;
}

/** Visible (cell) width of a span group — ANSI-free, surrogate-safe. */
function spansWidth(spans: Span[]): number {
  let n = 0;
  for (const s of spans) n += [...s.text].length;
  return n;
}

/** The status rail: a status WORD next to its glyph, both in the status hue, padded
 *  to STATUS_W so the rail forms a clean left column. `live` (bright green) when the
 *  node is genuinely mid-turn; otherwise the lifecycle word. The word is what makes
 *  state legible at a glance and survives NO_COLOR (the glyph is the second cue). */
function statusRail(r: DashboardRow): Span[] {
  const streaming = r.streaming === true;
  const word = streaming
    ? 'live'
    : ({ active: 'active', idle: 'idle', done: 'done', dead: 'dead', canceled: 'cancel' }[r.status] ?? r.status);
  const fg = streaming ? FG_BRIGHT_GREEN : STATUS_COLOR[r.status];
  const glyph = streaming ? '⟳' : (STATUS_GLYPH[r.status] ?? '?');
  const text = `${glyph} ${word}`;
  const pad = Math.max(1, STATUS_W - [...text].length);
  return [
    { text, style: { fg, bold: streaming } },
    { text: ' '.repeat(pad) },
  ];
}

/** The flush-right metadata cluster as fixed-width segments, so kind/mode · ctx ·
 *  age · project align into vertical columns down the right edge. `showCwd` adds the
 *  project column (only meaningful across All dirs). */
function metaCluster(r: DashboardRow, now: number, showCwd: boolean): Span[] {
  const ctxFg = ctxColorCode(r.ctx_tokens);
  const out: Span[] = [
    { text: clipPad(`${r.kind}/${r.mode}`, KM_W), style: { fg: FG_GRAY } },
    { text: COL_GAP },
    { text: fmtCtx(r.ctx_tokens).padStart(CTX_W), style: { fg: ctxFg, dim: ctxFg === undefined } },
    { text: COL_GAP },
    { text: relAge(r.created, now).padStart(AGE_W), style: { dim: true } },
  ];
  if (showCwd) {
    out.push({ text: COL_GAP }, { text: clipPad(`~${baseDir(r.cwd)}`, PROJ_W), style: { fg: FG_GRAY } });
  }
  return out;
}

/** Left-clip-pad: clip `s` to `w` cells then pad-end with spaces to exactly `w`. */
function clipPad(s: string, w: number): string {
  return clip(s, w).padEnd(w);
}

/** Compose a row from a flexible LEFT zone and a fixed flush-right RIGHT cluster:
 *  pad fills the gap so RIGHT hugs the edge; when the terminal is too narrow the
 *  cluster is dropped rather than colliding with the name. The caller has already
 *  clipped the name to fit. */
function assembleRow(left: Span[], right: Span[], width: number, color: boolean, lineBase: string, fill: boolean): string {
  const leftW = spansWidth(left);
  const rightW = spansWidth(right);
  if (right.length === 0 || leftW + rightW + 1 > width) {
    return assemble(left, width, color, lineBase, fill);
  }
  const pad = width - leftW - rightW;
  return assemble([...left, { text: ' '.repeat(pad) }, ...right], width, color, lineBase, fill);
}

/** One table row: `<status rail>  <indent><collapse> <name> <flags>` ........ `<meta>`.
 *  `showCwd` adds the project column (All-dirs view); `now` drives the age. */
function rowLine(
  row: VisibleRow,
  tree: Tree,
  width: number,
  isCursor: boolean,
  query: string,
  caps: ColorCaps,
  showCwd: boolean,
  now: number,
): string {
  const node = tree.nodes.get(row.id);
  if (node === undefined) return '';
  const r = node.row;
  const indent = '  '.repeat(row.depth);
  const collapse = !row.hasChildren ? ' ' : row.collapsed ? '▸' : '▾';
  const terminal = r.status === 'done' || r.status === 'dead' || r.status === 'canceled';

  // Inline attention flags that travel with the name (streaming lives in the rail).
  const flags: Span[] = [];
  if (r.viewed === true) flags.push({ text: ' ◉', style: { fg: FG_CYAN } });          // a viewer is attached
  if (r.asks > 0) flags.push({ text: ` ⚑${r.asks}`, style: { fg: FG_BRIGHT_YELLOW, bold: true } }); // pending asks

  const status = statusRail(r);
  const right = metaCluster(r, now, showCwd);
  const treeLead = `${indent}${collapse} `;

  // Clip the NAME (only) so status + tree + name + flags + meta all fit; the cluster
  // is dropped first (assembleRow) when even a 4-col name won't leave room for it.
  const fixed = spansWidth(status) + [...treeLead].length + spansWidth(flags);
  const rightW = spansWidth(right);
  const nameMax = Math.max(4, width - fixed - rightW - 1);
  const nameStyle = { dim: !isCursor && terminal, bold: isCursor }; // dim terminal names; bold the cursor row

  const left: Span[] = [
    ...status,
    { text: treeLead, style: { dim: true } },
    ...nameSpans(clip(r.name, nameMax), query, nameStyle),
    ...flags,
  ];

  // Row base: cursor → subtle bg (256) or reverse fallback (also !color); non-matched
  // ancestor → whole-row dim for tree context.
  let lineBase = '';
  let fill = false;
  if (isCursor) {
    lineBase = caps.color256 ? CURSOR_BG : REVERSE;
    fill = true;
  } else if (!row.matched) {
    lineBase = DIM;
  }

  return assembleRow(left, right, width, caps.color, lineBase, fill);
}

/** The column-header row — dim labels aligned to the same zones the rows use, so
 *  the metadata columns read as a table. */
function columnHeaderLine(width: number, showCwd: boolean, caps: ColorCaps): string {
  const left: Span[] = [
    { text: 'STATUS'.padEnd(STATUS_W), style: { dim: true, bold: true } },
    { text: 'NAME', style: { dim: true, bold: true } },
  ];
  const right: Span[] = [
    { text: 'KIND/MODE'.padEnd(KM_W), style: { dim: true, bold: true } },
    { text: COL_GAP },
    { text: 'CTX'.padStart(CTX_W), style: { dim: true, bold: true } },
    { text: COL_GAP },
    { text: 'AGE'.padStart(AGE_W), style: { dim: true, bold: true } },
  ];
  if (showCwd) right.push({ text: COL_GAP }, { text: 'PROJECT'.padEnd(PROJ_W), style: { dim: true, bold: true } });
  return assembleRow(left, right, width, caps.color, '', false);
}

/** The status line (always present): active cwd scope · sort mode · committed
 *  filter. The committed-filter indicator lives here now (not its own line) so a
 *  filtered view always advertises its query without consuming a header row. */
function statusLine(state: RenderState): string {
  const dim = (s: string): string => `${DIM}${s}${RESET}`;
  const scope = state.cwdScope === null ? 'all dirs' : baseDir(state.cwdScope);
  const segs = [`${dim('scope')} ${scope}`, `${dim('sort')} ${state.sort}`];
  if (state.residentsOnly) segs.push(`${dim('show')} residents`);
  if (!state.search && state.query !== '') segs.push(`${dim('filter')} ${state.query}`);
  return segs.join(dim('  ·  '));
}

/** One snippet line → a rendered string with the query-matched columns in bold
 *  bright-cyan (mirrors the row name highlight). Unmatched text stays default. */
function snippetLine(ln: SnippetLine, width: number, caps: ColorCaps): string {
  if (ln.hi.size === 0) return assemble([{ text: ln.text }], width, caps.color, '', false);
  const spans: Span[] = [];
  let buf = '';
  let bufHi = false;
  const flush = (): void => {
    if (buf === '') return;
    spans.push(bufHi ? { text: buf, style: { fg: FG_BRIGHT_CYAN, bold: true } } : { text: buf });
    buf = '';
  };
  for (let i = 0; i < ln.text.length; i++) {
    const h = ln.hi.has(i);
    if (h !== bufHi) { flush(); bufHi = h; }
    buf += ln.text[i];
  }
  flush();
  return assemble(spans, width, caps.color, '', false);
}

/** The bottom preview panel — exactly PREVIEW_HEIGHT lines: a separator, a meta
 *  line (status · kind/mode · project · age · ctx · asks · streaming/viewing), then
 *  TWO blocks — the spawn prompt / query-match (PROMPT_LINES) and the node's LAST
 *  assistant reply (REPLY_LINES, prefixed `↩`). Under a live query the prompt block
 *  is WINDOWED to the matching prompt (anywhere in the conversation) with the match
 *  highlighted; with no query it shows the spawn prompt from the start. Seeing both
 *  ends — what it was asked and where it left off — answers "which one was this?".
 *  Always full height so viewport math holds. */
function previewPanel(r: DashboardRow | undefined, width: number, caps: ColorCaps, now: number, query: string): string[] {
  const out: string[] = [`${DIM}${'─'.repeat(width)}${RESET}`];
  if (r === undefined) {
    while (out.length < PREVIEW_HEIGHT) out.push('');
    return out;
  }
  const glyph = caps.color
    ? `${ESC}${STATUS_COLOR[r.status]}m${STATUS_GLYPH[r.status]}${RESET}`
    : (STATUS_GLYPH[r.status] ?? '?');
  const metaPieces = [`${r.status} ${r.kind}/${r.mode}`, baseDir(r.cwd), relAge(r.created, now), `ctx ${fmtCtx(r.ctx_tokens)}`];
  if (r.asks > 0) metaPieces.push(`⚑${r.asks}`);
  if (r.streaming === true) metaPieces.push('⟳ streaming');
  if (r.viewed === true) metaPieces.push('◉ viewing');
  const metaText = clip(metaPieces.filter((p) => p !== '').join('  ·  '), Math.max(0, width - 2));
  out.push(caps.color ? `${glyph} ${DIM}${metaText}${RESET}` : `${glyph} ${metaText}`);

  // Block 1 — spawn prompt / query-match. With a query, window+highlight the
  // matching prompt from the WHOLE conversation; otherwise the spawn prompt.
  const sourceText = query !== '' ? promptText(r) : (r.goal ?? '');
  const promptSnippet = previewSnippet(query, sourceText, width, PROMPT_LINES);
  if (promptSnippet.length === 0) {
    out.push(`${DIM}(no spawn prompt)${RESET}`);
    for (let i = 1; i < PROMPT_LINES; i++) out.push('');
  } else {
    for (let i = 0; i < PROMPT_LINES; i++) {
      const ln = promptSnippet[i];
      out.push(ln === undefined ? '' : snippetLine(ln, width, caps));
    }
  }

  // Block 2 — the node's LAST assistant reply, prefixed `↩` on its first line so
  // the two blocks read apart. Wrapped to width-2 to leave room for the marker.
  const replyMark = caps.color ? `${DIM}↩ ${RESET}` : '↩ ';
  const replySnippet = previewSnippet('', r.lastAssistant ?? '', Math.max(1, width - 2), REPLY_LINES);
  if (replySnippet.length === 0) {
    out.push(`${replyMark}${DIM}(no reply yet)${RESET}`);
    for (let i = 1; i < REPLY_LINES; i++) out.push('');
  } else {
    for (let i = 0; i < REPLY_LINES; i++) {
      const ln = replySnippet[i];
      const prefix = i === 0 ? replyMark : '  ';
      out.push(ln === undefined ? (i === 0 ? `${replyMark}` : '') : `${prefix}${snippetLine(ln, Math.max(1, width - 2), caps)}`);
    }
  }
  return out;
}

/**
 * Render the whole frame. Returns a single string that, written as-is, repaints
 * the screen in place. `caps` gates all hue (defaults to a no-color frame so
 * existing callers / non-TTY paths stay color-free).
 */
export function renderFrame(
  state: RenderState,
  size: { cols: number; rows: number },
  caps: ColorCaps = { color: false, color256: false },
): string {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(8, size.rows);
  const width = cols - 1; // leave the last column for \x1b[K
  const now = Date.now();
  const lines: string[] = [];

  // line 1 — title + right-aligned status summary (each glyph in its status hue).
  const title = `${BOLD}Canvas${RESET} — ${state.totalNodes} nodes`;
  const titlePlainLen = `Canvas — ${state.totalNodes} nodes`.length;
  const parts = statusCounts(state.tree);
  const summaryPlain = parts.map((p) => `${STATUS_GLYPH[p.status]}${p.count}`).join(' ');
  const summaryColored = caps.color
    ? parts.map((p) => `${ESC}${STATUS_COLOR[p.status]}m${STATUS_GLYPH[p.status]}${RESET}${DIM}${p.count}${RESET}`).join(' ')
    : `${DIM}${summaryPlain}${RESET}`;
  const gap = width - titlePlainLen - summaryPlain.length;
  lines.push(gap > 1 ? `${title}${' '.repeat(gap)}${summaryColored}` : title);

  // line 2 — tab bar.
  lines.push(tabBar(state.tab, caps.color));

  // line 3 — status line (scope · sort · filter).
  lines.push(statusLine(state));

  // line 4 — search input, only while actively typing a search.
  if (state.search) {
    const slash = caps.color ? `${ESC}${FG_CYAN}m/${RESET}` : '/';
    lines.push(`${slash} ${state.query}▎`);
  }

  // column header (table labels) + separator.
  const showCwd = state.cwdScope === null; // project column only matters across dirs
  lines.push(columnHeaderLine(width, showCwd, caps));
  lines.push(`${DIM}${'─'.repeat(width)}${RESET}`);

  // body — windowed visible rows, leaving room for the (optional) preview panel.
  const head = lines.length; // === headerHeight(state.search)
  const previewOn = state.preview && state.visible.length > 0;
  const previewH = previewOn ? PREVIEW_HEIGHT : 0;
  const viewport = Math.max(1, rows - head - 1 /* footer */ - previewH);
  const start = state.scrollOffset;
  const end = Math.min(state.visible.length, start + viewport);

  if (state.visible.length === 0) {
    lines.push(`${DIM}  (no nodes match this view)${RESET}`);
    for (let i = 1; i < viewport; i++) lines.push('');
  } else {
    for (let i = start; i < end; i++) {
      lines.push(rowLine(state.visible[i]!, state.tree, width, i === state.cursor, state.query, caps, showCwd, now));
    }
    for (let i = end - start; i < viewport; i++) lines.push('');
  }

  // preview panel — the selected row's prompt + meta.
  if (previewOn) {
    const sel = state.visible[state.cursor];
    const r = sel !== undefined ? state.tree.nodes.get(sel.id)?.row : undefined;
    for (const l of previewPanel(r, width, caps, now, state.query)) lines.push(l);
  }

  // footer — the y/n close-out confirm takes over when pending; else search / nav.
  if (state.pendingClose !== null && state.pendingClose !== undefined) {
    const node = state.tree.nodes.get(state.pendingClose);
    const who = node !== undefined ? node.row.name : state.pendingClose;
    const warn = `⚠ ${who} is actively streaming — close it (and its subtree) anyway?  y / n`;
    lines.push(caps.color ? `${BOLD}${ESC}${FG_BRIGHT_YELLOW}m${clip(warn, width)}${RESET}` : `${REVERSE}${clip(warn, width)}${RESET}`);
  } else {
    const footer = state.search
      ? '⏎ commit  Esc cancel  ⌫ delete'
      : '↑↓ move  →/← tree  ⏎ resume  x close  Tab tabs  / search  s sort  c cwd  r residents  p preview  q quit';
    lines.push(`${DIM}${clip(footer, width)}${RESET}`);
  }

  // Assemble: home, each line cleared to EOL, then clear below.
  const body = lines.map((l) => `${l}${ESC}K`).join('\r\n');
  return `${ESC}H${body}${ESC}J`;
}
