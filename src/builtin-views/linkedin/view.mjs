// @ts-check
/**
 * LinkedIn Messages — the crtr `linkedin` view (Phase C, the POC ViewModule).
 *
 * Self-contained ESM. Imports its data layer from `./client.mjs` (Phase A) and
 * imports NOTHING from crtr — the host injects the `Draw` + `ViewHost` API and
 * dynamically `import()`s this module's DEFAULT EXPORT. This is the module that
 * proves the view contract end-to-end.
 *
 * Two-pane inbox: conversation list (left, unread-first) ↔ open thread (right).
 * Read, reply, and react, all paced through the host's single-flight async lane.
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
} from './client.mjs';

/** @typedef {import('./client.mjs').LiContext} LiContext */
/** @typedef {import('./client.mjs').Conversation} Conversation */
/** @typedef {import('./client.mjs').Message} Message */
/** @typedef {import('./client.mjs').ClientError} ClientError */

/**
 * The view's single mutable state object (LiState). The view owns it; hooks
 * mutate it in place. Mirrors the spec's `LiState`.
 * @typedef {Object} LiState
 * @property {LiContext|null} ctx        Cached after the first getContext().
 * @property {string|null} target        Discovered CDP tab id (or options.target).
 * @property {string|undefined} port     options.port passthrough.
 * @property {Conversation[]} convos     Inbox, sorted unread-first then newest.
 * @property {number} convCursor         Index into convos (left pane cursor).
 * @property {number} convScroll         draw.list scroll for the left pane.
 * @property {string|null} openUrn        URN of the open conversation (right pane).
 * @property {Message[]} thread          Messages of the open conversation.
 * @property {number} threadScroll       Computed top line of the thread window.
 * @property {'list'|'reply'|'react'} mode  Input mode.
 * @property {string} draft              Reply input buffer (view owns input).
 * @property {number} reactCursor        Index into EMOJIS.
 * @property {number} lastFetch          Epoch ms of the last successful refresh.
 * @property {string|null} banner        Load-time guidance text (mirrors host.setError so dump() can show it piped).
 */

/** Fixed emoji set for the react picker. */
const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/** How many conversations to request per refresh. */
const CONVO_COUNT = 25;

// ── Error → guidance banner ──────────────────────────────────────────────────

/**
 * Map a typed {@link ClientError} to the guided banner text from the spec's
 * error table. `not-connection` is normally shown inline on a failed reply, but
 * we provide a sensible default here too.
 * @param {ClientError} error
 * @returns {string}
 */
function setBanner(state, host, error) {
  const text = bannerFor(error);
  state.banner = text;
  host.setStatus(null);
  host.setError(text);
}

/**
 * Clear the load-time guidance on a successful refresh.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 */
function clearBanner(state, host) {
  state.banner = null;
  host.setError(null);
}

/**
 * Record a load-time guidance message: set the host's sticky banner AND stash it
 * in state so the non-TTY dump() can surface it (host chrome is invisible piped).
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @param {ClientError} error
 */
function bannerFor(error) {
  switch (error && error.kind) {
    case 'no-cdp':
      return 'No browser with CDP found. Open Arc, or Chrome with --remote-debugging-port=9222.';
    case 'no-tab':
      return 'No LinkedIn tab found. Open a LinkedIn tab on /messaging/.';
    case 'not-logged-in':
      return 'Not logged in. Log into LinkedIn in the browser.';
    case 'not-messaging':
      return 'Navigate the LinkedIn tab to /messaging/.';
    case 'rate-limited':
      return 'LinkedIn is throttling — wait and retry (g).';
    case 'not-connection':
      return 'Can only message 1st-degree connections';
    case 'capture-not-dev':
      return 'LinkedIn view needs a capture dev checkout (vault/ + esbuild).';
    case 'error':
      return (error && /** @type {any} */ (error).message) || 'Unknown error.';
    default:
      return 'Unknown error.';
  }
}

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

/**
 * Word-wrap text to a width (also hard-splits over-long words). Preserves
 * explicit newlines as paragraph breaks.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
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
      // Hard-split words longer than the width.
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
 * @param {{input:string, key:any}} k
 * @returns {boolean}
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

/**
 * Draw a single span clipped to a width.
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {number} row @param {number} col @param {string} text
 * @param {number} width @param {import('../../core/tui/draw.js').Style} [style]
 */
