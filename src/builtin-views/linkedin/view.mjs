// @ts-check
/**
 * LinkedIn Messages — the crtr `linkedin` view, reskinned to the approved
 * crtr-views visual + interaction design (§5 of crtr-views-visual-design.md).
 *
 * Self-contained ESM. Imports its data layer from `./client.mjs` and the shared
 * standard-state body helpers from `../_lib/states.mjs` RELATIVELY — and imports
 * NOTHING from crtr. The host injects the `Draw` + `ViewHost` API and dynamically
 * `import()`s this module's DEFAULT EXPORT.
 *
 * Two-pane inbox (conversation list 1 : thread 2, split by a `vline`):
 *   • conversation rows: cursor tick ▸ · unread dot ● · name · dim snippet ·
 *     right-flush relative timestamp; sorted unread-first then newest.
 *   • thread: you-vs-them grouping (cyan them / green ▎ tick you), day dividers,
 *     tail-windowing; compose (`r`) + react (`e`) as first-class modes.
 *   • the not-ready / auto-open recovery state machine: each ClientError maps to
 *     a behavior + guided full-content panel + state chip; auto-fixes drive the
 *     browser to the inbox and bounded-poll for readiness — never a dead-end.
 *
 * SGR discipline (§2): all hue is NUMERIC SGR codes (36 cyan, 33 yellow, 32
 * green, 31 red, 90 grey, bg 236); every colored element pairs hue with a glyph
 * or weight so it survives NO_COLOR / dumb terminals.
 *
 * @module linkedin/view
 */

