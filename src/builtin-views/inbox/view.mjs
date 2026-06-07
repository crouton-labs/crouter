// @ts-check
/**
 * Combined `inbox` view — triage LinkedIn messages + Gmail in one ranked list.
 *
 * Self-contained ESM. Default-exports a ViewModule (see
 * `../../core/tui/contract.ts`). The host injects `Draw` + `ViewHost`; this
 * module imports NOTHING from crtr — only sibling `.mjs` (its Source adapters,
 * the shared render helpers, and the standard-state bodies) + Node builtins.
 *
 * The view owns the MERGE, the screen, the chrome, and the keymap; each Source
 * (`./sources/<id>.mjs`) owns its data fetching AND its own discover→auth→settle
 * recovery state machine. Partial readiness is mandatory: a down source
 * contributes zero rows + its own slim banner; every ready source's rows still
 * show. A guided full-content panel appears ONLY when NO source produced rows.
 *
 * SGR discipline (§2): all hue is NUMERIC SGR codes; every colored element pairs
 * hue with a glyph or weight so it survives NO_COLOR / dumb terminals.
 *
 * @module inbox/view
 */

import linkedinSource from './sources/linkedin.mjs';
import { loadingState, emptyState, errorState, notReadyState } from '../_lib/states.mjs';
import {
  truncate,
  padEnd,
  toLinesArr,
  spanWidth,
  centeredStack,
  splitPanes,
  relTimestamp,
  dayKey,
  dayLabel,
  wrapText,
  isPrintable,
} from './_lib/render.mjs';

// ── Sources ──────────────────────────────────────────────────────────────────
//
// Gmail is built concurrently by a sibling node. Import it dynamically + guarded
// so the view still loads (and `crtr view run inbox` exits 0) before that file
// lands; once present it drops straight into the `sources` array. A missing or
// malformed source simply contributes nothing — never a crash.
let gmailSource = null;
try {
  const mod = await import('./sources/gmail.mjs');
  gmailSource = (mod && (mod.default || mod.gmailSource)) || null;
} catch {
  gmailSource = null;
}

/** Ordered source list (LinkedIn first). Filtered of any absent source. */
const sources = [linkedinSource, gmailSource].filter(Boolean);

/** id → Source, for badge lookup + detail/reply dispatch by row.sourceId. */
const SOURCE_BY_ID = {};
for (const s of sources) SOURCE_BY_ID[s.id] = s;

/** @param {string} id @returns {any} */
function sourceById(id) {
  return SOURCE_BY_ID[id] || null;
}

/** @param {string} id @returns {{glyph:string, fg:string}} */
function badgeFor(id) {
  const s = SOURCE_BY_ID[id];
  return (s && s.badge) || { glyph: '?', fg: '37' };
}

/** Fixed emoji set for the react picker. */
const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/** Severity rank for choosing one banner / one guided panel across sources. */
const LEVEL_RANK = { error: 3, action: 2, info: 1 };

/**
 * Prefix a source's banner with its label — `Gmail: log in, then press g`. The
 * contract says the source banner is bare and the VIEW prepends the label, but
 * some sources bake the label in; this stays robust either way by not
 * double-prefixing when the text already leads with `<label>:`.
 * @param {string} label @param {string} banner @returns {string}
 */
