// @ts-check
/**
 * Combined `inbox` view — the TUI presenter (`render` + `keymap`). Node-only (it
 * uses the host's `Draw` API + the `_lib` draw helpers).
 *
 * `render` is a pure read of state; keystrokes map to named intents through
 * `keymap`. The compose/react bars READ `state.draft`/`state.reactCursor`/
 * `state.mode` (input flows through the `setDraft` capture intent, not a buffer
 * owned here). All state + data logic lives in `core.mjs`.
 *
 * SGR discipline (§2): all hue is NUMERIC SGR codes; every colored element pairs
 * hue with a glyph or weight so it survives NO_COLOR / dumb terminals.
 *
 * @module inbox/tui
 */

import { loadingState, emptyState, errorState, notReadyState } from '../_lib/states.mjs';
import { spanWidth, centeredStack, splitPanes, wrapText } from './_lib/render.mjs';
import { badgeFor, pickGuided, EMOJIS, relTimestamp, dayKey, dayLabel } from './core.mjs';

/** @typedef {import('./core.mjs').InboxState} InboxState */

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * The no-rows guided full-content takeover, built from a down source's display.
 * @param {object} draw @param {object} content @param {{label:string, d:any}} guide
 */
function renderGuided(draw, content, guide) {
  const d = guide.d;
  const headline = `${guide.label}: ${d.headline}`;
  if (d.level === 'error') {
    errorState(draw, content, {
      headline,
      cause: d.explanation,
      hint: d.nextStep || 'Press g to retry.',
    });
    return;
  }
  notReadyState(draw, content, {
    glyph: d.level === 'action' ? '⚠' : '⊙',
    glyphFg: d.level === 'action' ? '33' : '36',
    headline,
    explanation: d.explanation,
    nextStep: d.nextStep || undefined,
  });
}

/** Two-pane loading skeleton: dim placeholder rows left, a dim caption right. */
function renderLoadingSkeleton(draw, content) {
  const { left, right } = splitPanes(draw, content);
  loadingState(draw, left, { rows: Math.min(5, Math.max(1, left.height)) });
  centeredStack(draw, right, [[{ text: 'Loading inbox…', style: { dim: true } }]]);
}

/**
 * Left pane — the merged row list: cursor ▸ · unread ● · source badge · name ·
 * dim snippet · right-flush relative ts.
 * @param {InboxState} state @param {object} draw @param {object} left
 */
function renderRowList(state, draw, left) {
  if (left.width <= 0 || left.height <= 0) return;
  const items = state.rows.map((row, i) => {
    const isCursor = i === state.cursor;
    const b = badgeFor(row.sourceId);
    const glyph = padEnd2(b.glyph || '?'); // 'in' / '@ ' — align names
    /** @type {object[]} */
    const spans = [
      { text: isCursor ? '▸' : ' ', style: isCursor ? { fg: '36', bold: true } : undefined },
      { text: row.unread ? '●' : ' ', style: row.unread ? { fg: '36', bold: true } : undefined },
      { text: ' ' },
      { text: glyph, style: { fg: b.fg || '37', bold: true } }, // badge: hue + glyph (mono-safe)
      { text: ' ' + (row.name || 'Unknown'), style: row.unread ? { bold: true } : undefined },
    ];
    const snip = (row.snippet || '').replace(/\s+/g, ' ').trim();
    if (snip) spans.push({ text: '  ' + snip, style: { dim: true } });
    /** @type {any} */
    const item = { spans };
    const ts = relTimestamp(row.ts);
    if (ts) item.right = [{ text: ts, style: { dim: true } }];
    return item;
  });
  const res = draw.list(left, items, state.cursor, state.scroll);
  state.scroll = res.scroll;
}

/** Pad a badge glyph to 2 cols. */
function padEnd2(s) {
  const str = String(s == null ? '' : s);
  return str.length >= 2 ? str.slice(0, 2) : str + ' '.repeat(2 - str.length);
}

/**
 * Build the thread's flat visual lines with you-vs-them grouping.
 * @param {object[]} messages @param {number} width @param {number} reactTarget index, or -1
 * @returns {object[]}
 */
function buildThreadLines(messages, width, reactTarget) {
  /** @type {object[]} */
  const lines = [];
  let prevDay = null;
  messages.forEach((m, idx) => {
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
    if (idx < messages.length - 1) lines.push({ spans: [{ text: '' }] }); // spacer BETWEEN groups
  });
  return lines;
}

/** Paint the thread body (tail-windowed) into `rect`. */
function renderThreadBody(state, draw, rect, reactTarget) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const messages = (state.thread && state.thread.messages) || [];
  const lines = buildThreadLines(messages, rect.width, reactTarget);
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

