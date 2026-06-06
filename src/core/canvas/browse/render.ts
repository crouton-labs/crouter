// render.ts — pure frame rendering for the canvas browser.
//
// renderFrame(state, size) → a full-screen string. The app writes it verbatim on
// every keystroke. Redraw is flicker-free: home the cursor (\x1b[H), clear each
// line to EOL (\x1b[K), and clear below the last line (\x1b[J) so a shrunk frame
// leaves no stale rows. A full frame per keypress is fine for a picker.

import type { NodeStatus } from '../types.js';
import type { Tab, Tree, VisibleRow } from './model.js';
import { TABS } from './model.js';

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const REVERSE = `${ESC}7m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;

const STATUS_GLYPH: Record<NodeStatus, string> = {
  active:   '●',
  idle:     '○',
  done:     '✓',
  dead:     '✗',
  canceled: '⊘',
};

export interface RenderState {
  tree: Tree;
  visible: VisibleRow[];
  tab: Tab;
  cursor: number;      // index into `visible`
  scrollOffset: number;
  query: string;
  search: boolean;
  totalNodes: number;
}

function fmtCtx(tokens: number): string {
  if (tokens <= 0) return '0k';
  return `${Math.floor(tokens / 1000)}k`;
}

/** Truncate to `max` visible cols (plain text, no ANSI). */
function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Status tallies across the whole canvas, for the right-aligned header. Memoized
 *  per tree — the snapshot is immutable for a browse session, so this is computed
 *  once, not O(N) on every keystroke (the "massive canvas" target). */
const summaryCache = new WeakMap<Tree, string>();
function statusSummary(tree: Tree): string {
  const cached = summaryCache.get(tree);
  if (cached !== undefined) return cached;
  const counts: Record<NodeStatus, number> = { active: 0, idle: 0, done: 0, dead: 0, canceled: 0 };
  for (const node of tree.nodes.values()) counts[node.row.status]++;
  const parts: string[] = [];
  for (const s of ['active', 'idle', 'done', 'dead', 'canceled'] as NodeStatus[]) {
    if (counts[s] > 0) parts.push(`${STATUS_GLYPH[s]}${counts[s]}`);
  }
  const result = parts.join(' ');
  summaryCache.set(tree, result);
  return result;
}

function tabBar(active: Tab): string {
  return TABS.map((t) => (t === active ? `${REVERSE}[ ${t} ]${RESET}` : `  ${t}  `)).join('');
}

/** One row line: `<indent><collapse> <glyph> <name> [kind/mode] ctx Nk [⚑n]`. */
function rowLine(row: VisibleRow, tree: Tree, width: number, isCursor: boolean): string {
  const node = tree.nodes.get(row.id);
  if (node === undefined) return '';
  const r = node.row;
  const indent = '  '.repeat(row.depth);
  const collapse = !row.hasChildren ? ' ' : row.collapsed ? '▸' : '▾';
  const glyph = STATUS_GLYPH[r.status] ?? '?';
  const ask = r.asks > 0 ? ` ⚑${r.asks}` : '';
  const text = `${indent}${collapse} ${glyph} ${r.name} [${r.kind}/${r.mode}] ctx ${fmtCtx(r.ctx_tokens)}${ask}`;
  const clipped = clip(text, width);
  if (isCursor) return `${REVERSE}${padTo(clipped, width)}${RESET}`;
  if (!row.matched) return `${DIM}${clipped}${RESET}`; // ancestor context, dimmed
  return clipped;
}

/**
 * Render the whole frame. Returns a single string that, written as-is, repaints
 * the screen in place.
 */
export function renderFrame(state: RenderState, size: { cols: number; rows: number }): string {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(8, size.rows);
  const width = cols - 1; // leave the last column for \x1b[K
  const lines: string[] = [];

  // line 1 — title + right-aligned status summary.
  const title = `${BOLD}Canvas${RESET} — ${state.totalNodes} nodes`;
  const titlePlainLen = `Canvas — ${state.totalNodes} nodes`.length;
  const summary = statusSummary(state.tree);
  const gap = width - titlePlainLen - summary.length;
  lines.push(gap > 1 ? `${title}${' '.repeat(gap)}${DIM}${summary}${RESET}` : title);

  // line 2 — tab bar.
  lines.push(tabBar(state.tab));

  // line 3 — search input (in search mode), or a persistent indicator for a
  // committed filter so an active query is never invisible after you Enter out.
  if (state.search) {
    lines.push(`${ESC}36m/${RESET} ${state.query}▎`);
  } else if (state.query !== '') {
    lines.push(`${DIM}filter:${RESET} ${state.query}  ${DIM}(/ to search again)${RESET}`);
  }

  // separator.
  lines.push(`${DIM}${'─'.repeat(width)}${RESET}`);

  // body — windowed visible rows.
  const headerLines = lines.length;
  const footerLines = 1;
  const viewport = Math.max(1, rows - headerLines - footerLines);
  const start = state.scrollOffset;
  const end = Math.min(state.visible.length, start + viewport);

  if (state.visible.length === 0) {
    lines.push(`${DIM}  (no nodes match this view)${RESET}`);
    for (let i = 1; i < viewport; i++) lines.push('');
  } else {
    for (let i = start; i < end; i++) {
      lines.push(rowLine(state.visible[i]!, state.tree, width, i === state.cursor));
    }
    for (let i = end - start; i < viewport; i++) lines.push('');
  }

  // footer.
  const footer = state.search
    ? '⏎ commit  Esc cancel  ⌫ delete'
    : '↑↓ move  →/← expand/collapse  ⏎ resume  Tab tabs  / search  q quit';
  lines.push(`${DIM}${clip(footer, width)}${RESET}`);

  // Assemble: home, each line cleared to EOL, then clear below.
  const body = lines.map((l) => `${l}${ESC}K`).join('\r\n');
  return `${ESC}H${body}${ESC}J`;
}
