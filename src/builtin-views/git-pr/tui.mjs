// @ts-check
/**
 * Git / PR board — the TUI presenter (`render` + `keymap`) for the `git-pr` view.
 * Node-only (it uses the host's `Draw` API + the `_lib/states.mjs` draw helpers).
 *
 * `render` is a pure read of state; keystrokes map to named intents through
 * `keymap`. All state + data logic lives in `core.mjs`.
 *
 * VISUAL LANGUAGE (crtr-views-visual-design §2/§3/§4): hierarchy by weight + hue
 * + position, never boxes. Hues are NUMERIC SGR only — green=clean/passing/
 * staged/ahead (32), yellow=attention/pending/modified/behind (33), red=failing/
 * conflicted (31), cyan=identity/branch/PR# (36), grey=metadata (90). Every hue
 * is paired with a glyph + the git-native XY code so it survives NO_COLOR.
 *
 * @module git-pr/tui
 */

import { relAge } from './core.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./core.mjs').GitState} GitState */
/** @typedef {import('./core.mjs').ChangedFile} ChangedFile */
/** @typedef {import('./core.mjs').Pr} Pr */
/** @typedef {import('./core.mjs').BoardRow} BoardRow */
/** @typedef {import('./core.mjs').GitPrState} GitPrState */

// ── Status vocabulary (triple-coded: hue + glyph + the git-native XY code) ─────

/** @type {Record<string,{glyph:string, fg:string}>} */
const FILE_GLYPH = {
  staged: { glyph: '●', fg: '32' }, // green — in the index, ready
  modified: { glyph: '○', fg: '33' }, // yellow — unstaged worktree edit
  untracked: { glyph: '?', fg: '90' }, // grey — not tracked
  conflict: { glyph: '✗', fg: '31' }, // red — merge conflict
};

/** PR review decision → glyph + hue. Pending review is neutral (grey), not red. */
const REVIEW = {
  approved: { glyph: '✓', fg: '32' }, // green
  changes: { glyph: '✗', fg: '31' }, // red — changes requested (attention)
  review: { glyph: '◌', fg: '90' }, // grey — review required / pending
};

/** PR CI rollup → glyph + hue. */
const CI = {
  pass: { glyph: '✓', fg: '32' }, // green
  fail: { glyph: '✗', fg: '31' }, // red
  pending: { glyph: '⟳', fg: '33' }, // yellow
  none: { glyph: '·', fg: '90' }, // grey — no checks
};

// ── Row → ListItemRow (left spans + right-flushed metadata) ────────────────────

/**
 * Build one board list row. A 1-cell left gutter rides the cursor bg (§2).
 * @param {BoardRow} row @param {number} now
 * @returns {import('../../core/tui/draw.js').ListItemRow}
 */