function drawClipped(draw, row, col, text, width, style) {
  if (width <= 0) return;
  draw.spans(row, col, [{ text: String(text == null ? '' : text), style }], width);
}

/**
 * Draw a line of text centered (horizontally + vertically) within a rect.
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} rect
 * @param {string} text @param {import('../../core/tui/draw.js').Style} [style]
 */
function centered(draw, rect, text, style) {
  const t = String(text == null ? '' : text);
  const row = rect.row + Math.floor(rect.height / 2);
  const col = rect.col + Math.max(0, Math.floor((rect.width - t.length) / 2));
  drawClipped(draw, row, col, t, rect.col + rect.width - col, style);
}

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} left
 */
function renderLeft(state, draw, left) {
  if (left.width <= 0 || left.height <= 0) return;
  if (state.convos.length === 0) {
    centered(draw, left, state.lastFetch === 0 ? 'Loading…' : 'No conversations', { dim: true });
    return;
  }
  /** @type {import('../../core/tui/draw.js').ListItemRow[]} */
  const items = state.convos.map((c) => {
    const badge = c.unread ? '●' : ' ';
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const spans = [
      { text: badge + ' ', style: c.unread ? { fg: '36', bold: true } : undefined }, // cyan
      { text: c.name || 'Unknown', style: c.unread ? { bold: true } : undefined },
    ];
    const snippet = (c.lastMessage || '').replace(/\s+/g, ' ').trim();
    if (snippet) spans.push({ text: '  ' + snippet, style: { dim: true } });
    return { spans };
  });
  const res = draw.list(left, items, state.convCursor, state.convScroll);
  state.convScroll = res.scroll; // store adjusted scroll back (documented Draw.list contract)
}

/**
 * @param {LiState} state
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} right
 */
function renderRight(state, draw, right) {
  if (right.width <= 0 || right.height <= 0) return;
  const openConvo = state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) : null;

  // Header
  const headerName = openConvo ? openConvo.name : state.openUrn ? 'Conversation' : 'No conversation open';
  drawClipped(draw, right.row, right.col, headerName, right.width, { bold: true });
  draw.hline(right.row + 1, right.col, right.col + right.width);

  // Reserve the bottom row for the reply input / react picker.
  const reserved = state.mode === 'reply' || state.mode === 'react' ? 1 : 0;
  const msgTop = right.row + 2;
  const msgBottom = right.row + right.height - 1 - reserved; // inclusive
  const msgHeight = msgBottom - msgTop + 1;
  const bodyRect = { row: msgTop, col: right.col, width: right.width, height: Math.max(0, msgHeight) };

  if (!state.openUrn) {
    centered(draw, bodyRect, 'Press Enter to open a conversation', { dim: true });
  } else if (state.thread.length === 0) {
    centered(draw, bodyRect, 'Loading…', { dim: true });
  } else if (msgHeight > 0) {
    // Flatten messages into visual lines, then window to the TAIL (latest).
    /** @type {import('../../core/tui/draw.js').ListItemRow[]} */
    const lines = [];
    for (const m of state.thread) {
      const who = m.fromMe ? 'You' : m.sender || 'Them';
      lines.push({ spans: [{ text: who, style: { bold: true, fg: m.fromMe ? '32' : '36' } }] }); // green / cyan
      for (const bl of wrapText(m.text || '', right.width)) {
        lines.push({ spans: [{ text: bl, style: m.fromMe ? { dim: true } : undefined }] });
      }
      lines.push({ spans: [{ text: '' }] }); // spacer between messages
    }
    const start = Math.max(0, lines.length - msgHeight);
    state.threadScroll = start;
    let r = msgTop;
    for (let i = start; i < lines.length && r <= msgBottom; i++, r++) {
      draw.spans(r, right.col, lines[i].spans, right.width);
    }
  }

  // Bottom row: reply input or react picker.
  if (state.mode === 'reply') {
    const row = right.row + right.height - 1;
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const spans = [
      { text: 'Reply: ', style: { fg: '33', bold: true } }, // yellow
      { text: state.draft },
      { text: '▌', style: { reverse: true } },
    ];
    draw.spans(row, right.col, spans, right.width);
  } else if (state.mode === 'react') {
    const row = right.row + right.height - 1;
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const spans = [{ text: 'React: ', style: { dim: true } }];
    EMOJIS.forEach((e, i) => {
      spans.push({ text: ' ' + e + ' ', style: i === state.reactCursor ? { reverse: true, bold: true } : undefined });
    });
    draw.spans(row, right.col, spans, right.width);
  }
}

