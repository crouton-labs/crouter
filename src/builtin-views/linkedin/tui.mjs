// @ts-check
/**
 * LinkedIn Messages — the TUI presenter (`render` + `keymap`) for the `linkedin`
 * view. Node-only (it uses the host's `Draw` API + the `_lib/states.mjs` draw
 * helpers). All state + behavior live in `core.mjs`; this is a pure read of
 * state. Keystrokes map to named intents via `keymap`.
 *
 * The recovery / degraded panels render the typed `SourceError.display` VERBATIM
 * (the contract display/kind split): the presenter maps only `display.level` →
 * glyph + hue, never branching on `kind` and never hardcoding error copy.
 *
 * SGR discipline (§2): all hue is NUMERIC SGR codes (36 cyan, 33 yellow, 32
 * green, 31 red, 90 grey, bg 236); every colored element pairs hue with a glyph
 * or weight so it survives NO_COLOR / dumb terminals.
 *
 * @module linkedin/tui
 */

import { relTimestamp, EMOJIS } from './core.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./core.mjs').LiState} LiState */
/** @typedef {import('./core.mjs').Conversation} Conversation */
/** @typedef {import('./core.mjs').Message} Message */
/** @typedef {import('../../core/tui/draw.js').Draw} Draw */
/** @typedef {import('../../core/tui/draw.js').Rect} Rect */
/** @typedef {import('../../core/tui/draw.js').Span} Span */
/** @typedef {import('../../core/tui/draw.js').ListItemRow} ListItemRow */

/** Spinner frames for the auto-progress panel glyph (animates via the busy-tick). */
const SPINNER = ['⟳', '⟲'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Helpers (presentation-only) ───────────────────────────────────────────────

/** @param {string|string[]|null|undefined} v @returns {string[]} */
function toLinesArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s));
  return [String(v)];
}

