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
//   preview = separator + meta line + PREVIEW_BODY prompt lines
export const PREVIEW_BODY = 5;
export const PREVIEW_HEIGHT = PREVIEW_BODY + 2;
export function headerHeight(search: boolean): number {
  return 4 + (search ? 1 : 0);
}

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

/** One row line: `<indent><collapse> <glyph> <name> [kind/mode] ctx Nk age [~dir] [⚑n]`.
 *  `showCwd` adds the project-name cue (All-dirs view); `now` drives the age. */
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
  const glyph = STATUS_GLYPH[r.status] ?? '?';
  const terminal = r.status === 'done' || r.status === 'dead' || r.status === 'canceled';
  const ctxStr = fmtCtx(r.ctx_tokens);
  const ctxFg = ctxColorCode(r.ctx_tokens);
  const age = relAge(r.created, now);

  // Name: bold on the cursor row; dim for terminal status (live names stay default).
  const nameStyle = { dim: !isCursor && terminal, bold: isCursor };

  const spans: Span[] = [
    { text: `${indent}${collapse} ` },
    { text: glyph, style: { fg: STATUS_COLOR[r.status] } }, // load-bearing status hue
    { text: ' ' },
    ...nameSpans(r.name, query, nameStyle),
    { text: ` [${r.kind}/${r.mode}]`, style: { fg: FG_GRAY } }, // recedes
    { text: ' ctx ', style: { dim: true } },
    { text: ctxStr, style: { fg: ctxFg, dim: ctxFg === undefined } }, // tiered budget cue
  ];
  if (age !== '') spans.push({ text: ` ${age}`, style: { dim: true } }); // recency cue
  if (showCwd) spans.push({ text: ` ~${baseDir(r.cwd)}`, style: { fg: FG_GRAY } }); // project cue (All dirs)
  if (r.asks > 0) spans.push({ text: ` ⚑${r.asks}`, style: { fg: FG_BRIGHT_YELLOW, bold: true } }); // attention

  // Row base: cursor → subtle bg (256) or reverse fallback (also covers !color);
  // non-matched ancestor → whole-row dim for tree context (keep prior behavior).
  let lineBase = '';
  let fill = false;
  if (isCursor) {
    lineBase = caps.color256 ? CURSOR_BG : REVERSE;
    fill = true;
  } else if (!row.matched) {
    lineBase = DIM;
  }

  return assemble(spans, width, caps.color, lineBase, fill);
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
 *  line (status · kind/mode · project · age · ctx · asks), then the selected node's
 *  prompt wrapped to PREVIEW_BODY lines. Under a live query the body is WINDOWED to
 *  the matching prompt (anywhere in the conversation) with the match highlighted;
 *  with no query it shows the spawn prompt from the start. The "which one was this?"
 *  answer — paired with super-search. Always full height so viewport math holds. */
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
  const metaText = clip(metaPieces.filter((p) => p !== '').join('  ·  '), Math.max(0, width - 2));
  out.push(caps.color ? `${glyph} ${DIM}${metaText}${RESET}` : `${glyph} ${metaText}`);
  // With a query, window+highlight the matching prompt from the WHOLE conversation;
  // otherwise show the spawn prompt from the start.
  const sourceText = query !== '' ? promptText(r) : (r.goal ?? '');
  const snippet = previewSnippet(query, sourceText, width, PREVIEW_BODY);
  if (snippet.length === 0) {
    out.push(`${DIM}(no spawn prompt)${RESET}`);
    for (let i = 1; i < PREVIEW_BODY; i++) out.push('');
  } else {
    for (let i = 0; i < PREVIEW_BODY; i++) {
      const ln = snippet[i];
      out.push(ln === undefined ? '' : snippetLine(ln, width, caps));
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

  // separator.
  lines.push(`${DIM}${'─'.repeat(width)}${RESET}`);

  // body — windowed visible rows, leaving room for the (optional) preview panel.
  const head = lines.length; // === headerHeight(state.search)
  const showCwd = state.cwdScope === null; // project cue only matters across dirs
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

  // footer.
  const footer = state.search
    ? '⏎ commit  Esc cancel  ⌫ delete'
    : '↑↓ move  →/← tree  ⏎ resume  Tab tabs  / search  s sort  c cwd  r residents  p preview  q quit';
  lines.push(`${DIM}${clip(footer, width)}${RESET}`);

  // Assemble: home, each line cleared to EOL, then clear below.
  const body = lines.map((l) => `${l}${ESC}K`).join('\r\n');
  return `${ESC}H${body}${ESC}J`;
}