/** The compose bar (reply mode): hairline + label + draft + cursor + hint. */
function renderComposer(state, draw, right) {
  const hairRow = right.row + right.height - 3;
  const barRow = right.row + right.height - 2;
  const hintRow = right.row + right.height - 1;
  draw.hline(hairRow, right.col, right.col + right.width);
  const label = '✎ Reply ';
  const labelW = Array.from(label).length;
  const avail = Math.max(1, right.width - labelW - 1); // 1 cell reserved for the cursor
  let shown = state.draft;
  const arr = Array.from(shown);
  if (arr.length > avail - 1) shown = arr.slice(arr.length - (avail - 1)).join(''); // keep the tail/cursor visible
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

/** The react picker bar (react mode): hairline + emoji chip row + hint. */
function renderReactBar(state, draw, right) {
  const hairRow = right.row + right.height - 3;
  const barRow = right.row + right.height - 2;
  const hintRow = right.row + right.height - 1;
  draw.hline(hairRow, right.col, right.col + right.width);
  /** @type {object[]} */
  const spans = [{ text: '☺ React ', style: { fg: '33', bold: true } }];
  EMOJIS.forEach((e, i) => {
    if (i === state.reactCursor) {
      spans.push({ text: ' ' });
      spans.push({ text: '[' + e + ']', style: { bg: '236', reverse: true } }); // accent-bg + brackets/reverse (mono carrier)
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

/**
 * Right pane — header (+ optional subtitle) + hairline + grouped body, plus the
 * compose/react bar when in a mode.
 * @param {InboxState} state @param {object} draw @param {object} right
 */
function renderDetail(state, draw, right) {
  if (right.width <= 0 || right.height <= 0) return;
  if (!state.openKey || !state.thread) {
    centeredStack(draw, right, [
      [{ text: '✉  ', style: { dim: true } }, { text: 'No conversation open', style: { dim: true } }],
      [{ text: '' }],
      [{ text: 'Press ' }, { text: 'Enter', style: { bold: true } }, { text: ' to open a conversation' }],
    ]);
    return;
  }
  const thread = state.thread;
  const messages = thread.messages || [];
  const hasSub = !!thread.subtitle;

  // Header: bold title + right-flush relative time of the latest message.
  const lastTs = messages.length ? messages[messages.length - 1].ts : (state.openRow ? state.openRow.ts : 0);
  const ts = relTimestamp(lastTs);
  const rw = ts ? Array.from(ts).length : 0;
  draw.spans(right.row, right.col, [{ text: thread.title || 'Conversation', style: { bold: true } }], Math.max(0, right.width - rw - 1));
  if (ts) draw.spansRight(right.row, right.col + right.width, [{ text: ts, style: { dim: true } }], rw);
  let headerRows = 1;
  if (hasSub) {
    draw.spans(right.row + 1, right.col, [{ text: thread.subtitle, style: { dim: true } }], right.width);
    headerRows = 2;
  }
  draw.hline(right.row + headerRows, right.col, right.col + right.width);

  const composing = state.mode === 'reply';
  const reacting = state.mode === 'react';
  const composerRows = composing || reacting ? 3 : 0;
  const bodyTop = right.row + headerRows + 1;
  const bodyBottom = right.row + right.height - 1 - composerRows;
  const bodyRect = { row: bodyTop, col: right.col, width: right.width, height: Math.max(0, bodyBottom - bodyTop + 1) };

  if (messages.length === 0) {
    centeredStack(draw, bodyRect, [[{ text: 'Loading messages…', style: { dim: true } }]]);
  } else {
    renderThreadBody(state, draw, bodyRect, reacting ? messages.length - 1 : -1);
  }

  if (composing) renderComposer(state, draw, right);
  else if (reacting) renderReactBar(state, draw, right);
}

/**
 * Paint. Precedence: no rows → loading skeleton (first paint) / guided panel (a
 * down source) / empty reward; else the two-pane merged inbox.
 * @param {InboxState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;
  if (state.rows.length === 0) {
    if (state.lastFetch === 0) {
      renderLoadingSkeleton(draw, content);
      return;
    }
    const guide = pickGuided(state);
    if (guide) {
      renderGuided(draw, content, guide);
      return;
    }
    emptyState(draw, content, {
      headline: 'All caught up',
      secondary: ['No messages in your inbox.', 'Press g to refresh.'],
    });
    return;
  }
  const { left, right } = splitPanes(draw, content);
  renderRowList(state, draw, left);
  renderDetail(state, draw, right);
}

// ── keymap ───────────────────────────────────────────────────────────────

/** @param {InboxState} s */
const listMode = (s) => s.mode === 'list';
/** @param {InboxState} s */
const replyMode = (s) => s.mode === 'reply';
/** @param {InboxState} s */
const reactMode = (s) => s.mode === 'react';

/** @type {import('../../core/view/contract.js').KeyBinding<InboxState>[]} */
export const keymap = [
  // list
  { keys: ['j', 'down'], intent: 'cursorDown', when: listMode, hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp', when: listMode },
  { keys: ['return'], intent: 'open', payload: (s) => s.cursor, when: listMode, hint: { keys: 'enter', label: 'open' } },
  { keys: ['r'], intent: 'startReply', when: listMode, hint: { keys: 'r', label: 'reply' } },
  { keys: ['e'], intent: 'startReact', when: listMode, hint: { keys: 'e', label: 'react' } },
  { keys: ['f'], intent: 'cycleFilter', when: listMode, hint: { keys: 'f', label: 'filter' } },
  { keys: ['g'], intent: 'refresh', when: listMode, hint: { keys: 'g', label: 'refresh' } },
  { keys: ['L'], intent: 'connectLinkedin', when: listMode },
  { keys: ['G'], intent: 'connectGmail', when: listMode, hint: { keys: 'G', label: 'connect' } },
  { keys: ['q'], intent: 'quit', when: listMode, hint: { keys: 'q', label: 'quit' } },
  // reply
  { capture: 'setDraft', when: replyMode, hint: { keys: 'type', label: 'reply' } },
  { keys: ['return'], intent: 'submitReply', when: replyMode },
  { keys: ['escape'], intent: 'cancelCompose', when: replyMode },
  // react
  { keys: ['h', 'left'], intent: 'reactPrev', when: reactMode },
  { keys: ['l', 'right'], intent: 'reactNext', when: reactMode },
  { keys: ['return'], intent: 'submitReact', when: reactMode },
  { keys: ['escape'], intent: 'cancelCompose', when: reactMode },
];
