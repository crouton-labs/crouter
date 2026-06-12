// @ts-check
/**
 * Workspace Sidebar — the TUI presenter (`render` + `keymap`) for the
 * `workspace-sidebar` view. Node-only (it uses the host's `Draw` API + the
 * `_lib/states.mjs` draw helpers).
 *
 * `render` paints a two-section rail; keystrokes map to named intents through
 * `keymap`. All state + data logic lives in `core.mjs`; this file is a pure
 * read of the logical `RailRow[]`.
 *
 * VISUAL LANGUAGE (mirrors the `canvas` view): hierarchy via weight + hue +
 * position, never boxes. Status glyph hues match `canvas browse` (active=green,
 * idle=yellow, done=cyan, dead=red, canceled=grey; asks=bright-yellow). Color
 * never carries meaning alone — every hue pairs with a glyph/weight (NO_COLOR-
 * safe). The attached node carries a `▸` accent + bold name. ⚑N attention flags
 * right-flush into a clean column.
 *
 * @module workspace-sidebar/tui
 */

import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./core.mjs').SidebarState} SidebarState */
/** @typedef {import('./core.mjs').RailRow} RailRow */

// ── Status vocabulary (single source: core/canvas/browse/render.ts) ───────────

/** @type {Record<string,string>} */
const STATUS_GLYPH = { active: '●', idle: '○', done: '✓', dead: '✗', canceled: '⊘' };

/** Load-bearing status hue — NUMERIC SGR, matching `canvas browse` exactly. */
/** @type {Record<string,string>} */
const STATUS_FG = { active: '32', idle: '33', done: '36', dead: '31', canceled: '90' };

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
function glyphStyle(status) {
  const fg = STATUS_FG[status];
  return fg ? { fg } : undefined; // hue only — the glyph SHAPE is the mono carrier
}

/** Name weight = hierarchy: live work LEADS in bold; terminal nodes recede dim.
 * @param {string} status @param {boolean} attached
 * @returns {import('../../core/tui/draw.js').Style|undefined} */
function nameStyle(status, attached) {
  if (attached) return { fg: '36', bold: true }; // the attached node — cyan accent
  if (status === 'active') return { bold: true };
  if (status === 'done' || status === 'dead' || status === 'canceled') return { dim: true };
  return undefined;
}

// ── RailRow → ListItemRow (left spans + right-flushed ⚑N) ──────────────────────

/**
 * Build one rail list row. A node row: 1-cell gutter (`▸` accent on the attached
 * node, else blank), optional dim tree prefix, the status glyph (hue), the name
 * (weight = status / accent when attached), and a right-flushed bright-yellow ⚑N
 * when the node has pending asks.
 * @param {RailRow} row
 * @returns {import('../../core/tui/draw.js').ListItemRow}
 */
function rowToItem(row) {
  if (row.kind === 'header') {
    return { spans: [{ text: row.text, style: { fg: '36', bold: true } }] };
  }
  if (row.kind === 'chrome') {
    return { spans: [{ text: row.text, style: { dim: true } }] };
  }
  // row.kind === 'node'
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [
    row.attached ? { text: '▸', style: { fg: '36', bold: true } } : { text: ' ' },
    { text: ' ' },
  ];
  if (row.prefix) spans.push({ text: row.prefix, style: { dim: true } });
  spans.push({ text: STATUS_GLYPH[row.status] || '?', style: glyphStyle(row.status) });
  spans.push({ text: ' ' });
  spans.push({ text: row.name, style: nameStyle(row.status, row.attached) });
  if (row.asks > 0) {
    return { spans, right: [{ text: `⚑${row.asks}`, style: { fg: '93', bold: true } }] };
  }
  return { spans };
}

// ── render ─────────────────────────────────────────────────────────────────────

/**
 * Paint the rail, or one of the four standard states. Pure (reads state, calls
 * draw.*); the only write is storing draw.list's adjusted scroll.
 * @param {SidebarState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;

  if (state.rows.length === 0) {
    // The copy comes from the typed SourceError's `display` VERBATIM (the
    // contract display/kind split — we never branch on `kind`); only the glyph +
    // hue are a presentation map off `display.level`.
    if (state.srcError) {
      const d = state.srcError.display;
      const g = d.level === 'action' ? { glyph: '⊙', fg: '33' } : { glyph: '⚠', fg: '31' };
      notReadyState(draw, content, {
        glyph: g.glyph,
        glyphFg: g.fg,
        headline: d.headline,
        explanation: d.explanation,
        nextStep: d.nextStep,
      });
      return;
    }
    if (state.lastFetch === 0) {
      loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading…' });
      return;
    }
    emptyState(draw, content, {
      headline: 'No agents here',
      secondary: ['Nothing started in this cwd.', 'Press g to refresh.'],
    });
    return;
  }

  const items = state.rows.map((r) => rowToItem(r));
  const res = draw.list(content, items, state.cursor, state.scroll);
  state.scroll = res.scroll; // store adjusted scroll back (Draw.list contract)
}

// ── keymap ───────────────────────────────────────────────────────────────

/**
 * j/k move the cursor over node rows, ↵ swaps the selected node into the chat
 * pane (the controller action), g refreshes, q quits. Footer hints come from
 * these bindings' `hint` fields (the single source of truth).
 * @type {import('../../core/view/contract.js').KeyBinding<SidebarState>[]}
 */
export const keymap = [
  { keys: ['j', 'down'], intent: 'cursorDown', hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp' },
  { keys: ['return', 'enter'], intent: 'open', hint: { keys: '↵', label: 'open' } },
  { keys: ['g', 'r'], intent: 'refresh', hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
];
