// @ts-check
/**
 * Canvas Dashboard — the TUI presenter (`render` + `keymap`) for the `canvas`
 * view. Node-only (it uses the host's `Draw` API + the `_lib/states.mjs` draw
 * helpers).
 *
 * `render` is a pure read of state; keystrokes map to named intents through
 * `keymap`. All state + data logic lives in `core.mjs`.
 *
 * VISUAL LANGUAGE (crtr-views-visual-design §2/§3/§4): hierarchy is carried by
 * weight + hue + position, never boxes. The status glyph hues match `canvas
 * browse`'s authoritative palette (active=green, idle=yellow, done=cyan,
 * dead=red, canceled=grey; asks=bright-yellow) — "not a recolor." Per-row
 * metadata (the relative age) is right-flushed via `ListItemRow.right`; secondary
 * text recedes via grey+dim so it survives NO_COLOR. The four standard states
 * come from `_lib/states.mjs`.
 *
 * @module canvas/tui
 */

import { relAge } from './core.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./core.mjs').CanvasState} CanvasState */
/** @typedef {import('./core.mjs').TreeRow} TreeRow */

/**
 * Load-bearing status hue — NUMERIC SGR codes, matching `canvas browse`'s
 * STATUS_COLOR exactly (active=green, idle=yellow, done=cyan, dead=red,
 * canceled=grey). The design is explicit: keep these, "this is not a recolor."
 * @type {Record<string,string>}
 */
const STATUS_FG = {
  active: '32', // green
  idle: '33', // yellow
  done: '36', // cyan
  dead: '31', // red
  canceled: '90', // grey
};

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
function glyphStyle(status) {
  const fg = STATUS_FG[status];
  return fg ? { fg } : undefined; // hue only — the glyph SHAPE is the mono carrier
}

/**
 * Name weight = hierarchy (design §2 "weight creates hierarchy"): live work
 * (active) LEADS in bold; terminal nodes (done/dead/canceled) recede dim; idle
 * stays default weight (readable, not shouting). Mono-safe (weight, not hue).
 * @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined}
 */
function nameStyle(status) {
  if (status === 'active') return { bold: true };
  if (status === 'done' || status === 'dead' || status === 'canceled') return { dim: true };
  return undefined;
}

// ── Row → ListItemRow (left spans + right-flushed age) ─────────────────────────

/**
 * Build one list row: a 1-cell left gutter (§2), the tree prefix (dim), the
 * status glyph (hue), the name (weight = status), the dim `[kind/mode]` cue, and
 * a bright-yellow `⚑N` attention flag when blocked — with the relative age
 * RIGHT-FLUSHED into a clean scannable column via `ListItemRow.right`.
 * @param {TreeRow} r @param {number} now
 * @returns {import('../../core/tui/draw.js').ListItemRow}
 */
function rowToItem(r, now) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [{ text: ' ', style: undefined }]; // 1-cell gutter (rides the cursor bg)
  if (r.prefix) spans.push({ text: r.prefix, style: { dim: true } });
  spans.push({ text: r.glyph, style: glyphStyle(r.status) });
  spans.push({ text: ' ', style: undefined });
  spans.push({ text: r.name, style: nameStyle(r.status) });
  spans.push({ text: ` [${r.kind}/${r.mode}]`, style: { fg: '90', dim: true } }); // muted: grey + dim (mono-safe)
  if (r.blocked) spans.push({ text: ` ⚑${r.askCount}`, style: { fg: '93', bold: true } }); // attention

  const age = relAge(r.created, now);
  if (age) {
    return { spans, right: [{ text: age, style: { fg: '90', dim: true } }] };
  }
  return { spans };
}

// ── render ─────────────────────────────────────────────────────────────────────

/**
 * Paint the forest, or one of the four standard states. Pure (reads state,
 * calls draw.*); the only state write is storing draw.list's adjusted scroll
 * back, per the Draw contract.
 * @param {CanvasState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;

  if (state.rows.length === 0) {
    // Hard not-ready: the data source is down and there is nothing to keep — a
    // guided takeover owns the whole content rect (design §4/§5). The copy comes
    // from the typed SourceError's `display` VERBATIM (the contract display/kind
    // split — we never branch on `kind`); only the glyph + hue are a presentation
    // map off `display.level` (error → ⚠ red, action → ⊙ yellow).
    if (state.sourceError) {
      const d = state.sourceError.display;
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
    // First load in flight — a skeleton, not a blank screen.
    if (state.lastFetch === 0) {
      loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading the canvas…' });
      return;
    }
    // Loaded, nothing to render — the reward state, two flavors.
    if (state.totalNodes === 0) {
      emptyState(draw, content, {
        headline: 'No nodes on the canvas',
        secondary: ['Spawn one with `crtr node new`.', 'Press g to refresh.'],
      });
    } else {
      emptyState(draw, content, {
        headline: 'All caught up',
        secondary: [`${state.totalNodes} node${state.totalNodes === 1 ? '' : 's'} finished — none active.`, 'Press g to refresh.'],
      });
    }
    return;
  }

  // The forest. A 1-row section gap below the header (§2 rhythm) when there is
  // room; full-width list so the cursor highlight + age column reach the edges.
  const now = Date.now();
  const gap = content.height > 4 ? 1 : 0;
  const listRect = {
    row: content.row + gap,
    col: content.col,
    width: content.width,
    height: content.height - gap,
  };
  const items = state.rows.map((r) => rowToItem(r, now));
  const res = draw.list(listRect, items, state.cursor, state.scroll);
  state.scroll = res.scroll; // store adjusted scroll back (Draw.list contract)
}

// ── keymap ───────────────────────────────────────────────────────────────

/**
 * Read-only navigation: j/k move the cursor, g refreshes, q quits. No async
 * actions from input — this is a monitor, not a controller. Footer hints come
 * from these bindings' `hint` fields (the single source of truth).
 * @type {import('../../core/view/contract.js').KeyBinding<CanvasState>[]}
 */
export const keymap = [
  { keys: ['j', 'down'], intent: 'cursorDown', hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp' },
  { keys: ['g'], intent: 'refresh', hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
];