function labeled(label, banner) {
  const b = String(banner == null ? '' : banner);
  const lead = `${label}:`.toLowerCase();
  return b.toLowerCase().startsWith(lead) ? b : `${label}: ${b}`;
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InboxState
 * @property {Record<string, any>} subs          Per-source private substate (state.subs[id]).
 * @property {Record<string, object[]>} rowsBySource  Last listRows() per source (ready sources only).
 * @property {object[]} rows                      The merged, sorted UnifiedRow[] (filtered).
 * @property {number} cursor                      Left-pane cursor into rows.
 * @property {number} scroll                      draw.list scroll for the left pane.
 * @property {string|null} openKey                key of the open row (right pane).
 * @property {object|null} openRow                The open UnifiedRow (source dispatch + ref).
 * @property {object|null} thread                 Loaded UnifiedThread, or null.
 * @property {number} threadScroll                Computed top line of the thread window.
 * @property {'list'|'reply'|'react'} mode        Input mode.
 * @property {string} draft                       Reply input buffer.
 * @property {number} reactCursor                 Index into EMOJIS.
 * @property {'all'|string} filter                Source filter (All → each source id).
 * @property {Record<string, object|null>} banners  Per-source down-state SourceError (or null).
 * @property {Record<string, boolean>} ready      Per-source readiness.
 * @property {number} lastFetch                   Epoch ms of the last refresh (0 ⇒ first paint).
 */

/** Sort the merged set unread-first then ts desc. Mutates `arr`. @param {object[]} arr */
function sortRows(arr) {
  arr.sort((a, b) => {
    if (!!a.unread !== !!b.unread) return a.unread ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

/** Filter cycle: All, then each present source id. @returns {string[]} */
function filterCycle() {
  return ['all', ...sources.map((s) => s.id)];
}

/**
 * Re-merge rowsBySource into the visible, sorted list — keeping the cursor on the
 * same row (by key) across refreshes/filters.
 * @param {InboxState} state
 */
function mergeRows(state) {
  const prev = state.rows[state.cursor];
  const prevKey = prev && prev.key;
  /** @type {object[]} */
  let all = [];
  for (const s of sources) {
    if (state.filter !== 'all' && state.filter !== s.id) continue;
    const rs = state.rowsBySource[s.id] || [];
    all = all.concat(rs);
  }
  sortRows(all);
  state.rows = all;
  if (prevKey) {
    const i = all.findIndex((r) => r.key === prevKey);
    if (i >= 0) state.cursor = i;
  }
  if (state.cursor >= all.length) state.cursor = Math.max(0, all.length - 1);
  if (state.cursor < 0) state.cursor = 0;
}

/** Sum unread across READY sources (independent of the visible filter). */
function unreadCount(state) {
  let n = 0;
  for (const s of sources) {
    if (!state.ready[s.id]) continue;
    for (const r of state.rowsBySource[s.id] || []) if (r.unread) n++;
  }
  return n;
}

/** Drive the live "N unread · <filter>" subtitle. */
function updateSubtitle(state, host) {
  const n = unreadCount(state);
  /** @type {string[]} */
  const parts = [];
  if (n > 0) parts.push(`${n} unread`);
  if (state.filter !== 'all') {
    const s = SOURCE_BY_ID[state.filter];
    parts.push(`${s ? s.label : state.filter} only`);
  }
  host.setSubtitle(parts.length ? parts.join(' · ') : null);
}

/**
 * Collapse the per-source down-states into ONE host banner (the slim, label-
 * prefixed line). Clears the banner when every source is healthy.
 * @param {InboxState} state @param {object} host
 */
function applyBanners(state, host) {
  /** @type {{label:string, d:any}[]} */
  const downs = [];
  for (const s of sources) {
    const e = state.banners[s.id];
    if (e && e.display) downs.push({ label: s.label || s.id, d: e.display });
  }
  if (downs.length === 0) {
    host.setError(null);
    return;
  }
  let level = 'info';
  for (const x of downs) if ((LEVEL_RANK[x.d.level] || 0) > (LEVEL_RANK[level] || 0)) level = x.d.level;
  const msg = downs.map((x) => labeled(x.label, x.d.banner)).join('   ·   ');
  host.setBanner(msg, /** @type {any} */ (level));
}

/**
 * Set a one-off banner for a per-action SourceError (open/reply/react). The next
 * refresh re-derives the persistent down-banner via applyBanners.
 * @param {object} host @param {any} src @param {{display?:any}} e
 */
function bannerFromSource(host, src, e) {
  const d = e && e.display;
  if (d && d.banner) host.setBanner(labeled(src.label, d.banner), d.level || 'error');
  else host.setError(`${src.label}: error`);
}

/**
 * Pick the most-severe down-source display for the no-rows guided panel
 * (blocking states win decisively).
 * @param {InboxState} state @returns {{label:string, d:any}|null}
 */
function pickGuided(state) {
  let best = null;
  let bestScore = -1;
  for (const s of sources) {
    const e = state.banners[s.id];
    if (!e || !e.display) continue;
    const score = (LEVEL_RANK[e.display.level] || 0) + (e.display.blocking ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { label: s.label || s.id, d: e.display };
    }
  }
  return best;
}

// ── Refresh (data lane) ──────────────────────────────────────────────────────

/**
 * For each source: ensureReady → on ok listRows; merge + sort; set per-source
 * banners from their SourceError.display. Partial readiness: one down source
 * never blanks the view. Runs in the host's single-flight lane. Skips while
 * composing/reacting so a poll can't disrupt input.
 * @param {InboxState} state @param {object} host
 */
async function refresh(state, host) {
  if (state.mode !== 'list') return;
  host.setStatus('Refreshing…');
  for (const s of sources) {
    const sub = state.subs[s.id];
    let er;
    try {
      er = await s.ensureReady(sub, host);
    } catch (e) {
      er = { ok: false, error: defensiveError('source error', e) };
    }
    if (er && er.ok) {
      state.ready[s.id] = true;
      state.banners[s.id] = null;
      let lr;
      try {
        lr = await s.listRows(sub);
      } catch (e) {
        lr = { ok: false, error: defensiveError('list failed', e) };
      }
      if (lr && lr.ok && Array.isArray(lr.data)) {
        state.rowsBySource[s.id] = lr.data;
      } else {
        state.rowsBySource[s.id] = [];
        state.banners[s.id] = (lr && lr.error) || defensiveError('list failed', null);
      }
    } else {
      state.ready[s.id] = false;
      state.rowsBySource[s.id] = [];
      state.banners[s.id] = (er && er.error) || defensiveError('not ready', null);
    }
  }
  mergeRows(state);
  host.setStatus(null);
  applyBanners(state, host);
  updateSubtitle(state, host);
  state.lastFetch = Date.now();
}

/** Build a SourceError-shaped object for a thrown/missing error (defensive). */
function defensiveError(headline, e) {
  const msg = e && e.message ? String(e.message) : headline;
  return {
    kind: 'error',
    display: {
      headline,
      explanation: msg,
      nextStep: 'Press g to retry',
      banner: msg,
      level: 'error',
      blocking: false,
    },
  };
}

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
    const glyph = padEnd(b.glyph || '?', 2); // 'in' / '@ ' — align names
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

/**
 * Build the thread's flat visual lines with you-vs-them grouping. them = cyan
 * sender + dim right time + default body; you = green ▎ rail + green You +
 * rail-indented body. Day dividers between date changes; 1 spacer between groups.
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

/** The lifted compose bar (reply mode): hairline + label + draft + cursor + hint. */
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
 * Right pane — dispatch on the open row's source: header (+ optional subtitle) +
 * hairline + grouped body, plus the compose/react bar when in a mode.
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

// ── onKey handlers ───────────────────────────────────────────────────────────

/** Open the row under the cursor: dispatch to its source's loadThread. */
async function openThread(state, host) {
  const row = state.rows[state.cursor];
  if (!row) return { type: 'none' };
  const src = sourceById(row.sourceId);
  const sub = state.subs[row.sourceId];
  if (!src || !sub) {
    host.setError('Unknown source for this row.');
    return { type: 'render' };
  }
  state.openKey = row.key;
  state.openRow = row;
  state.thread = null;
  state.threadScroll = 0;
  host.setStatus('Loading thread…');
  let r;
  try {
    r = await src.loadThread(sub, row.ref);
  } catch (e) {
    r = { ok: false, error: defensiveError('could not load thread', e) };
  }
  host.setStatus(null);
  if (!r || !r.ok) {
    bannerFromSource(host, src, (r && r.error) || defensiveError('could not load thread', null));
    return { type: 'render' };
  }
  state.thread = r.data;
  row.unread = false; // optimistic; the source also clears its cache
  updateSubtitle(state, host);
  return { type: 'render' };
}

/** Send the current draft via the open row's source. */
async function sendReply(state, host) {
  const text = state.draft.trim();
  if (!text) {
    state.mode = 'list';
    host.setMode(null);
    return { type: 'render' };
  }
  const row = state.openRow;
  const src = row ? sourceById(row.sourceId) : null;
  const sub = row ? state.subs[row.sourceId] : null;
  if (!row || !src || !sub) {
    host.setError('No open conversation to reply to.');
    state.mode = 'list';
    host.setMode(null);
    return { type: 'render' };
  }
  state.mode = 'list';
  host.setMode(null);
  host.setStatus('Sending…');
  let r;
  try {
    r = await src.reply(sub, row.ref, text);
  } catch (e) {
    r = { ok: false, error: defensiveError('send failed', e) };
  }
  if (!r || !r.ok) {
    host.setStatus(null);
    bannerFromSource(host, src, (r && r.error) || defensiveError('send failed', null));
    return { type: 'render' };
  }
  state.draft = '';
  // Reconcile by reloading the thread (optimistic refresh).
  try {
    const t = await src.loadThread(sub, row.ref);
    if (t && t.ok) state.thread = t.data;
  } catch { /* a thread reload failure is non-fatal */ }
  host.setStatus('Sent');
  applyBanners(state, host);
  return { type: 'render' };
}

/** React to the latest message in the open thread (source must support react). */
async function doReact(state, host) {
  const row = state.openRow;
  const src = row ? sourceById(row.sourceId) : null;
  const sub = row ? state.subs[row.sourceId] : null;
  state.mode = 'list';
  host.setMode(null);
  if (!row || !src || !sub || typeof src.react !== 'function') {
    host.setError('Cannot react here.');
    return { type: 'render' };
  }
  const emoji = EMOJIS[state.reactCursor] || EMOJIS[0];
  host.setStatus('Reacting…');
  let r;
  try {
    r = await src.react(sub, row.ref, emoji);
  } catch (e) {
    r = { ok: false, error: defensiveError('react failed', e) };
  }
  if (!r || !r.ok) {
    host.setStatus(null);
    bannerFromSource(host, src, (r && r.error) || defensiveError('react failed', null));
    return { type: 'render' };
  }
  host.setStatus('Reacted ' + emoji);
  applyBanners(state, host);
  return { type: 'render' };
}

/** Run a source's manual connect() (bound to its connectKey). */
async function runConnect(src, state, host) {
  const sub = state.subs[src.id];
  if (typeof src.connect !== 'function' || !sub) return { type: 'none' };
  host.setStatus(`Connecting ${src.label}…`);
  let r;
  try {
    r = await src.connect(sub, host);
  } catch (e) {
    r = { ok: false, error: defensiveError('connect failed', e) };
  }
  host.setStatus(null);
  if (!r || !r.ok) {
    state.banners[src.id] = (r && r.error) || defensiveError('connect failed', null);
    applyBanners(state, host);
    return { type: 'render' };
  }
  return { type: 'refresh' }; // re-run ensureReady against the (re)connected tab
}

/** Cycle the source filter: All → each source → back to All. */
function cycleFilter(state, host) {
  const cyc = filterCycle();
  const i = cyc.indexOf(state.filter);
  state.filter = cyc[(i + 1) % cyc.length] || 'all';
  mergeRows(state);
  updateSubtitle(state, host);
}

/** List-mode keystrokes. */
function onKeyList(k, state, host) {
  const key = k.key;
  const ch = k.input;

  if (ch === 'q') return { type: 'quit' };
  if (ch === 'g') return { type: 'refresh' };

  if (key.downArrow || ch === 'j') {
    if (state.rows.length) state.cursor = Math.min(state.rows.length - 1, state.cursor + 1);
    return { type: 'render' };
  }
  if (key.upArrow || ch === 'k') {
    state.cursor = Math.max(0, state.cursor - 1);
    return { type: 'render' };
  }
  if (key.return) return openThread(state, host);
  if (ch === 'f') {
    cycleFilter(state, host);
    return { type: 'render' };
  }
  if (ch === 'r') {
    if (!state.openKey || !state.thread) {
      host.setBanner('Open a conversation first', 'action');
      return { type: 'render' };
    }
    if (!state.thread.canReply) return { type: 'none' };
    state.mode = 'reply';
    state.draft = '';
    host.setMode('compose');
    return { type: 'render' };
  }
  if (ch === 'e') {
    if (!state.openKey || !state.thread) {
      host.setBanner('Open a conversation first', 'action');
      return { type: 'render' };
    }
    if (!state.thread.canReact || (state.thread.messages || []).length === 0) return { type: 'none' };
    state.mode = 'react';
    state.reactCursor = 0;
    host.setMode('react');
    return { type: 'render' };
  }
  // Per-source connect keys (e.g. G → gmail.connect(), L → linkedin.connect()).
  for (const s of sources) {
    if (s.connectKey && ch === s.connectKey) return runConnect(s, state, host);
  }
  return { type: 'none' };
}

/** Reply-mode keystrokes. */
function onKeyReply(k, state, host) {
  const key = k.key;
  if (key.escape) {
    state.mode = 'list';
    state.draft = '';
    host.setMode(null);
    return { type: 'render' };
  }
  if (key.return) return sendReply(state, host);
  if (key.backspace) {
    state.draft = state.draft.slice(0, -1);
    return { type: 'render' };
  }
  if (isPrintable(k)) {
    state.draft += k.input;
    return { type: 'render' };
  }
  return { type: 'none' };
}

/** React-mode keystrokes. */
function onKeyReact(k, state, host) {
  const key = k.key;
  const ch = k.input;
  if (key.escape) {
    state.mode = 'list';
    host.setMode(null);
    return { type: 'render' };
  }
  if (key.leftArrow || ch === 'h') {
    state.reactCursor = Math.max(0, state.reactCursor - 1);
    return { type: 'render' };
  }
  if (key.rightArrow || ch === 'l') {
    state.reactCursor = Math.min(EMOJIS.length - 1, state.reactCursor + 1);
    return { type: 'render' };
  }
  if (key.return) return doReact(state, host);
  return { type: 'none' };
}

// ── ViewModule ───────────────────────────────────────────────────────────────

/** @type {import('../../core/tui/contract.js').ViewModule<InboxState>} */
const view = {
  manifest: {
    id: 'inbox',
    title: 'Inbox',
    description: 'Combined inbox — triage LinkedIn + Gmail in one ranked list',
    refreshMs: 30000,
    keymap: [
      { keys: 'j/k', label: 'move' },
      { keys: 'enter', label: 'open' },
      { keys: 'r', label: 'reply' },
      { keys: 'e', label: 'react' },
      { keys: 'f', label: 'filter' },
      { keys: 'g', label: 'refresh' },
      { keys: 'G', label: 'connect' },
      { keys: 'q', label: 'quit' },
    ],
  },

  /**
   * Build initial state. Cheap + sync — each source seeds its own substate. NO
   * slow fetch (the host paints the loading skeleton, then calls refresh()).
   * @param {object} host @returns {InboxState}
   */
  init(host) {
    /** @type {Record<string, any>} */
    const subs = {};
    for (const s of sources) subs[s.id] = typeof s.init === 'function' ? s.init(host) : {};
    return {
      subs,
      rowsBySource: {},
      rows: [],
      cursor: 0,
      scroll: 0,
      openKey: null,
      openRow: null,
      thread: null,
      threadScroll: 0,
      mode: 'list',
      draft: '',
      reactCursor: 0,
      filter: 'all',
      banners: {},
      ready: {},
      lastFetch: 0,
    };
  },

  refresh,

  /**
   * Paint. Precedence: no rows → loading skeleton (first paint) / guided panel
   * (a down source) / empty reward; else the two-pane merged inbox.
   * @param {InboxState} state @param {object} draw @param {object} content
   */
  render(state, draw, content) {
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
  },

  /**
   * One keystroke → next action. Dispatches by mode.
   * @param {object} k @param {InboxState} state @param {object} host
   */
  onKey(k, state, host) {
    switch (state.mode) {
      case 'reply':
        return onKeyReply(k, state, host);
      case 'react':
        return onKeyReact(k, state, host);
      default:
        return onKeyList(k, state, host);
    }
  },

  /**
   * Plain-text snapshot for the non-TTY / piped path (exit 0). No ANSI. Surfaces
   * the merged list + each down source's banner + the host's current banner.
   * @param {InboxState} state @param {{banner?: {msg:string, level:string}|null}} [ctx]
   * @returns {string}
   */
  dump(state, ctx) {
    const banner = ctx && ctx.banner ? ctx.banner : null;
    const sigil = (lvl) => (lvl === 'error' ? '✗' : lvl === 'action' ? '▸' : 'ℹ');
    /** @type {string[]} */
    const lines = [];
    const n = unreadCount(state);
    let head = 'Inbox';
    if (n) head += ` · ${n} unread`;
    if (state.filter !== 'all') {
      const s = SOURCE_BY_ID[state.filter];
      head += ` · ${s ? s.label : state.filter} only`;
    }
    lines.push(head, '');

    let anyDown = false;
    for (const s of sources) {
      const e = state.banners[s.id];
      if (e && e.display) {
        anyDown = true;
        lines.push(labeled(s.label, e.display.banner));
      }
    }
    if (anyDown) lines.push('');

    if (state.rows.length === 0) {
      if (state.lastFetch === 0) lines.push('(loading…)');
      else if (!anyDown) lines.push('✓ All caught up — no messages.');
    } else {
      for (const row of state.rows) {
        const badge = padEnd(badgeFor(row.sourceId).glyph, 2);
        const dot = row.unread ? '●' : ' ';
        const snip = truncate((row.snippet || '').replace(/\s+/g, ' ').trim(), 48);
        lines.push(`[${dot}] ${badge} ${padEnd(row.name || 'Unknown', 20)} ${padEnd(snip, 48)} ${relTimestamp(row.ts)}`);
      }
    }

    if (state.openKey && state.thread) {
      lines.push('', `— ${state.thread.title} —`);
      if (state.thread.subtitle) lines.push(state.thread.subtitle);
      for (const m of state.thread.messages || []) {
        const who = m.fromMe ? 'You' : m.sender || 'Them';
        lines.push(`${who}: ${(m.text || '').replace(/\s+/g, ' ').trim()}`);
      }
    }

    if (banner) lines.push('', sigil(banner.level) + ' ' + banner.msg);
    return lines.join('\n');
  },
};

export default view;