// ── Refresh (data lane) ──────────────────────────────────────────────────────

/**
 * Fetch the inbox (and the open thread, if any). Runs in the host's
 * single-flight lane: on launch, on `refreshMs`, and on `{type:'refresh'}`.
 * Maps any ClientError to a guided banner instead of crashing.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  host.setStatus('Loading…');

  // 1. Discover the tab (unless one was supplied via --target).
  if (!state.target) {
    const r = await discoverTab({ port: state.port });
    if (!r.ok) {
      setBanner(state, host, r.error);
      return;
    }
    state.target = r.data;
  }

  // 2. Auth context — ONCE; cached for the session.
  if (!state.ctx) {
    const r = await getContext(baseOpts(state));
    if (!r.ok) {
      setBanner(state, host, r.error);
      return;
    }
    state.ctx = r.data;
  }

  // 3. Conversations.
  const lc = await listConversations({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    memberId: state.ctx.memberId,
    count: CONVO_COUNT,
  });
  if (!lc.ok) {
    setBanner(state, host, lc.error);
    return;
  }
  state.convos = sortConvos(lc.data);
  if (state.convCursor >= state.convos.length) {
    state.convCursor = Math.max(0, state.convos.length - 1);
  }

  // 4. Re-load the open thread, if one is open.
  if (state.openUrn) {
    const vc = await viewConversation({
      ...baseOpts(state),
      csrf: state.ctx.csrf,
      conversationUrn: state.openUrn,
      myMemberId: state.ctx.memberId,
    });
    if (vc.ok) state.thread = vc.data;
    // A thread-only failure is non-fatal; the inbox still renders.
  }

  state.lastFetch = Date.now();
  host.setStatus(null);
  clearBanner(state, host);
}

// ── onKey handlers ───────────────────────────────────────────────────────────

/**
 * Open the conversation under the cursor: view it, then auto-mark it read.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function openThread(state, host) {
  const convo = state.convos[state.convCursor];
  if (!convo) return { type: 'none' };
  if (!state.ctx) {
    host.setError('Not ready yet — press g to refresh.');
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
    host.setError(bannerFor(vc.error));
    return { type: 'render' };
  }
  state.thread = vc.data;

  // Auto mark read; clear the unread flag locally (optimistic).
  await markConversationAsRead({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    conversationUrn: convo.urn,
  });
  convo.unread = false;

  host.setStatus(null);
  host.setError(null);
  return { type: 'render' };
}

/**
 * Send the current draft to the open conversation's recipient.
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function sendReply(state, host) {
  const text = state.draft.trim();
  if (!text) {
    state.mode = 'list';
    return { type: 'render' };
  }
  const convo = state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) : null;
  if (!convo || !state.ctx) {
    host.setError('No open conversation to reply to.');
    state.mode = 'list';
    return { type: 'render' };
  }
  host.setStatus('Sending…');
  const r = await sendMessage({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    myMemberId: state.ctx.memberId,
    recipient: convo.recipientId,
    text,
    conversationUrn: state.openUrn,
  });
  host.setStatus(null);
  if (!r.ok) {
    host.setError(r.error.kind === 'not-connection'
      ? 'Can only message 1st-degree connections'
      : bannerFor(r.error));
    state.mode = 'list';
    return { type: 'render' };
  }

  // Optimistic append, then reconcile by re-viewing the thread.
  state.thread.push({ urn: '', sender: 'You', text, ts: Date.now(), fromMe: true });
  state.draft = '';
  state.mode = 'list';
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
 * (No per-message cursor exists in LiState, so the POC reacts to the latest
 * message — the most likely target.)
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<import('../../core/tui/contract.js').ViewAction>}
 */