/** Visible (column) width of a span group. @param {Span[]} spans */
function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/** Calendar-day key for day-divider grouping. @param {number} ts @returns {string} */
function dayKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Human day label for the divider: Today / Yesterday / Mon D / Mon D, YYYY. */
function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return 'Today';
  if (same(d, new Date(now - 86400000))) return 'Yesterday';
  const mon = MONTHS[d.getMonth()] || '';
  if (d.getFullYear() === n.getFullYear()) return `${mon} ${d.getDate()}`;
  return `${mon} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Word-wrap text to a width (also hard-splits over-long words). Preserves
 * explicit newlines as paragraph breaks.
 * @param {string} text @param {number} width @returns {string[]}
 */
function wrapText(text, width) {
  const w = Math.max(1, width | 0);
  /** @type {string[]} */
  const out = [];
  const paragraphs = String(text == null ? '' : text).split('\n');
  for (const para of paragraphs) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let wd = word;
      while (wd.length > w) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(wd.slice(0, w));
        wd = wd.slice(w);
      }
      if (line === '') line = wd;
      else if (line.length + 1 + wd.length <= w) line += ' ' + wd;
      else {
        out.push(line);
        line = wd;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

/**
 * Place a vertically + horizontally centered stack of span-lines in `rect`.
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

/**
 * Split the content rect into the 1:2 two-pane layout, drawing the `vline` rule.
 * @param {Draw} draw @param {Rect} content
 * @returns {{left: Rect, right: Rect}}
 */
function splitPanes(draw, content) {
  const cols = draw.columns(content, [1, 2]);
  const l = cols[0];
  const r = cols[1];
  const vcol = r.col;
  draw.vline(vcol, content.row, content.row + content.height);
  const left = { row: content.row, col: l.col, width: Math.max(0, vcol - l.col - 1), height: content.height };
  const right = { row: content.row, col: vcol + 2, width: Math.max(0, r.col + r.width - (vcol + 2)), height: content.height };
  return { left, right };
}

// ── Recovery panel (renders display.* VERBATIM; level → glyph/hue) ────────────

/**
 * Map a SourceError display level to a panel glyph + numeric SGR hue.
 * @param {import('../../core/view/contract.js').BannerLevel} level
 */
function levelGlyph(level) {
  if (level === 'action') return { glyph: '⚠', fg: '33' }; // yellow attention
  if (level === 'info') return { glyph: 'ℹ', fg: '36' }; // cyan notice
  return { glyph: '⚠', fg: '31' }; // red error
}

/**
 * The guided-recovery full-content takeover. The copy comes from the typed
 * SourceError display VERBATIM; only the glyph/hue are mapped off `display.level`
 * (or the live spinner frame on an auto-progress branch).
 * @param {LiState} state @param {Draw} draw @param {Rect} content
 */
function renderRecovery(state, draw, content) {
  const rec = state.recovery;
  if (!rec) return;
  const d = rec.display;
  let glyph;
  let glyphFg;
  let explanation = d.explanation;
  if (rec.spinner) {
    glyph = SPINNER[Math.floor(Date.now() / 240) % SPINNER.length] || '⟳';
    glyphFg = '36'; // cyan working
    const secs = Math.max(0, Math.floor((Date.now() - (rec.startedAt || Date.now())) / 1000));
    explanation = toLinesArr(d.explanation).concat([`(${secs}s)`]);
  } else {
    const g = levelGlyph(d.level);
    glyph = g.glyph;
    glyphFg = g.fg;
  }
  notReadyState(draw, content, {
    glyph,
    glyphFg,
    headline: d.headline,
    explanation,
    nextStep: d.nextStep || undefined,
  });
}

/** Two-pane loading skeleton. @param {LiState} state @param {Draw} draw @param {Rect} content */
function renderLoadingSkeleton(state, draw, content) {
  const { left, right } = splitPanes(draw, content);
  loadingState(draw, left, { rows: Math.min(5, Math.max(1, left.height)) });
  centeredStack(draw, right, [[{ text: 'Loading conversations…', style: { dim: true } }]]);
}

/** Left pane — the conversation list. @param {LiState} state @param {Draw} draw @param {Rect} left */
function renderConvoList(state, draw, left) {
  if (left.width <= 0 || left.height <= 0) return;
  /** @type {ListItemRow[]} */
  const items = state.convos.map((c, i) => {
    const isCursor = i === state.convCursor;
    /** @type {Span[]} */
    const spans = [
      { text: isCursor ? '▸' : ' ', style: isCursor ? { fg: '36', bold: true } : undefined },
      { text: c.unread ? '●' : ' ', style: c.unread ? { fg: '36', bold: true } : undefined },
      { text: ' ' + (c.name || 'Unknown'), style: c.unread ? { bold: true } : undefined },
    ];
    const snippet = (c.lastMessage || '').replace(/\s+/g, ' ').trim();
    if (snippet) spans.push({ text: '  ' + snippet, style: { dim: true } });
    const ts = relTimestamp(c.ts);
    /** @type {ListItemRow} */
    const item = { spans };
    if (ts) item.right = [{ text: ts, style: { dim: true } }];
    return item;
  });
  const res = draw.list(left, items, state.convCursor, state.convScroll);
  state.convScroll = res.scroll;
}

/**
 * Build the thread's flat visual lines with you-vs-them grouping. Day dividers
 * between date changes; 1 blank spacer between groups. The react target's header
 * gets a cyan ▸ tick.
 * @param {LiState} state @param {number} width @param {number} reactTarget
 * @returns {ListItemRow[]}
 */
function buildThreadLines(state, width, reactTarget) {
  /** @type {ListItemRow[]} */
  const lines = [];
  let prevDay = null;
  state.thread.forEach((m, idx) => {
    const day = dayKey(m.ts);
    if (m.ts && day !== prevDay) {
      const txt = `── ${dayLabel(m.ts)} ──`;
      const pad = Math.max(0, Math.floor((width - Array.from(txt).length) / 2));
      lines.push({ spans: [{ text: ' '.repeat(pad) + txt, style: { dim: true } }] });
      prevDay = day;
    }
    const tick = idx === reactTarget ? [{ text: '▸ ', style: { fg: '36', bold: true } }] : [];
    const ts = relTimestamp(m.ts);
    const right = ts ? [{ text: ts, style: { dim: true } }] : undefined;
    if (m.fromMe) {
      lines.push({
        spans: [...tick, { text: '▎ ', style: { fg: '32', bold: true } }, { text: 'You', style: { fg: '32', bold: true } }],
        right,
      });
      for (const bl of wrapText(m.text || '', Math.max(1, width - 2))) {
        lines.push({ spans: [{ text: '▎ ', style: { fg: '32' } }, { text: bl }] });
      }
    } else {
      lines.push({ spans: [...tick, { text: m.sender || 'Them', style: { fg: '36', bold: true } }], right });
      for (const bl of wrapText(m.text || '', width)) {
        lines.push({ spans: [{ text: bl }] });
      }
    }
    if (idx < state.thread.length - 1) lines.push({ spans: [{ text: '' }] });
  });
  return lines;
}

/** Paint the thread body (tail-windowed). @param {LiState} state @param {Draw} draw @param {Rect} rect @param {number} reactTarget */
function renderThreadBody(state, draw, rect, reactTarget) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const lines = buildThreadLines(state, rect.width, reactTarget);
  const start = Math.max(0, lines.length - rect.height);
  state.threadScroll = start;
  let r = rect.row;
  for (let i = start; i < lines.length && r < rect.row + rect.height; i++, r++) {
    const ln = lines[i];
    if (ln.right && ln.right.length) {
      const rw = spanWidth(ln.right);
      draw.spans(r, rect.col, ln.spans, Math.max(0, rect.width - rw - 1));
      draw.spansRight(r, rect.col + rect.width, ln.right, rw);
    } else {
      draw.spans(r, rect.col, ln.spans, rect.width);
    }
  }
}

/** The compose bar (reply mode). @param {LiState} state @param {Draw} draw @param {Rect} right */
function renderComposer(state, draw, right) {
  const hairRow = right.row + right.height - 3;
  const barRow = right.row + right.height - 2;
  const hintRow = right.row + right.height - 1;
  draw.hline(hairRow, right.col, right.col + right.width);
  const label = '✎ Reply ';
  const labelW = Array.from(label).length;
  const avail = Math.max(1, right.width - labelW - 1);
  let shown = state.draft;
  const arr = Array.from(shown);
  if (arr.length > avail - 1) shown = arr.slice(arr.length - (avail - 1)).join('');
  draw.spans(barRow, right.col, [
    { text: label, style: { fg: '33', bold: true } },
    { text: shown },
    { text: '█', style: { fg: '33' } },
  ], right.width);
  draw.spans(hintRow, right.col, [
    { text: 'enter', style: { bold: true } }, { text: ' send', style: { dim: true } },
    { text: ' · ', style: { dim: true } },
    { text: 'esc', style: { bold: true } }, { text: ' cancel', style: { dim: true } },
  ], right.width);
}

/** The react picker bar (react mode). @param {LiState} state @param {Draw} draw @param {Rect} right */
function renderReactBar(state, draw, right) {
  const hairRow = right.row + right.height - 3;
  const barRow = right.row + right.height - 2;
  const hintRow = right.row + right.height - 1;
  draw.hline(hairRow, right.col, right.col + right.width);
  /** @type {Span[]} */
  const spans = [{ text: '☺ React ', style: { fg: '33', bold: true } }];
  EMOJIS.forEach((e, i) => {
    if (i === state.reactCursor) {
      spans.push({ text: ' ' });
      spans.push({ text: '[' + e + ']', style: { bg: '236', reverse: true } });
    } else {
      spans.push({ text: '  ' + e + ' ' });
    }
  });
  draw.spans(barRow, right.col, spans, right.width);
  draw.spans(hintRow, right.col, [
    { text: '←/→', style: { bold: true } }, { text: ' pick', style: { dim: true } },
    { text: ' · ', style: { dim: true } },
    { text: 'enter', style: { bold: true } }, { text: ' react', style: { dim: true } },
    { text: ' · ', style: { dim: true } },
    { text: 'esc', style: { bold: true } }, { text: ' cancel', style: { dim: true } },
  ], right.width);
}

/** Right pane — the open thread + the compose/react bar when in a mode. @param {LiState} state @param {Draw} draw @param {Rect} right */
function renderThread(state, draw, right) {
  if (right.width <= 0 || right.height <= 0) return;
  const openConvo = state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) : null;

  if (!state.openUrn) {
    centeredStack(draw, right, [
      [{ text: '✉  ', style: { dim: true } }, { text: 'No conversation open', style: { dim: true } }],
      [{ text: '' }],
      [{ text: 'Press ' }, { text: 'Enter', style: { bold: true } }, { text: ' to open a conversation' }],
    ]);
    return;
  }

  const headerName = openConvo ? openConvo.name : 'Conversation';
  const convTs = openConvo ? relTimestamp(openConvo.ts) : '';
  const rw = convTs ? Array.from(convTs).length : 0;
  draw.spans(right.row, right.col, [{ text: headerName, style: { bold: true } }], Math.max(0, right.width - rw - 1));
  if (convTs) draw.spansRight(right.row, right.col + right.width, [{ text: convTs, style: { dim: true } }], rw);
  draw.hline(right.row + 1, right.col, right.col + right.width);

  const composing = state.mode === 'reply';
  const reacting = state.mode === 'react';
  const composerRows = composing || reacting ? 3 : 0;
  const bodyTop = right.row + 2;
  const bodyBottom = right.row + right.height - 1 - composerRows;
  const bodyRect = { row: bodyTop, col: right.col, width: right.width, height: Math.max(0, bodyBottom - bodyTop + 1) };

  if (state.thread.length === 0) {
    centeredStack(draw, bodyRect, [[{ text: 'Loading messages…', style: { dim: true } }]]);
  } else {
    renderThreadBody(state, draw, bodyRect, reacting ? state.thread.length - 1 : -1);
  }

  if (composing) renderComposer(state, draw, right);
  else if (reacting) renderReactBar(state, draw, right);
}

// ── render ─────────────────────────────────────────────────────────────────────

/**
 * Paint the view. Precedence: recovery takeover → loading skeleton → empty
 * reward → the two-pane inbox.
 * @param {LiState} state @param {Draw} draw @param {Rect} content
 */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;
  if (state.recovery) {
    renderRecovery(state, draw, content);
    return;
  }
  if (state.convos.length === 0) {
    if (state.lastFetch === 0) {
      renderLoadingSkeleton(state, draw, content);
      return;
    }
    emptyState(draw, content, {
      headline: 'All caught up',
      secondary: ['No conversations in your inbox.', 'Press g to refresh.'],
    });
    return;
  }
  const { left, right } = splitPanes(draw, content);
  renderConvoList(state, draw, left);
  renderThread(state, draw, right);
}

// ── keymap (replaces onKey; mode-gated bindings → named intents) ──────────────

/** @param {LiState} s */
const isList = (s) => s.mode === 'list';
/** @param {LiState} s */
const isReply = (s) => s.mode === 'reply';
/** @param {LiState} s */
const isReact = (s) => s.mode === 'react';
/** @param {LiState} s */
const isComposeOrReact = (s) => s.mode === 'reply' || s.mode === 'react';

/**
 * Input→intent map. List-mode navigation + entry into compose/react; the compose
 * bar uses a `capture` binding (the host's line-editor dispatches setDraft with
 * the next draft); react uses h/l + arrows. Footer hints come from these `hint`
 * fields (single source of truth).
 * @type {import('../../core/view/contract.js').KeyBinding<LiState>[]}
 */
export const keymap = [
  // ── List mode ──
  { keys: ['j', 'down'], intent: 'cursorDown', when: isList, hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp', when: isList },
  { keys: ['enter', 'return'], intent: 'openThread', payload: (s) => s.convCursor, when: isList, hint: { keys: 'enter', label: 'open' } },
  { keys: ['r'], intent: 'startReply', when: isList, hint: { keys: 'r', label: 'reply' } },
  { keys: ['e'], intent: 'startReact', when: isList, hint: { keys: 'e', label: 'react' } },
  { keys: ['g'], intent: 'refresh', when: isList, hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', when: isList, hint: { keys: 'q', label: 'quit' } },
  // ── Reply mode ── (capture → setDraft; enter sends; esc cancels)
  { capture: 'setDraft', when: isReply },
  { keys: ['enter', 'return'], intent: 'submitReply', when: isReply },
  { keys: ['escape', 'esc'], intent: 'cancelCompose', when: isComposeOrReact },
  // ── React mode ──
  { keys: ['left', 'h'], intent: 'reactPrev', when: isReact },
  { keys: ['right', 'l'], intent: 'reactNext', when: isReact },
  { keys: ['enter', 'return'], intent: 'submitReact', when: isReact },
];