import {
  discoverTab,
  getContext,
  listConversations,
  viewConversation,
  sendMessage,
  markConversationAsRead,
  reactToMessage,
  openMessagingTab,
  navigateToMessaging,
} from './client.mjs';
import { loadingState, emptyState, errorState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./client.mjs').LiContext} LiContext */
/** @typedef {import('./client.mjs').Conversation} Conversation */
/** @typedef {import('./client.mjs').Message} Message */
/** @typedef {import('./client.mjs').ClientError} ClientError */

/**
 * A guided-recovery panel descriptor (the full-content takeover, §5). `null` when
 * the view is ready (or keeping last-known content under a banner).
 * @typedef {Object} Recovery
 * @property {'guided'|'error'} variant  'error' → the ✗ red errorState block; else notReadyState.
 * @property {string} glyph              Panel glyph (overridden by the live spinner frame when `spinner`).
 * @property {string} glyphFg            Numeric SGR hue for the glyph ('36' working, '33'/'31' blocked).
 * @property {string} headline           Bold headline naming the state.
 * @property {string|string[]} explanation  Dim explanatory line(s).
 * @property {string|null} nextStep      The explicit call-to-action (default weight).
 * @property {boolean} spinner           Auto-progress: animate the glyph + show elapsed (Ns).
 * @property {number} [startedAt]        Epoch ms the auto-progress began (for the live (Ns) counter).
 */

/**
 * The view's single mutable state object. The view owns it; hooks mutate it in
 * place.
 * @typedef {Object} LiState
 * @property {LiContext|null} ctx        Cached after the first getContext().
 * @property {string|null} target        Discovered/opened CDP tab id (or options.target).
 * @property {string|undefined} port     options.port passthrough.
 * @property {Conversation[]} convos     Inbox, sorted unread-first then newest.
 * @property {number} convCursor         Index into convos (left pane cursor).
 * @property {number} convScroll         draw.list scroll for the left pane.
 * @property {string|null} openUrn       URN of the open conversation (right pane).
 * @property {Message[]} thread          Messages of the open conversation.
 * @property {number} threadScroll       Computed top line of the thread window.
 * @property {'list'|'reply'|'react'} mode  Input mode.
 * @property {string} draft              Reply input buffer (view owns input).
 * @property {number} reactCursor        Index into EMOJIS.
 * @property {number} lastFetch          Epoch ms of the last successful refresh.
 * @property {Recovery|null} recovery    Active guided-recovery panel (full-content takeover), or null.
 * @property {boolean} loginTabOpened   True once the login tab has been opened for the current not-logged-in episode; reset on ready so a later logout re-opens exactly once.
 */

/** Fixed emoji set for the react picker. */
const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/** How many conversations to request per refresh. */
const CONVO_COUNT = 25;

/** Settle-poll bounds (§5): retry readiness up to N times, spaced ~MS, after an
 *  auto open/navigate — a hard ceiling so the flow never spins forever. */
const SETTLE_MAX = 5;
const SETTLE_INTERVAL_MS = 1200;

/** ClientError kinds that waiting can't fix — stop the settle-poll and guide. */
const HARD_STOP = new Set(['no-cdp', 'not-logged-in', 'capture-not-dev']);

/** Spinner frames for the auto-progress panel glyph (animates via the busy-tick). */
const SPINNER = ['⟳', '⟲'];

/** Month abbreviations for the timestamp / day-divider ladder. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sort conversations unread-first, then newest (ts desc). Non-mutating.
 * @param {Conversation[]} convos
 * @returns {Conversation[]}
 */
function sortConvos(convos) {
  return convos.slice().sort((a, b) => {
    if (!!a.unread !== !!b.unread) return a.unread ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

/** @param {LiState} state @returns {{target:string|undefined, port:string|undefined}} */
function baseOpts(state) {
  return { target: state.target || undefined, port: state.port };
}

/** @param {string} s @param {number} n @returns {string} */
function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

/** @param {string} s @param {number} n @returns {string} */
function padEnd(s, n) {
  const str = String(s == null ? '' : s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

/** @param {string|string[]|null|undefined} v @returns {string[]} */
function toLinesArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s));
  return [String(v)];
}

/**
 * Relative-timestamp ladder (§5), max ~5 cols: now / {m}m / {h}h / {d}d /
 * `Mon D` (this year) / `Mon ʼYY` (prior year).
 * @param {number} ts epoch ms (0 ⇒ '')
 * @param {number} [now]
 * @returns {string}
 */
function relTimestamp(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.floor((now - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const dt = new Date(ts);
  const mon = MONTHS[dt.getMonth()] || '';
  const cur = new Date(now);
  if (dt.getFullYear() === cur.getFullYear()) return `${mon} ${dt.getDate()}`;
  return `${mon} ʼ${String(dt.getFullYear()).slice(-2)}`;
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
 * Decide whether a keystroke is a printable character to append to the draft.
 * @param {{input:string, key:any}} k @returns {boolean}
 */
function isPrintable(k) {
  const key = k.key || {};
  if (key.ctrl || key.meta) return false;
  if (key.return || key.escape || key.backspace || key.tab || key.shiftTab) return false;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false;
  const ch = k.input;
  if (!ch || ch.length === 0) return false;
  const code = ch.codePointAt(0);
  if (code == null) return false;
  if (code < 0x20 || code === 0x7f) return false; // C0 controls + DEL
  return true;
}

/** Visible (column) width of a span group. @param {import('../../core/tui/draw.js').Span[]} spans */
function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/**
 * Place a vertically + horizontally centered stack of span-lines in `rect`.
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} rect
 * @param {import('../../core/tui/draw.js').Span[][]} lines
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
 * Split the content rect into the 1:2 two-pane layout, drawing the `vline` rule
 * between the panes (§5 / §2: a quiet separator, not a box). Returns the inner
 * list/thread rects (the left list owns col 0 for its cursor tick = the gutter;
 * the thread sits one cell right of the rule).
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 * @returns {{left: import('../../core/tui/draw.js').Rect, right: import('../../core/tui/draw.js').Rect}}
 */
function splitPanes(draw, content) {
  const cols = draw.columns(content, [1, 2]);
  const l = cols[0];
  const r = cols[1];
  const vcol = r.col; // the boundary column carries the rule
  draw.vline(vcol, content.row, content.row + content.height);
  const left = { row: content.row, col: l.col, width: Math.max(0, vcol - l.col - 1), height: content.height };
  const right = { row: content.row, col: vcol + 2, width: Math.max(0, r.col + r.width - (vcol + 2)), height: content.height };
  return { left, right };
}

// ── Error → guided recovery descriptor ──────────────────────────────────────

/**
 * Map a typed {@link ClientError} to its recovery descriptor (the §5 state-
 * machine table). `autoFix` marks the self-healing branches; the rest carry the
 * guided panel text + the banner that drives the title state chip.
 * @param {ClientError} error
 * @returns {{autoFix?:'open'|'navigate', variant?:'error'|'inline', glyph?:string, glyphFg?:string,
 *   headline?:string, explanation?:string|string[], nextStep?:string, keepContent?:boolean,
 *   bannerMsg?:string, bannerLevel?:import('../../core/tui/contract.js').BannerLevel}}
 */
function describeError(error) {
  const kind = error && error.kind;
  switch (kind) {
    case 'no-tab':
      return {
        autoFix: 'open',
        headline: 'Opening LinkedIn…',
        explanation: 'No messaging tab was open — opening one and waiting for it to load.',
      };
    case 'not-messaging':
      return {
        autoFix: 'navigate',
        headline: 'Opening your inbox…',
        explanation: 'Found LinkedIn on another page — switching it to Messages.',
      };
    case 'not-logged-in':
      return {
        glyph: '⚠', glyphFg: '33',
        headline: 'Log in to continue',
        explanation: 'LinkedIn needs a sign-in in the browser.',
        bannerMsg: 'Log in in the opened tab, then press r', bannerLevel: 'action',
      };
    case 'no-cdp':
      return {
        glyph: '⚠', glyphFg: '31',
        headline: 'No debuggable browser',
        explanation: 'crtr drives a browser over CDP and none is running.',
        nextStep: 'Launch Arc, or Chrome with --remote-debugging-port=9222, then press r',
        bannerMsg: 'No debuggable browser — launch one, then press r', bannerLevel: 'error',
      };
    case 'rate-limited':
      return {
        glyph: '⚠', glyphFg: '33',
        headline: 'LinkedIn is throttling',
        explanation: 'Too many requests — waiting before trying again.',
        nextStep: 'Press g to retry',
        keepContent: true,
        bannerMsg: 'LinkedIn is throttling — waiting, then retry with g', bannerLevel: 'info',
      };
    case 'not-connection':
      return { variant: 'inline', bannerMsg: 'Can only message 1st-degree connections', bannerLevel: 'error' };
    case 'capture-not-dev':
      return {
        glyph: '⚠', glyphFg: '31',
        headline: 'Browser bridge unavailable',
        explanation: 'This view needs a capture dev checkout (vault/ + esbuild).',
        bannerMsg: 'Browser bridge unavailable — capture dev checkout required', bannerLevel: 'error',
      };
    case 'error':
    default:
      return {
        variant: 'error',
        headline: 'Something went wrong',
        explanation: (error && /** @type {any} */ (error).message) || 'Unknown error.',
        nextStep: 'Press g to retry.',
        bannerMsg: (error && /** @type {any} */ (error).message) || 'Something went wrong', bannerLevel: 'error',
      };
  }
}

/**
 * Apply a non-auto-fix descriptor: set (or clear) the guided panel + the banner
 * that drives the state chip. `inline` errors and `keepContent` (rate-limited
 * with a populated inbox) keep the last-known content instead of taking over.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @param {ReturnType<typeof describeError>} d
 */
function applyGuided(state, host, d) {
  host.setStatus(null);
  host.setMode(null);
  if (d.variant === 'inline' || (d.keepContent && state.convos.length)) {
    state.recovery = null;
  } else {
    state.recovery = {
      variant: d.variant === 'error' ? 'error' : 'guided',
      glyph: d.glyph || '⚠',
      glyphFg: d.glyphFg || '31',
      headline: d.headline || 'Not ready',
      explanation: d.explanation || '',
      nextStep: d.nextStep || null,
      spinner: false,
    };
  }
  if (d.bannerMsg) host.setBanner(d.bannerMsg, d.bannerLevel || 'error');
  else host.setError(null);
}

/**
 * The recovery state machine. Runs inside `refresh` (the single-flight lane).
 * Auto-fix branches drive the browser (open/navigate) then settle-poll; the rest
 * fall straight to a guided panel. Never re-entrant, never a dead-end.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @param {ClientError} error
 */
async function recover(state, host, error) {
  const d = describeError(error);
  if (d.autoFix) {
    host.setMode(null);
    host.setError(null);
    state.recovery = {
      variant: 'guided', glyph: '⟳', glyphFg: '36',
      headline: d.headline || 'Working…', explanation: d.explanation || '',
      nextStep: null, spinner: true, startedAt: Date.now(),
    };
    host.setStatus(d.headline || 'Working…');
    const fix = d.autoFix === 'open'
      ? await openMessagingTab({ port: state.port })
      : await navigateToMessaging({ target: state.target || undefined, port: state.port });
    if (!fix.ok) {
      applyGuided(state, host, describeError(fix.error));
      return;
    }
    if (d.autoFix === 'open' && fix.data) state.target = fix.data;
    state.ctx = null; // re-read auth for the (possibly new) tab/page
    await settlePoll(state, host);
    return;
  }
  // not-logged-in: open the messaging tab ONCE so the login page is visible, then
  // STOP (§5). Logged out, LinkedIn redirects /messaging/ → /login|/authwall, so
  // capture's URL-match misses and a NEW tab would be spawned on EVERY 30s
  // auto-poll. Gate the open to once per episode; onReady() resets the flag so a
  // later logout re-opens exactly once.
  if (error && error.kind === 'not-logged-in' && !state.loginTabOpened) {
    const o = await openMessagingTab({ port: state.port });
    if (o.ok && o.data) state.target = o.data;
    state.loginTabOpened = true;
  }
  applyGuided(state, host, d);
}

/**
 * Bounded settle-poll after an auto open/navigate (§5): retry readiness up to
 * SETTLE_MAX times spaced SETTLE_INTERVAL_MS, narrating elapsed seconds via
 * setStatus (visible through the busy-tick repaint) and the panel's live (Ns).
 * On success → ready + paint. On a hard-stop error → guided. On exhaustion →
 * action banner "Still loading — press g to retry" over the panel (no infinite
 * spin).
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 */
async function settlePoll(state, host) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    const secs = state.recovery && state.recovery.startedAt
      ? Math.max(0, Math.floor((Date.now() - state.recovery.startedAt) / 1000))
      : i;
    host.setStatus(`Loading messages… (${secs}s)`);
    const r = await attemptLoad(state);
    if (r.ok) {
      onReady(state, host);
      return;
    }
    if (HARD_STOP.has(r.error.kind)) {
      applyGuided(state, host, describeError(r.error));
      return;
    }
    // transient (no-tab / not-messaging / rate-limited / error) → keep polling
  }
  if (state.recovery) state.recovery.spinner = false;
  host.setStatus(null);
  host.setBanner('Still loading — press g to retry', 'action');
}

/**
 * One readiness attempt: discover the tab (unless supplied/known), read auth
 * context once, list conversations, and reload the open thread if any. Returns a
 * Result-shaped value ({ok:true} or the first ClientError) — never throws.
 * @param {LiState} state
 * @returns {Promise<{ok:true} | {ok:false, error:ClientError}>}
 */
async function attemptLoad(state) {
  if (!state.target) {
    const r = await discoverTab({ port: state.port });
    if (!r.ok) return r;
    state.target = r.data;
  }
  if (!state.ctx) {
    const r = await getContext(baseOpts(state));
    if (!r.ok) return r;
    state.ctx = r.data;
  }
  const lc = await listConversations({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    memberId: state.ctx.memberId,
    count: CONVO_COUNT,
  });
  if (!lc.ok) return lc;
  state.convos = sortConvos(lc.data);
  if (state.convCursor >= state.convos.length) state.convCursor = Math.max(0, state.convos.length - 1);
  if (state.openUrn) {
    const vc = await viewConversation({
      ...baseOpts(state),
      csrf: state.ctx.csrf,
      conversationUrn: state.openUrn,
      myMemberId: state.ctx.memberId,
    });
    if (vc.ok) state.thread = vc.data; // a thread-only failure is non-fatal
  }
  return { ok: true };
}

/**
 * Mark the view ready: clear the recovery panel + banner, refresh the live
 * unread subtitle, stamp lastFetch.
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 */
function onReady(state, host) {
  state.recovery = null;
  state.lastFetch = Date.now();
  state.loginTabOpened = false; // a fresh ready resets the once-per-episode login-tab gate
  host.setStatus(null);
  host.setError(null);
  if (state.mode === 'list') host.setMode(null);
  updateUnread(state, host);
}

/** Drive the live "N unread" title subtitle (null ⇒ manifest default / nothing). */
function updateUnread(state, host) {
  let n = 0;
  for (const c of state.convos) if (c.unread) n++;
  host.setSubtitle(n > 0 ? `${n} unread` : null);
}

/**
 * Set the right severity banner for a per-action ClientError (open/send/react).
 * @param {import('../../core/tui/contract.js').ViewHost} host @param {ClientError} error
 */
function bannerError(host, error) {
  const d = describeError(error);
  if (d.bannerMsg) host.setBanner(d.bannerMsg, d.bannerLevel || 'error');
  else host.setError(d.headline || (error && /** @type {any} */ (error).message) || 'Error');
}

// ── Refresh (data lane) ──────────────────────────────────────────────────────

/**
 * Fetch the inbox (and the open thread). Runs in the host's single-flight lane:
 * on launch, on `refreshMs`, and on `{type:'refresh'}`. On failure, hands off to
 * the recovery state machine. Skips auto-polls while composing/reacting so a poll
 * can't disrupt input.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  if (state.mode !== 'list') return;
  host.setStatus('Loading…');
  const r = await attemptLoad(state);
  if (r.ok) {
    onReady(state, host);
    return;
  }
  await recover(state, host, r.error);
}

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * The guided-recovery full-content takeover (§4 not-ready / §5 panels).
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
function renderRecovery(state, draw, content) {
  const rec = state.recovery;
  if (!rec) return;
  if (rec.variant === 'error') {
    errorState(draw, content, {
      headline: rec.headline,
      cause: rec.explanation,
      hint: rec.nextStep || 'Press g to retry.',
    });
    return;
  }
  let glyph = rec.glyph;
  let explanation = rec.explanation;
  if (rec.spinner) {
    glyph = SPINNER[Math.floor(Date.now() / 240) % SPINNER.length] || rec.glyph;
    const secs = Math.max(0, Math.floor((Date.now() - (rec.startedAt || Date.now())) / 1000));
    explanation = toLinesArr(rec.explanation).concat([`(${secs}s)`]);
  }
  notReadyState(draw, content, {
    glyph,
    glyphFg: rec.glyphFg,
    headline: rec.headline,
    explanation,
    nextStep: rec.nextStep || undefined,
  });
}

/**
 * Two-pane loading skeleton (§4 loading): dim placeholder rows on the left, a dim
 * caption on the right, split by the rule.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 */
function renderLoadingSkeleton(state, draw, content) {
  const { left, right } = splitPanes(draw, content);
  loadingState(draw, left, { rows: Math.min(5, Math.max(1, left.height)) });
  centeredStack(draw, right, [[{ text: 'Loading conversations…', style: { dim: true } }]]);
}

/**
 * Left pane — the conversation list (§5 row anatomy), drawn through draw.list so
 * the host owns the cursor highlight + windowing; the right-flush relative time
 * rides on ListItemRow.right.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} left
 */
function renderConvoList(state, draw, left) {
  if (left.width <= 0 || left.height <= 0) return;
  /** @type {import('../../core/tui/draw.js').ListItemRow[]} */
  const items = state.convos.map((c, i) => {
    const isCursor = i === state.convCursor;
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const spans = [
      { text: isCursor ? '▸' : ' ', style: isCursor ? { fg: '36', bold: true } : undefined }, // cursor tick
      { text: c.unread ? '●' : ' ', style: c.unread ? { fg: '36', bold: true } : undefined },   // unread dot
      { text: ' ' + (c.name || 'Unknown'), style: c.unread ? { bold: true } : undefined },        // name (bold if unread)
    ];
    const snippet = (c.lastMessage || '').replace(/\s+/g, ' ').trim();
    if (snippet) spans.push({ text: '  ' + snippet, style: { dim: true } });
    const ts = relTimestamp(c.ts);
    /** @type {import('../../core/tui/draw.js').ListItemRow} */
    const item = { spans };
    if (ts) item.right = [{ text: ts, style: { dim: true } }];
    return item;
  });
  const res = draw.list(left, items, state.convCursor, state.convScroll);
  state.convScroll = res.scroll; // store adjusted scroll back (Draw.list contract)
}

/**
 * Build the thread's flat visual lines with you-vs-them grouping (§5): them =
 * cyan sender + dim right time + default body at gutter; you = green ▎ rail +
 * green You + dim right time + rail-indented default body. Day dividers between
 * date changes; 1 blank spacer between groups. The react target's header gets a
 * cyan ▸ tick.
 * @param {LiState} state @param {number} width @param {number} reactTarget index, or -1
 * @returns {import('../../core/tui/draw.js').ListItemRow[]}
 */
function buildThreadLines(state, width, reactTarget) {
  /** @type {import('../../core/tui/draw.js').ListItemRow[]} */
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
    if (idx < state.thread.length - 1) lines.push({ spans: [{ text: '' }] }); // spacer BETWEEN groups only (no trailing waste under tail-windowing)
  });
  return lines;
}

/**
 * Paint the thread body (tail-windowed) into `rect`.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} rect
 * @param {number} reactTarget
 */
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

/**
 * The lifted compose bar (§5 reply mode): a hairline, a `✎ Reply ` yellow-bold
 * label + draft + `█` block cursor (horizontal-scrolled to the tail), and a dim
 * `enter send · esc cancel` hint.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} right
 */
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
    { text: '█', style: { fg: '33' } }, // block cursor (glyph carries it in mono)
  ], right.width);
  draw.spans(hintRow, right.col, [
    { text: 'enter', style: { bold: true } }, { text: ' send', style: { dim: true } },
    { text: ' · ', style: { dim: true } },
    { text: 'esc', style: { bold: true } }, { text: ' cancel', style: { dim: true } },
  ], right.width);
}