async function doReact(state, host) {
  const target = state.thread.length ? state.thread[state.thread.length - 1] : null;
  if (!target || !target.urn || !state.ctx) {
    host.setError('No message to react to.');
    state.mode = 'list';
    return { type: 'render' };
  }
  const emoji = EMOJIS[state.reactCursor] || EMOJIS[0];
  host.setStatus('Reacting…');
  const r = await reactToMessage({
    ...baseOpts(state),
    csrf: state.ctx.csrf,
    messageUrn: target.urn,
    emoji,
  });
  host.setStatus(null);
  state.mode = 'list';
  if (!r.ok) {
    host.setError(bannerFor(r.error));
    return { type: 'render' };
  }
  host.setError(null);
  host.setStatus('Reacted ' + emoji);
  return { type: 'render' };
}

/**
 * List-mode keystrokes. Sync actions return immediately; Enter returns a Promise
 * (the host serializes it in the single-flight lane).
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
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
  if (key.return) {
    return openThread(state, host);
  }
  if (ch === 'r') {
    if (!state.openUrn) {
      host.setStatus('Open a conversation first (Enter)');
      return { type: 'render' };
    }
    state.mode = 'reply';
    state.draft = '';
    return { type: 'render' };
  }
  if (ch === 'e') {
    if (!state.openUrn || state.thread.length === 0) {
      host.setStatus('Open a conversation first (Enter)');
      return { type: 'render' };
    }
    state.mode = 'react';
    state.reactCursor = 0;
    return { type: 'render' };
  }
  return { type: 'none' };
}

/**
 * Reply-mode keystrokes. Printable chars edit the draft; Enter sends (async);
 * Esc cancels. 'q' is NOT intercepted — it types a literal q (host force-quits
 * only on Ctrl-C).
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
 */
function onKeyReply(k, state, host) {
  const key = k.key;
  if (key.escape) {
    state.mode = 'list';
    state.draft = '';
    return { type: 'render' };
  }
  if (key.return) {
    return sendReply(state, host);
  }
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
 * React-mode keystrokes. h/l or ←/→ move the emoji cursor; Enter reacts (async);
 * Esc cancels.
 * @param {import('../../core/tui/contract.js').ViewKey} k
 * @param {LiState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {import('../../core/tui/contract.js').ViewAction | Promise<import('../../core/tui/contract.js').ViewAction>}
 */
function onKeyReact(k, state, host) {
  const key = k.key;
  const ch = k.input;
  if (key.escape) {
    state.mode = 'list';
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
  if (key.return) {
    return doReact(state, host);
  }
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
   * Build initial state. Cheap + synchronous — NO slow fetch (the host paints a
   * loading state, then calls refresh()).
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
      banner: null,
    };
  },

  refresh,

  /**
   * Paint the two-pane inbox. Pure (reads state, calls draw.*); the only state
   * write is storing draw.list's adjusted scroll back, per the Draw contract.
   * @param {LiState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
    const cols = draw.columns(content, [1, 2]);
    const left = cols[0];
    const right = cols[1];
    if (left) renderLeft(state, draw, left);
    if (right) renderRight(state, draw, right);
  },

  /**
   * One keystroke → next action. Dispatches by mode. May be async (open/send/
   * react) — the host serializes async hooks in the single-flight lane.
   * @param {import('../../core/tui/contract.js').ViewKey} k
   * @param {LiState} state
   * @param {import('../../core/tui/contract.js').ViewHost} host
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
   * Plain-text snapshot for the non-TTY / piped path. No ANSI.
   * @param {LiState} state
   * @returns {string}
   */
  dump(state) {
    /** @type {string[]} */
    const lines = ['LinkedIn Messages', ''];
    if (state.convos.length === 0) {
      if (state.banner) lines.push(state.banner);
      else lines.push(state.lastFetch === 0 ? '(not loaded)' : '(no conversations)');
    } else {
      for (const c of sortConvos(state.convos)) {
        const badge = c.unread ? '●' : ' ';
        lines.push(`[${badge}] ${c.name || 'Unknown'} — ${truncate((c.lastMessage || '').replace(/\s+/g, ' ').trim(), 80)}`);
      }
    }
    if (state.openUrn && state.thread.length) {
      const convo = state.convos.find((c) => c.urn === state.openUrn);
      lines.push('', `— Thread: ${convo ? convo.name : state.openUrn} —`);
      for (const m of state.thread) {
        const who = m.fromMe ? 'You' : m.sender || 'Them';
        lines.push(`${who}: ${(m.text || '').replace(/\s+/g, ' ').trim()}`);
      }
    }
    return lines.join('\n');
  },
};

export default view;