function rowToItem(row, now) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [{ text: ' ', style: undefined }];

  if (row.kind === 'label') {
    spans.push({ text: row.text, style: { fg: '90', dim: true } });
    return { spans };
  }
  if (row.kind === 'spacer') {
    return { spans: [{ text: '', style: undefined }] };
  }
  if (row.kind === 'clean') {
    spans.push({ text: '✓', style: { fg: '32' } });
    spans.push({ text: '  nothing to commit, working tree clean', style: { dim: true } });
    return { spans };
  }
  if (row.kind === 'note') {
    spans.push({ text: '·', style: { fg: '90', dim: true } });
    spans.push({ text: '  ' + row.text, style: { dim: true } });
    return { spans };
  }
  if (row.kind === 'file') {
    const f = row.file;
    const g = FILE_GLYPH[f.cls] || FILE_GLYPH.modified;
    spans.push({ text: g.glyph, style: { fg: g.fg } }); // hue + shape (mono carrier)
    spans.push({ text: ' ', style: undefined });
    spans.push({ text: f.xy.replace(/ /g, '·'), style: { fg: '90', dim: true } }); // git-native XY code
    spans.push({ text: ' ', style: undefined });
    spans.push({ text: f.path, style: f.cls === 'conflict' ? { fg: '31' } : undefined });
    if (f.add || f.del) {
      /** @type {import('../../core/tui/draw.js').Span[]} */
      const right = [
        { text: `+${f.add}`, style: { fg: '90', dim: true } },
        { text: ' ', style: undefined },
        { text: `−${f.del}`, style: { fg: '90', dim: true } },
      ];
      return { spans, right };
    }
    return { spans };
  }
  // row.kind === 'pr'
  const pr = row.pr;
  const rv = REVIEW[pr.review] || REVIEW.review;
  const ci = CI[pr.ci] || CI.none;
  spans.push({ text: `#${pr.number}`, style: { fg: '36', bold: pr.current } }); // cyan identity; current branch bold
  spans.push({ text: ' ', style: undefined });
  spans.push({ text: pr.title, style: pr.isDraft ? { dim: true } : undefined });
  if (pr.isDraft) spans.push({ text: ' (draft)', style: { fg: '90', dim: true } });

  const age = relAge(pr.updatedAt, now);
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const right = [
    { text: rv.glyph, style: { fg: rv.fg } }, // review (color + glyph)
    { text: ' ', style: undefined },
    { text: ci.glyph, style: { fg: ci.fg } }, // CI rollup (color + glyph)
  ];
  if (age) {
    right.push({ text: '  ', style: undefined });
    right.push({ text: age, style: { fg: '90', dim: true } });
  }
  return { spans, right };
}

// ── Header zone (drawn manually above the board list) ──────────────────────────

/**
 * Visible (column) width of a span group — ANSI-free cell count. Mirrors
 * draw.ts's internal `spanWidth` so the header can reserve room for a
 * right-flushed group before clipping the left line.
 * @param {import('../../core/tui/draw.js').Span[]} spans @returns {number}
 */
function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/**
 * Paint the always-on header gauges into the top of `content`: branch line then
 * commit line, with right-flushed metadata. Returns the number of rows consumed
 * (incl. the trailing hairline) so render can place the board below it.
 * @param {GitState} g
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 * @param {number} now
 * @returns {number} rows consumed
 */
function drawHeader(g, draw, content, now) {
  const right = content.col + content.width; // exclusive right edge for spansRight
  let r = content.row;

  // ── Branch line: ⎇ branch → upstream  ↑N ↓M   ·····  [tree chip right-flush]
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const left = [
    { text: ' ', style: undefined },
    { text: '⎇ ', style: { fg: '36' } },
    { text: g.branch, style: { fg: '36', bold: true } }, // cyan identity
  ];
  if (g.upstream) {
    left.push({ text: ` → ${g.upstream}`, style: { fg: '90', dim: true } });
    if (g.ahead) left.push({ text: ` ↑${g.ahead}`, style: { fg: '32' } }); // green ahead-ok
    if (g.behind) left.push({ text: ` ↓${g.behind}`, style: { fg: '33' } }); // yellow attention
    if (!g.ahead && !g.behind) left.push({ text: ' ✓ up to date', style: { fg: '32' } });
  } else {
    left.push({ text: ' · no upstream', style: { fg: '90', dim: true } });
  }
  // Tree chip, right-flushed on the same row (clean = green ✓, else colored counts).
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const chip = [];
  if (g.files.length === 0) {
    chip.push({ text: '✓ clean', style: { fg: '32' } });
  } else {
    const c = g.counts;
    /** @param {number} n @param {string} word @param {string} glyph @param {string} fg */
    const seg = (n, word, glyph, fg) => {
      if (!n) return;
      if (chip.length) chip.push({ text: '  ', style: undefined });
      chip.push({ text: `${glyph} ${n} ${word}`, style: { fg } });
    };
    seg(c.conflict, 'conflict', '✗', '31');
    seg(c.staged, 'staged', '●', '32');
    seg(c.modified, 'modified', '○', '33');
    seg(c.untracked, 'untracked', '?', '90');
  }
  // Clip the left line so the right-flushed chip never overpaints its tail
  // (mirror draw.list's leftLimit = width − rightWidth − 1).
  const chipW = spanWidth(chip);
  draw.spans(r, content.col, left, chipW ? Math.max(0, content.width - chipW - 1) : content.width);
  draw.spansRight(r, right, chip);
  r++;

  // ── Commit line: ⊙ sha subject ............................ age (right-flush)
  if (g.lastCommit) {
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const commit = [
      { text: ' ', style: undefined },
      { text: '⊙ ', style: { fg: '90', dim: true } },
      { text: g.lastCommit.sha, style: { fg: '33' } }, // yellow sha (git-native)
      { text: '  ', style: undefined },
      { text: g.lastCommit.subject, style: undefined },
    ];
    // Build the right-flushed age first, then clip the subject so the age never
    // overpaints it (mirror draw.list's leftLimit).
    const age = relAge(g.lastCommit.when, now);
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const ageSpans = age ? [{ text: age, style: { fg: '90', dim: true } }] : [];
    const ageW = spanWidth(ageSpans);
    draw.spans(r, content.col, commit, ageW ? Math.max(0, content.width - ageW - 1) : content.width);
    if (age) draw.spansRight(r, right, ageSpans);
  } else {
    draw.spans(r, content.col, [
      { text: ' ', style: undefined },
      { text: '⊙ ', style: { fg: '90', dim: true } },
      { text: 'no commits yet', style: { dim: true } },
    ]);
  }
  r++;

  // Hairline separating the gauges from the board (figure-ground, §3).
  draw.hline(r, content.col, content.col + content.width);
  r++;

  return r - content.row;
}