/**
 * The react picker bar (§5 react mode): a hairline, the emoji chip row with the
 * selected chip in accent-bg + brackets (mono-safe), and a dim hint.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} right
 */
function renderReactBar(state, draw, right) {
  const hairRow = right.row + right.height - 3;
  const barRow = right.row + right.height - 2;
  const hintRow = right.row + right.height - 1;
  draw.hline(hairRow, right.col, right.col + right.width);
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [{ text: '☺ React ', style: { fg: '33', bold: true } }];
  EMOJIS.forEach((e, i) => {
    if (i === state.reactCursor) {
      spans.push({ text: ' ' });
      spans.push({ text: '[' + e + ']', style: { bg: '236', reverse: true } }); // accent-bg (color) + brackets+reverse (mono carrier, §2)
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
 * Right pane — the open thread (header + hairline + grouped body) plus the
 * compose/react bar when in a mode. Closed: a guided empty stack.
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} right
 */
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

  // Header: bold name + right-flush dim conversation time, hairline beneath.
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

// ── onKey handlers ───────────────────────────────────────────────────────────

/**
 * Open the conversation under the cursor: view it, then auto-mark it read.
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function openThread(state, host) {
  const convo = state.convos[state.convCursor];
  if (!convo) return { type: 'none' };
  if (!state.ctx) {
    host.setBanner('Not ready yet — press g to refresh', 'action');
    return { type: 'render' };
  }
  state.openUrn = convo.urn;
  state.thread = [];
  state.threadScroll = 0;
  host.setStatus('Loading thread…');

  const vc = await viewConversation({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    conversationUrn: convo.urn,
    myMemberId: state.ctx.memberId,
  });
  if (!vc.ok) {
    host.setStatus(null);
    bannerError(host, vc.error);
    return { type: 'render' };
  }
  state.thread = vc.data;

  // Auto mark read; clear the unread flag locally (optimistic) + refresh the count.
  await markConversationAsRead({ ...baseOpts(state), csrf: state.ctx.csrf, conversationUrn: convo.urn });
  convo.unread = false;

  host.setStatus(null);
  host.setError(null);
  updateUnread(state, host);
  return { type: 'render' };
}

/**
 * Send the current draft to the open conversation's recipient.
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function sendReply(state, host) {
  const text = state.draft.trim();
  if (!text) {
    state.mode = 'list';
    host.setMode(null);
    return { type: 'render' };
  }
  const convo = state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) : null;
  if (!convo || !state.ctx) {
    host.setError('No open conversation to reply to.');
    state.mode = 'list';
    host.setMode(null);
    return { type: 'render' };
  }
  // Leave compose mode before the async send so the working chip shows.
  state.mode = 'list';
  host.setMode(null);
  host.setStatus('Sending…');
  const r = await sendMessage({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    myMemberId: state.ctx.memberId,
    recipient: convo.recipientId,
    text,
    conversationUrn: state.openUrn,
  });
  if (!r.ok) {
    host.setStatus(null);
    bannerError(host, r.error); // not-connection → inline error banner over the open thread
    return { type: 'render' };
  }

  // Optimistic append, then reconcile by re-viewing the thread.
  state.thread.push({ urn: '', sender: 'You', text, ts: Date.now(), fromMe: true });
  state.draft = '';
  const vc = await viewConversation({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    conversationUrn: state.openUrn,
    myMemberId: state.ctx.memberId,
  });
  if (vc.ok) state.thread = vc.data;
  host.setError(null);
  host.setStatus('Sent');
  return { type: 'render' };
}

/**
 * React to the most recent message in the open thread with the selected emoji.
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function doReact(state, host) {
  const target = state.thread.length ? state.thread[state.thread.length - 1] : null;
  state.mode = 'list';
  host.setMode(null);
  if (!target || !target.urn || !state.ctx) {
    host.setError('No message to react to.');
    return { type: 'render' };
  }
  const emoji = EMOJIS[state.reactCursor] || EMOJIS[0];
  host.setStatus('Reacting…');
  const r = await reactToMessage({ ...baseOpts(state), csrf: state.ctx.csrf, messageUrn: target.urn, emoji });
  if (!r.ok) {
    host.setStatus(null);
    bannerError(host, r.error);
    return { type: 'render' };
  }
  host.setError(null);
  host.setStatus('Reacted ' + emoji);
  return { type: 'render' };
}

/**
 * List-mode keystrokes.
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
 */
function onKeyList(k, state, host) {
  const key = k.key;
  const ch = k.input;

  if (ch === 'q') return { type: 'quit' };
  if (ch === 'g') return { type: 'refresh' };

  if (key.downArrow || ch === 'j') {
    if (state.convos.length) state.convCursor = Math.min(state.convos.length - 1, state.convCursor + 1);
    return { type: 'render' };
  }
  if (key.upArrow || ch === 'k') {
    state.convCursor = Math.max(0, state.convCursor - 1);
    return { type: 'render' };
  }
  if (key.return) return openThread(state, host);
  if (ch === 'r') {
    if (!state.openUrn) {
      host.setBanner('Open a conversation first', 'action');
      return { type: 'render' };
    }
    state.mode = 'reply';
    state.draft = '';
    host.setMode('compose');
    host.setError(null);
    return { type: 'render' };
  }
  if (ch === 'e') {
    if (!state.openUrn || state.thread.length === 0) {
      host.setBanner('Open a conversation first', 'action');
      return { type: 'render' };
    }
    state.mode = 'react';
    state.reactCursor = 0;
    host.setMode('react');
    host.setError(null);
    return { type: 'render' };
  }
  return { type: 'none' };
}

/**
 * Reply-mode keystrokes. Printable chars edit the draft; Enter sends; Esc cancels.
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
 */
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

/**
 * React-mode keystrokes. h/l or ←/→ move the chip cursor; Enter reacts; Esc cancels.
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
 */
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

/** @type {import('../../core/tui/contract.js').ViewModule<LiState>} */
const view = {
  manifest: {
    id: 'linkedin',
    title: 'LinkedIn Messages',
    description: 'Inbox — read, reply, react',
    refreshMs: 30000,
    keymap: [
      { keys: 'j/k', label: 'move' },
      { keys: 'enter', label: 'open' },
      { keys: 'r', label: 'reply' },
      { keys: 'e', label: 'react' },
      { keys: 'g', label: 'refresh' },
      { keys: 'q', label: 'quit' },
    ],
  },

  /**
   * Build initial state. Cheap + synchronous — NO slow fetch (the host paints the
   * loading skeleton, then calls refresh()).
   * @param {import('../../core/tui/contract.js').ViewHost} host
   * @returns {LiState}
   */
  init(host) {
    const opts = host.options || {};
    return {
      ctx: null,
      target: opts.target || null,
      port: opts.port || undefined,
      convos: [],
      convCursor: 0,
      convScroll: 0,
      openUrn: null,
      thread: [],
      threadScroll: 0,
      mode: 'list',
      draft: '',
      reactCursor: 0,
      lastFetch: 0,
      recovery: null,
      loginTabOpened: false,
    };
  },

  refresh,

  /**
   * Paint the view. Precedence: recovery takeover → loading skeleton → empty
   * reward → the two-pane inbox.
   * @param {LiState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
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
  },

  /**
   * One keystroke → next action. Dispatches by mode.
   * @param {import('../../core/tui/contract.js').ViewKey} k
   * @param {LiState} state @param {import('../../core/tui/contract.js').ViewHost} host
   * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
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
   * the guided recovery panel + the host's current banner (threaded via ctx) so
   * the static path shows guidance, not a blank screen.
   * @param {LiState} state
   * @param {import('../../core/tui/contract.js').DumpContext} [ctx]
   * @returns {string}
   */
  dump(state, ctx) {
    const banner = ctx && ctx.banner ? ctx.banner : null;
    const sigil = (lvl) => (lvl === 'error' ? '✗' : lvl === 'action' ? '▸' : 'ℹ');
    /** @type {string[]} */
    const lines = [];
    let n = 0;
    for (const c of state.convos) if (c.unread) n++;
    lines.push('LinkedIn Messages' + (n ? ` · ${n} unread` : ''), '');

    if (state.recovery) {
      const r = state.recovery;
      lines.push(r.headline);
      for (const e of toLinesArr(r.explanation)) if (e) lines.push('  ' + e);
      if (r.nextStep) lines.push('  → ' + r.nextStep);
      if (banner) lines.push('  ' + sigil(banner.level) + ' ' + banner.msg);
      return lines.join('\n');
    }

    if (state.convos.length === 0) {
      if (banner) lines.push(sigil(banner.level) + ' ' + banner.msg);
      else lines.push(state.lastFetch === 0 ? '(loading…)' : '✓ All caught up — no conversations.');
    } else {
      for (const c of sortConvos(state.convos)) {
        const badge = c.unread ? '●' : ' ';
        const snip = truncate((c.lastMessage || '').replace(/\s+/g, ' ').trim(), 56);
        lines.push(`[${badge}] ${padEnd(c.name || 'Unknown', 20)} ${padEnd(snip, 56)} ${relTimestamp(c.ts)}`);
      }
    }

    if (state.openUrn && state.thread.length) {
      const convo = state.convos.find((c) => c.urn === state.openUrn);
      lines.push('', `— ${convo ? convo.name : state.openUrn} —`);
      for (const m of state.thread) {
        const who = m.fromMe ? 'You' : m.sender || 'Them';
        lines.push(`${who}: ${(m.text || '').replace(/\s+/g, ' ').trim()}`);
      }
    }

    if (banner && state.convos.length) lines.push('', sigil(banner.level) + ' ' + banner.msg);
    return lines.join('\n');
  },
};

export default view;
