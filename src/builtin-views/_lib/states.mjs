// @ts-check
/**
 * Standard view states — the four states every crtr view must *design* rather
 * than leave bare (design §4): loading-skeleton, empty-reward, error-keeps-its-
 * shape, and the guided not-ready takeover.
 *
 * Copy-pasteable BODY HELPERS: this is a sibling lib the builtin views import
 * RELATIVELY (`import { loadingState } from '../_lib/states.mjs'`). It imports
 * NOTHING from crtr — the view passes in the `draw` + content `rect` the host
 * already handed it, and these paint the state into `draw`.
 *
 * Discipline (design §2): all color is NUMERIC SGR codes ('32' green, '31' red,
 * '36' cyan, '33' yellow); color NEVER carries meaning alone — every colored
 * element pairs its hue with a glyph or weight so it survives NO_COLOR / dumb
 * terminals. Hue is the framework's job to gate (draw.ts gates fg/bg on caps);
 * structural weight (bold/dim) always renders.
 *
 * @module _lib/states
 */

/** @typedef {import('../../core/tui/draw.js').Draw} Draw */
/** @typedef {import('../../core/tui/draw.js').Rect} Rect */
/** @typedef {import('../../core/tui/draw.js').Span} Span */
/** @typedef {import('../../core/tui/draw.js').Style} Style */

// ── internal ──────────────────────────────────────────────────────────────────

/** @param {Span[]} spans @returns {number} */
function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/** @param {string|string[]|undefined|null} v @returns {string[]} */
function toLines(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s));
  return [String(v)];
}

/**
 * Place a vertically + horizontally centered stack of span-lines in `rect`.
 * Each entry is one line's spans; rows that fall outside the rect are skipped.
 * @param {Draw} draw @param {Rect} rect @param {Span[][]} lines
 */
function centeredStack(draw, rect, lines) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || lines.length === 0) return;
  const start = rect.row + Math.max(0, Math.floor((rect.height - lines.length) / 2));
  lines.forEach((spans, i) => {
    const row = start + i;
    if (row < rect.row || row >= rect.row + rect.height) return;
    const w = spanWidth(spans);
    const col = rect.col + Math.max(0, Math.floor((rect.width - w) / 2));
    draw.spans(row, col, spans, rect.col + rect.width - col);
  });
}

// ── states ─────────────────────────────────────────────────────────────────────

/**
 * Loading — paint a SKELETON of where content will land (dim `····` placeholder
 * rows), not a lone centered "Loading…". The layout is legible before data
 * arrives. Pair with the host's `⟳ working` chip + a `setStatus('Loading…')`.
 *
 * @param {Draw} draw
 * @param {Rect} rect
 * @param {{ rows?: number, label?: string }} [opts]
 *   rows  — how many skeleton rows (default 4); label — optional dim caption below.
 */
export function loadingState(draw, rect, opts = {}) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const n = Math.max(1, Math.min(opts.rows ?? 4, rect.height));
  const snippetLens = [10, 8, 12, 7, 11];
  for (let i = 0; i < n; i++) {
    const row = rect.row + i;
    const label = '·'.repeat(4);
    const snipLen = Math.min(snippetLens[i % snippetLens.length], Math.max(0, rect.width - 8));
    /** @type {Span[]} */
    const spans = [{ text: label, style: { dim: true } }];
    if (snipLen > 0) spans.push({ text: '  ' + '·'.repeat(snipLen), style: { dim: true } });
    draw.spans(row, rect.col + 1, spans, rect.width - 1);
  }
  if (opts.label) {
    const below = { row: rect.row + n + 1, col: rect.col, width: rect.width, height: Math.max(0, rect.height - n - 1) };
    centeredStack(draw, below, [[{ text: opts.label, style: { dim: true } }]]);
  }
}

/**
 * Empty — the reward state. A small centered stack: a green `✓`, a default-weight
 * headline, then dim secondary lines. Inbox-zero is a reward, not a void.
 *
 * @param {Draw} draw
 * @param {Rect} rect
 * @param {{ glyph?: string, headline?: string, secondary?: string|string[] }} [opts]
 */
export function emptyState(draw, rect, opts = {}) {
  const glyph = opts.glyph ?? '✓';
  const headline = opts.headline ?? 'All caught up';
  /** @type {Span[][]} */
  const lines = [
    [{ text: glyph + '  ', style: { fg: '32' } }, { text: headline }], // green glyph + default headline
    [{ text: '' }],
  ];
  for (const t of toLines(opts.secondary)) lines.push([{ text: t, style: { dim: true } }]);
  centeredStack(draw, rect, lines);
}

/**
 * Error — a centered error block, used ONLY when there is no last-known content
 * to keep (on a refresh error with a still-good view, raise a banner instead).
 * `✗` + headline in red/bold, the cause in default weight, a dim retry hint.
 *
 * @param {Draw} draw
 * @param {Rect} rect
 * @param {{ headline?: string, cause?: string|string[], hint?: string }} [opts]
 */
export function errorState(draw, rect, opts = {}) {
  const headline = opts.headline ?? 'Something went wrong';
  const cause = toLines(opts.cause);
  const hint = opts.hint ?? 'Press g to retry.';
  /** @type {Span[][]} */
  const lines = [
    [{ text: '✗  ', style: { fg: '31', bold: true } }, { text: headline, style: { fg: '31', bold: true } }],
    [{ text: '' }],
  ];
  for (const t of cause) lines.push([{ text: t }]);
  if (cause.length) lines.push([{ text: '' }]);
  if (hint) lines.push([{ text: hint, style: { dim: true } }]);
  centeredStack(draw, rect, lines);
}

/**
 * Not-ready / guided takeover — the full-content recovery substrate (design §5).
 * A centered stack: a state glyph (its hue passed by the caller, mono-safe via
 * the glyph itself), a bold headline naming the state, a dim explanation, and the
 * explicit next step (an auto-progress note the view writes, or a key to press).
 *
 * @param {Draw} draw
 * @param {Rect} rect
 * @param {{ glyph?: string, glyphFg?: string, headline?: string, explanation?: string|string[], nextStep?: string }} [opts]
 *   glyphFg — NUMERIC SGR code for the glyph hue (e.g. '36' cyan working, '31' red blocked).
 */
export function notReadyState(draw, rect, opts = {}) {
  const glyph = opts.glyph ?? '⊙';
  /** @type {Style} */
  const glyphStyle = opts.glyphFg ? { fg: opts.glyphFg, bold: true } : { bold: true };
  const headline = opts.headline ?? 'Not ready';
  /** @type {Span[][]} */
  const lines = [
    [{ text: glyph + '  ', style: glyphStyle }, { text: headline, style: { bold: true } }],
    [{ text: '' }],
  ];
  for (const t of toLines(opts.explanation)) lines.push([{ text: t, style: { dim: true } }]);
  if (opts.nextStep) {
    lines.push([{ text: '' }]);
    lines.push([{ text: opts.nextStep }]); // default weight — the call to action
  }
  centeredStack(draw, rect, lines);
}