// ── render ─────────────────────────────────────────────────────────────────────

/**
 * Paint the header + board, or one of the four standard states. Pure (reads
 * state, calls draw.*); the only write is storing draw.list's adjusted scroll.
 * @param {GitPrState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;

  // ── Whole-screen takeovers (no git data to anchor a header) ──
  // The copy comes from the typed SourceError's `display` VERBATIM (the contract
  // display/kind split — we never branch on `kind`); only the glyph + hue are a
  // presentation map off `display.level` (action → ⊙ yellow, error → ⚠ red).
  if (!state.git) {
    if (state.gitErr) {
      const d = state.gitErr.display;
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
    // No error yet → first-load loading skeleton.
    loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Reading git…' });
    return;
  }

  const now = Date.now();
  const g = state.git;

  // ── Header gauges (always on when we have git data) ──
  // Need ≥3 rows for the 2-row header + hairline; below that, skip straight to
  // the board so a tiny pane still shows the changes.
  let bodyRow = content.row;
  let bodyHeight = content.height;
  if (content.height >= 4) {
    const used = drawHeader(g, draw, content, now);
    bodyRow = content.row + used + (content.height - used > 2 ? 1 : 0); // 1-row section gap when there's room
    bodyHeight = content.row + content.height - bodyRow;
  }
  if (bodyHeight <= 0) return;
  const bodyRect = { row: bodyRow, col: content.col, width: content.width, height: bodyHeight };

  // ── Empty reward: clean tree + no open PRs + gh healthy → "All clear" ──
  if (g.files.length === 0 && state.prs.length === 0 && !state.prNote) {
    emptyState(draw, bodyRect, {
      headline: 'All clear',
      secondary: [`${g.branch} — clean working tree, no open PRs.`, 'Press g to refresh.'],
    });
    return;
  }

  // ── The board ──
  const items = state.board.map((row) => rowToItem(row, now));
  const res = draw.list(bodyRect, items, state.cursor, state.scroll);
  state.scroll = res.scroll; // store adjusted scroll back (Draw.list contract)
}

// ── keymap ───────────────────────────────────────────────────────────────

/**
 * Read-only navigation: j/k move the cursor, g refreshes, q quits. No async
 * actions from input — this is a monitor, not a controller. Footer hints come
 * from these bindings' `hint` fields (the single source of truth).
 * @type {import('../../core/view/contract.js').KeyBinding<GitPrState>[]}
 */
export const keymap = [
  { keys: ['j', 'down'], intent: 'cursorDown', hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp' },
  { keys: ['g'], intent: 'refresh', hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
];
