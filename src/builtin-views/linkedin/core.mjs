// @ts-check
/**
 * LinkedIn Messages — the PORTABLE CORE of the crtr `linkedin` view (manifest ·
 * init · sources · commands · intents). One core renders in BOTH targets: the
 * tmux TUI (`crtr view run linkedin`, via `tui.mjs`) and the React+Tailwind web
 * page (`crtr view serve linkedin`, via `web.jsx`).
 *
 * Runs in BOTH Node and the browser, so it imports NOTHING — no `node:*`, no
 * crtr. The data layer is expressed as transport-agnostic `Source`
 * (reads) and `Command` (writes) descriptors: the core describes WHAT to run
 * (`request()` → a SourceRequest hitting the `capture` CLI), the host's
 * Transport runs it (local `execFile` for the TUI, the HTTP bridge for web), and
 * the pure `parse()` turns bytes → typed data | a typed `SourceError`.
 *
 * THE RECOVERY MACHINE LIVES HERE, ONCE. The discover→auth→settle state machine
 * is a single implementation in the `refresh` intent, shared by both the
 * linkedin view and the inbox view (which imports these descriptors). Every
 * client failure is classified to a typed `SourceError` whose `display` payload
 * BOTH presenters render VERBATIM — they map only `display.level` → glyph/hue,
 * never branch on `kind`. The view never re-derives error copy.
 *
 * NOTHING throws. Sources/commands return a `Result<T>`; the recovery machine
 * maps a blocking error to a guided takeover panel and degrades gracefully.
 *
 * @module linkedin/core
 */

/**
 * @typedef {import('../../core/view/contract.js').SourceError} SourceError
 * @typedef {import('../../core/view/contract.js').RawResponse} RawResponse
 * @typedef {import('../../core/view/contract.js').IntentCtx<LiState>} Ctx
 */

/**
 * Auth context read once from the page session via the context source.
 * @typedef {Object} LiContext
 * @property {string} csrf      CSRF token (`"ajax:<digits>"`).
 * @property {string} memberId  Current user member ID (`ACo…`).
 */
/**
 * One inbox conversation.
 * @typedef {Object} Conversation
 * @property {string}  urn
 * @property {string}  name
 * @property {string}  lastMessage
 * @property {boolean} unread
 * @property {number}  ts            epoch ms (0 if unknown)
 * @property {string}  recipientId
 */
/**
 * One message in a thread.
 * @typedef {Object} Message
 * @property {string}  urn
 * @property {string}  sender
 * @property {string}  text
 * @property {number}  ts
 * @property {boolean} fromMe
 */
/**
 * The active guided-recovery panel (full-content takeover). `display` is the
 * typed SourceError display rendered VERBATIM by both presenters; `spinner`
 * marks an auto-progress branch (animated glyph + elapsed counter).
 * @typedef {Object} Recovery
 * @property {SourceError['display']} display
 * @property {boolean} spinner
 * @property {number} [startedAt]   Epoch ms the auto-progress began.
 */
/**
 * The view's immutable state (the core owns it; intents replace it via ctx.set).
 * @typedef {Object} LiState
 * @property {LiContext|null} auth       Cached after the first context read.
 * @property {string|null} target        Discovered/opened CDP tab id (or options.target).
 * @property {string|undefined} port     options.port passthrough.
 * @property {Conversation[]} convos     Inbox, sorted unread-first then newest.
 * @property {number} convCursor
 * @property {number} convScroll
 * @property {string|null} openUrn       URN of the open conversation.
 * @property {Message[]} thread
 * @property {number} threadScroll
 * @property {'list'|'reply'|'react'} mode
 * @property {string} draft
 * @property {number} reactCursor
 * @property {number} lastFetch
 * @property {Recovery|null} recovery
 * @property {boolean} loginTabOpened    Once-per-episode login-tab gate; reset on ready.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Fixed emoji set for the react picker. */
export const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/** How many conversations to request per refresh. */
const CONVO_COUNT = 25;

/** Settle-poll bounds: retry readiness up to N times, spaced ~MS, after an auto
 *  open/navigate — a hard ceiling so the flow never spins forever. */
const SETTLE_MAX = 5;
const SETTLE_INTERVAL_MS = 1200;

/** ClientError kinds that waiting can't fix — stop the settle-poll and guide. */
const HARD_STOP = new Set(['no-cdp', 'not-logged-in', 'capture-not-dev', 'capture-missing']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The LinkedIn inbox URL the recovery flow opens / navigates to. */
const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Result helpers (inlined — the core imports nothing) ───────────────────────

/** @template T @param {T} data @returns {{ok:true, data:T}} */
function ok(data) {
  return { ok: true, data };
}
/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) {
  return { ok: false, error };
}

// ── Pure shared utilities (imported by tui.mjs / text.mjs) ────────────────────

/** @param {string} s @param {number} n @returns {string} */
export function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

/** @param {string} s @param {number} n @returns {string} */
export function padEnd(s, n) {
  const str = String(s == null ? '' : s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

/**
 * Relative-timestamp ladder, max ~5 cols: now / {m}m / {h}h / {d}d / `Mon D`
 * (this year) / `Mon ʼYY` (prior year).
 * @param {number} ts epoch ms (0 ⇒ '')
 * @param {number} [now]
 * @returns {string}
 */
export function relTimestamp(ts, now = Date.now()) {
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

/**
 * Sort conversations unread-first, then newest (ts desc). Non-mutating.
 * @param {Conversation[]} convos @returns {Conversation[]}
 */
export function sortConvos(convos) {
  return convos.slice().sort((a, b) => {
    if (!!a.unread !== !!b.unread) return a.unread ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

/** The open conversation for the current state, or null. @param {LiState} state */
export function openConvo(state) {
  return state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) || null : null;
}

// ── capture command construction (pure; runs anywhere) ────────────────────────

/**
 * Serialize a JS arg object as a literal safe to splice into the exec code
 * string. JSON is a near-subset of JS object-literal syntax; additionally escape
 * U+2028/U+2029 so a pasted reply can't break the splice.
 * @param {Record<string, unknown>} obj @returns {string}
 */
function jsLiteral(obj) {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build a `capture exec` SourceRequest for a vault-lib call. `libArgs === null`
 * emits a no-arg call (getContext).
 * @param {string} fnName
 * @param {Record<string, unknown> | null} libArgs
 * @param {{target?:string, port?:string}} [opts]
 * @returns {import('../../core/view/contract.js').SourceRequest}
 */
function execReq(fnName, libArgs, opts = {}) {
  const call = libArgs === null ? `${fnName}()` : `${fnName}(${jsLiteral(libArgs)})`;
  const code = `import {${fnName}} from 'libs/linkedin'; return await ${call}`;
  const args = ['exec', code];
  if (opts.target) args.push('--target', String(opts.target));
  if (opts.port != null && opts.port !== '') args.push('--port', String(opts.port));
  return { kind: 'exec', bin: 'capture', args };
}

/** `capture list` (tab discovery; no CDP target). @param {{port?:string}} [opts] */
function listReq(opts = {}) {
  const args = ['list'];
  if (opts.port != null && opts.port !== '') args.push('--port', String(opts.port));
  return /** @type {import('../../core/view/contract.js').SourceRequest} */ ({ kind: 'exec', bin: 'capture', args });
}

/** `capture open <url>` (open/reuse a tab). @param {{port?:string}} [opts] */
function openReq(opts = {}) {
  const args = ['open', MESSAGING_URL];
  if (opts.port != null && opts.port !== '') args.push('--port', String(opts.port));
  return /** @type {import('../../core/view/contract.js').SourceRequest} */ ({ kind: 'exec', bin: 'capture', args });
}

/** `capture navigate <url> --target <id>` (drive an existing tab). */
function navReq(opts = {}) {
  const args = ['navigate', MESSAGING_URL];
  if (opts.target) args.push('--target', String(opts.target));
  if (opts.port != null && opts.port !== '') args.push('--port', String(opts.port));
  return /** @type {import('../../core/view/contract.js').SourceRequest} */ ({ kind: 'exec', bin: 'capture', args });
}

// ── Typed SourceError displays (the `display`/`kind` split) ────────────────────
//
// The canonical panel copy per error kind. BOTH presenters render `display`
// VERBATIM and map only `display.level` → glyph/hue. The recovery machine reads
// the parallel `recoveryPlan` (below) for BEHAVIOR (auto-fix / keep-content /
// banner) — that is core-internal and never reaches a presenter.

/** @type {Record<string, SourceError['display']>} */
const DISPLAY = {
  'no-cdp': {
    headline: 'No debuggable browser',
    explanation: 'crtr drives a browser over CDP and none is running.',
    nextStep: 'Launch Arc, or Chrome with --remote-debugging-port=9222, then press g',
    level: 'error', blocking: true,
  },
  'capture-missing': {
    headline: 'capture not found',
    explanation: 'crtr drives the browser through the capture CLI, which is not on PATH.',
    nextStep: 'Install capture (or add it to PATH), then press g',
    level: 'error', blocking: true,
  },
  'capture-not-dev': {
    headline: 'Browser bridge unavailable',
    explanation: 'This view needs a capture dev checkout (vault/ + esbuild).',
    nextStep: '', level: 'error', blocking: true,
  },
  'not-logged-in': {
    headline: 'Log in to continue',
    explanation: 'LinkedIn needs a sign-in in the browser.',
    nextStep: 'Log in in the opened tab, then press g',
    level: 'action', blocking: true,
  },
  'no-tab': {
    headline: 'Opening LinkedIn…',
    explanation: 'No messaging tab was open — opening one and waiting for it to load.',
    nextStep: '', level: 'action', blocking: true,
  },
  'not-messaging': {
    headline: 'Opening your inbox…',
    explanation: 'Found LinkedIn on another page — switching it to Messages.',
    nextStep: '', level: 'action', blocking: true,
  },
  'rate-limited': {
    headline: 'LinkedIn is throttling',
    explanation: 'Too many requests — waiting before trying again.',
    nextStep: 'Press g to retry',
    level: 'info', blocking: false,
  },
  'not-connection': {
    headline: 'Not a 1st-degree connection',
    explanation: 'LinkedIn only allows messaging 1st-degree connections.',
    nextStep: '', level: 'error', blocking: false,
  },
};

/** @param {string} message @returns {SourceError['display']} */
function genericDisplay(message) {
  return {
    headline: 'Something went wrong',
    explanation: message || 'Unknown error.',
    nextStep: 'Press g to retry.',
    level: 'error', blocking: true,
  };
}

/**
 * The recovery BEHAVIOR plan per error kind (core-internal, never a presenter
 * concern): which auto-fix to drive, whether to keep last-known content, and the
 * short banner text + level the chrome should raise alongside the panel.
 * @param {string} kind
 * @returns {{auto?:'open'|'navigate', keepContent?:boolean, inline?:boolean, banner?:string, bannerLevel?:import('../../core/view/contract.js').BannerLevel}}
 */
function recoveryPlan(kind) {
  switch (kind) {
    case 'no-tab': return { auto: 'open' };
    case 'not-messaging': return { auto: 'navigate' };
    case 'not-logged-in': return { banner: 'Log in in the opened tab, then press g', bannerLevel: 'action' };
    case 'no-cdp': return { banner: 'No debuggable browser — launch one, then press g', bannerLevel: 'error' };
    case 'capture-missing': return { banner: 'capture not found — install it, then press g', bannerLevel: 'error' };
    case 'capture-not-dev': return { banner: 'Browser bridge unavailable — capture dev checkout required', bannerLevel: 'error' };
    case 'rate-limited': return { keepContent: true, banner: 'LinkedIn is throttling — waiting, then retry with g', bannerLevel: 'info' };
    case 'not-connection': return { inline: true, banner: 'Can only message 1st-degree connections', bannerLevel: 'error' };
    default: return {};
  }
}

// ── capture stderr → typed SourceError (the single classify) ──────────────────

/** Pull a human message out of capture stderr. @param {string} stderr @returns {string} */
function extractMessage(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i])) return lines[i].replace(/^ERROR:\s*/i, '').trim();
  }
  if (lines.length) return lines[lines.length - 1];
  return 'capture exec failed';
}

/**
 * Map a failed `capture` invocation (transport failure OR non-zero exit) to a
 * typed {@link SourceError}. This is the single error classifier — every source
 * and command parse routes failures through here.
 * @param {RawResponse} raw @returns {SourceError}
 */
export function classify(raw) {
  // Transport-level failure: the binary could not be spawned.
  if (!raw.ok) {
    const s = String(raw.stderr || '');
    if (/command not found|ENOENT/i.test(s)) return { kind: 'capture-missing', display: DISPLAY['capture-missing'] };
    return { kind: 'error', display: genericDisplay(extractMessage(s)) };
  }
  const s = String(raw.stderr || '');
  if (/No browser with CDP found/i.test(s)) return { kind: 'no-cdp', display: DISPLAY['no-cdp'] };
  // A dead/unreachable debugger port surfaces as a raw connection failure.
  if (/fetch failed/i.test(s) || /failed to fetch/i.test(s) || /ECONNREFUSED/i.test(s)) {
    return { kind: 'no-cdp', display: DISPLAY['no-cdp'] };
  }
  if (/No tab found/i.test(s)) return { kind: 'no-tab', display: DISPLAY['no-tab'] };
  if (/Unauthenticated/i.test(s)) return { kind: 'not-logged-in', display: DISPLAY['not-logged-in'] };
  if (/Messaging queryId not found/i.test(s) || /Navigate to \/messaging\//i.test(s)) {
    return { kind: 'not-messaging', display: DISPLAY['not-messaging'] };
  }
  if (/RateLimited/i.test(s) || /\b429\b/.test(s)) return { kind: 'rate-limited', display: DISPLAY['rate-limited'] };
  if (/must be a 1st-degree connection/i.test(s)) return { kind: 'not-connection', display: DISPLAY['not-connection'] };
  if (/DEV_ONLY_MSG/i.test(s)) return { kind: 'capture-not-dev', display: DISPLAY['capture-not-dev'] };
  return { kind: 'error', display: genericDisplay(extractMessage(s)) };
}

/** Parse capture stdout JSON; returns the value or a typed error. @param {RawResponse} raw */
function parseJson(raw) {
  const out = String(raw.stdout || '').trim();
  if (out === '') return ok(null);
  try {
    return ok(JSON.parse(out));
  } catch {
    return fail({ kind: 'error', display: genericDisplay(`could not parse capture output as JSON: ${truncate(out, 300)}`) });
  }
}

// ── Field mappers (pure) ──────────────────────────────────────────────────────

/** @param {unknown} iso @returns {number} */
function parseTs(iso) {
  if (typeof iso !== 'string' || iso === '') return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** @param {any} c @returns {Conversation} */
export function toConversation(c) {
  const o = c || {};
  const participants = Array.isArray(o.participants) ? o.participants : [];
  const p0 = participants[0] || {};
  const names = participants.map((/** @type {any} */ p) => p && p.name).filter(Boolean);
  const name = o.title || p0.name || (names.length ? names.join(', ') : 'Unknown');
  return {
    urn: typeof o.conversationUrn === 'string' ? o.conversationUrn : '',
    name,
    lastMessage: typeof o.lastMessage === 'string' ? o.lastMessage : '',
    unread: typeof o.unreadCount === 'number' ? o.unreadCount > 0 : false,
    ts: parseTs(o.lastActivityAt),
    recipientId: typeof p0.memberId === 'string' ? p0.memberId : '',
  };
}

/**
 * Map a raw vault message. `fromMe` cannot be resolved in a pure `parse` (it
 * needs the caller's memberId), so we keep the raw `fromMemberId` and resolve
 * `fromMe` in the intent via {@link applyFromMe}.
 * @param {any} m @returns {Message & {fromMemberId:string}}
 */
function toMessage(m) {
  const o = m || {};
  return {
    urn: typeof o.messageUrn === 'string' ? o.messageUrn : '',
    sender: typeof o.fromName === 'string' ? o.fromName : '',
    text: typeof o.text === 'string' ? o.text : '',
    ts: parseTs(o.sentAt),
    fromMe: false,
    fromMemberId: typeof o.fromMemberId === 'string' ? o.fromMemberId : '',
  };
}

/**
 * Resolve `fromMe` against the caller's member id (the step `parse` can't do).
 * @param {Array<Message & {fromMemberId?:string}>} msgs @param {string} myMemberId @returns {Message[]}
 */
export function applyFromMe(msgs, myMemberId) {
  return msgs.map((m) => ({ urn: m.urn, sender: m.sender, text: m.text, ts: m.ts, fromMe: !!myMemberId && m.fromMemberId === myMemberId }));
}

/** Pure message-list parse (fromMe unresolved). @param {RawResponse} raw */
function parseMessages(raw) {
  if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw));
  const j = parseJson(raw);
  if (!j.ok) return j;
  const arr = j.data && Array.isArray(j.data.messages) ? j.data.messages : [];
  return ok(arr.map(toMessage));
}

/** @param {string} url @returns {boolean} */
function isLinkedInUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'linkedin.com' || h.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

// ── Sources (reads): request descriptor + pure parse ──────────────────────────

/** @type {import('../../core/view/contract.js').Source<string, {port?:string}>} */
export const discoverTabSource = {
  id: 'li-discover-tab',
  request: (a) => listReq(a),
  parse: (raw) => {
    if (!raw.ok) return fail(classify(raw));
    if (raw.exitCode !== 0) return fail(classify(raw));
    let tabs;
    try {
      tabs = JSON.parse(String(raw.stdout || '').trim() || '[]');
    } catch {
      return fail({ kind: 'error', display: genericDisplay(`could not parse capture list output: ${truncate(raw.stdout, 300)}`) });
    }
    if (!Array.isArray(tabs)) return fail({ kind: 'no-tab', display: DISPLAY['no-tab'] });
    const linkedin = tabs.filter((t) => t && typeof t.url === 'string' && isLinkedInUrl(t.url));
    const messaging = linkedin.find((t) => /\/messaging\//i.test(t.url));
    const chosen = messaging || linkedin[0];
    if (chosen && chosen.id) return ok(String(chosen.id));
    return fail({ kind: 'no-tab', display: DISPLAY['no-tab'] });
  },
};

/** @type {import('../../core/view/contract.js').Source<LiContext, {target?:string, port?:string}>} */
export const contextSource = {
  id: 'li-context',
  request: (a) => execReq('getContext', null, a),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw));
    const j = parseJson(raw);
    if (!j.ok) return j;
    const d = j.data || {};
    if (!d.csrf || !d.memberId) return fail({ kind: 'error', display: genericDisplay('getContext() returned no csrf/memberId') });
    return ok({ csrf: String(d.csrf), memberId: String(d.memberId) });
  },
};

/** @type {import('../../core/view/contract.js').Source<Conversation[], {target?:string, port?:string, csrf:string, memberId:string, count:number}>} */
export const conversationsSource = {
  id: 'li-conversations',
  request: (a) => execReq('listConversations', { count: a.count, csrf: a.csrf, memberId: a.memberId }, a),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw));
    const j = parseJson(raw);
    if (!j.ok) return j;
    const arr = j.data && Array.isArray(j.data.conversations) ? j.data.conversations : [];
    return ok(arr.map(toConversation));
  },
};

// ── Commands (writes): same {request, parse}, intent-invoked ──────────────────

/** @type {import('../../core/view/contract.js').Command<string, {port?:string}>} */
export const openTabCommand = {
  id: 'li-open-tab',
  request: (a) => openReq(a),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw));
    const j = parseJson(raw);
    if (!j.ok) return j;
    if (j.data && j.data.id) return ok(String(j.data.id));
    return fail({ kind: 'error', display: genericDisplay('capture open returned no tab id') });
  },
};

/** @type {import('../../core/view/contract.js').Command<void, {target?:string, port?:string}>} */
export const navigateCommand = {
  id: 'li-navigate',
  request: (a) => navReq(a),
  parse: (raw) => (raw.ok && raw.exitCode === 0 ? ok(undefined) : fail(classify(raw))),
};

/** @type {import('../../core/view/contract.js').Command<Array<Message & {fromMemberId:string}>, {target?:string, port?:string, csrf:string, conversationUrn:string}>} */
export const viewThreadCommand = {
  id: 'li-view-thread',
  request: (a) => execReq('viewConversation', { csrf: a.csrf, conversationUrn: a.conversationUrn }, a),
  parse: parseMessages,
};

/** @type {import('../../core/view/contract.js').Command<void, {target?:string, port?:string, csrf:string, conversationUrn:string}>} */
const markReadCommand = {
  id: 'li-mark-read',
  request: (a) => execReq('markConversationAsRead', { csrf: a.csrf, conversationUrn: a.conversationUrn }, a),
  parse: (raw) => (raw.ok && raw.exitCode === 0 ? ok(undefined) : fail(classify(raw))),
};

/** @type {import('../../core/view/contract.js').Command<void, {target?:string, port?:string, csrf:string, myMemberId:string, recipient:string, text:string, conversationUrn?:string}>} */
export const sendMessageCommand = {
  id: 'li-send',
  request: (a) => {
    /** @type {Record<string, unknown>} */
    const libArgs = { csrf: a.csrf, myMemberId: a.myMemberId, recipient: a.recipient, text: a.text };
    if (a.conversationUrn) libArgs.conversationUrn = a.conversationUrn;
    return execReq('sendMessage', libArgs, a);
  },
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw)); // incl. 422 → not-connection
    const j = parseJson(raw);
    if (!j.ok) return j;
    const body = j.data || {};
    if (body.success === false) {
      const msg = typeof body.error === 'string' ? body.error : 'send failed';
      if (/1st-degree connection/i.test(msg)) return fail({ kind: 'not-connection', display: DISPLAY['not-connection'] });
      return fail({ kind: 'error', display: genericDisplay(msg) });
    }
    return ok(undefined);
  },
};

/** @type {import('../../core/view/contract.js').Command<void, {target?:string, port?:string, csrf:string, messageUrn:string, emoji:string}>} */
export const reactCommand = {
  id: 'li-react',
  request: (a) => execReq('reactToMessage', { csrf: a.csrf, messageUrn: a.messageUrn, emoji: a.emoji }, a),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(classify(raw));
    const j = parseJson(raw);
    if (!j.ok) return j;
    if (j.data && j.data.success === false) return fail({ kind: 'error', display: genericDisplay('LinkedIn rejected the reaction') });
    return ok(undefined);
  },
};

// ── The recovery machine (ONE implementation) ─────────────────────────────────

/** @param {LiState} s @returns {{target?:string, port?:string}} */
function baseOpts(s) {
  return { target: s.target || undefined, port: s.port };
}

/**
 * One readiness attempt: discover the tab (unless known), read auth context
 * once, list conversations, reload the open thread if any. Returns the gathered
 * data or the first SourceError — never throws.
 * @param {Ctx} ctx
 * @returns {Promise<{ok:true, data:{target:string, auth:LiContext, convos:Conversation[], thread:Message[]}} | {ok:false, error:SourceError}>}
 */
async function attemptLoad(ctx) {
  const s = ctx.state;
  let target = s.target || '';
  let auth = s.auth;
  const port = s.port;

  if (!target) {
    const r = await ctx.resolve(discoverTabSource, { port });
    if (!r.ok) return r;
    target = r.data;
  }
  if (!auth) {
    const r = await ctx.resolve(contextSource, { target, port });
    if (!r.ok) return r;
    auth = r.data;
  }
  const lc = await ctx.resolve(conversationsSource, { target, port, csrf: auth.csrf, memberId: auth.memberId, count: CONVO_COUNT });
  if (!lc.ok) return lc;
  const convos = sortConvos(lc.data);

  let thread = s.thread;
  if (s.openUrn) {
    const vc = await ctx.execute(viewThreadCommand, { target, port, csrf: auth.csrf, conversationUrn: s.openUrn });
    if (vc.ok) thread = applyFromMe(vc.data, auth.memberId); // a thread-only failure is non-fatal
  }
  return { ok: true, data: { target, auth, convos, thread } };
}

/**
 * Mark the view ready: persist the loaded data, clear recovery + banner, refresh
 * the unread subtitle, stamp lastFetch, reset the login-tab gate.
 * @param {Ctx} ctx @param {{target:string, auth:LiContext, convos:Conversation[], thread:Message[]}} data
 */
function onReady(ctx, data) {
  ctx.set((s) => {
    const convCursor = s.convCursor >= data.convos.length ? Math.max(0, data.convos.length - 1) : s.convCursor;
    return { ...s, target: data.target, auth: data.auth, convos: data.convos, thread: data.thread, convCursor, recovery: null, loginTabOpened: false, lastFetch: Date.now() };
  });
  ctx.signal.setStatus(null);
  ctx.signal.clearBanner();
  if (ctx.state.mode === 'list') ctx.signal.setMode(null);
  updateUnread(ctx);
}

/** Drive the live "N unread" title subtitle. @param {Ctx} ctx */
function updateUnread(ctx) {
  let n = 0;
  for (const c of ctx.state.convos) if (c.unread) n++;
  ctx.signal.setSubtitle(n > 0 ? `${n} unread` : null);
}

/**
 * Apply a guided (non-auto) recovery: set (or clear) the panel + the banner. An
 * `inline` error and a `keepContent` error with a populated inbox keep the last-
 * known content instead of taking over.
 * @param {Ctx} ctx @param {SourceError} error
 */
function applyGuided(ctx, error) {
  ctx.signal.setStatus(null);
  ctx.signal.setMode(null);
  const plan = recoveryPlan(error.kind);
  if (plan.inline || (plan.keepContent && ctx.state.convos.length)) {
    ctx.set((s) => ({ ...s, recovery: null }));
  } else {
    ctx.set((s) => ({ ...s, recovery: { display: error.display, spinner: false } }));
  }
  if (plan.banner) ctx.signal.setBanner(plan.banner, plan.bannerLevel || 'error');
  else ctx.signal.clearBanner();
}

/**
 * Bounded settle-poll after an auto open/navigate: retry readiness up to
 * SETTLE_MAX times spaced SETTLE_INTERVAL_MS, narrating elapsed seconds. Ready →
 * onReady. Hard-stop error → guided. Exhaustion → an action banner over the panel
 * (no infinite spin).
 * @param {Ctx} ctx
 */
async function settlePoll(ctx) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    const rec = ctx.state.recovery;
    const secs = rec && rec.startedAt ? Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000)) : i;
    ctx.signal.setStatus(`Loading messages… (${secs}s)`);
    const r = await attemptLoad(ctx);
    if (r.ok) {
      onReady(ctx, r.data);
      return;
    }
    if (HARD_STOP.has(r.error.kind)) {
      applyGuided(ctx, r.error);
      return;
    }
    // transient (no-tab / not-messaging / rate-limited / error) → keep polling
  }
  ctx.set((s) => ({ ...s, recovery: s.recovery ? { ...s.recovery, spinner: false } : null }));
  ctx.signal.setStatus(null);
  ctx.signal.setBanner('Still loading — press g to retry', 'action');
}

/**
 * The recovery state machine entry: auto-fix branches drive the browser
 * (open/navigate) then settle-poll; the rest fall straight to a guided panel.
 * @param {Ctx} ctx @param {SourceError} error
 */
async function recover(ctx, error) {
  const plan = recoveryPlan(error.kind);
  const port = ctx.state.port;
  if (plan.auto) {
    ctx.signal.setMode(null);
    ctx.signal.clearBanner();
    ctx.set((s) => ({ ...s, recovery: { display: error.display, spinner: true, startedAt: Date.now() } }));
    ctx.signal.setStatus(error.display.headline);
    const fix = plan.auto === 'open'
      ? await ctx.execute(openTabCommand, { port })
      : await ctx.execute(navigateCommand, { target: ctx.state.target || undefined, port });
    if (!fix.ok) {
      applyGuided(ctx, fix.error);
      return;
    }
    ctx.set((s) => ({ ...s, target: plan.auto === 'open' && fix.data ? fix.data : s.target, auth: null }));
    await settlePoll(ctx);
    return;
  }
  // not-logged-in: open the messaging tab ONCE per episode so the login page is
  // visible, then STOP (logged out, /messaging/ redirects to /login, so a new
  // tab would spawn on every 30s poll). onReady resets loginTabOpened.
  if (error.kind === 'not-logged-in' && !ctx.state.loginTabOpened) {
    const o = await ctx.execute(openTabCommand, { port });
    ctx.set((s) => ({ ...s, target: o.ok && o.data ? o.data : s.target, loginTabOpened: true }));
  }
  applyGuided(ctx, error);
}

/** Set the per-action error banner from a typed SourceError (open/send/react). */
function bannerError(ctx, error) {
  const plan = recoveryPlan(error.kind);
  if (plan.banner) ctx.signal.setBanner(plan.banner, plan.bannerLevel || 'error');
  else ctx.signal.setBanner(error.display.explanation || error.display.headline, error.display.level);
}

// ── The portable core ──────────────────────────────────────────────────────────

/** @type {import('../../core/view/contract.js').ViewCore<LiState>} */
const core = {
  manifest: {
    id: 'linkedin',
    title: 'LinkedIn Messages',
    description: 'Inbox — read, reply, react',
    refreshMs: 30000,
  },

  /** Cheap + synchronous initial state — NO fetch. @returns {LiState} */
  init(opts) {
    const o = opts || {};
    return {
      auth: null,
      target: o.target || null,
      port: o.port || undefined,
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

  sources: { discoverTabSource, contextSource, conversationsSource },
  commands: { openTabCommand, navigateCommand, viewThreadCommand, markReadCommand, sendMessageCommand, reactCommand },

  intents: {
    /**
     * Fetch the inbox (and the open thread). Runs in the host's single-flight
     * lane. On failure, hands off to the ONE recovery state machine. Skips
     * auto-polls while composing/reacting so a poll can't disrupt input.
     * @param {Ctx} ctx
     */
    async refresh(ctx) {
      if (ctx.state.mode !== 'list') return;
      ctx.signal.setStatus('Loading…');
      const r = await attemptLoad(ctx);
      if (r.ok) {
        onReady(ctx, r.data);
        return;
      }
      await recover(ctx, r.error);
    },

    /** @param {Ctx} ctx */
    cursorDown: (ctx) => ctx.set((s) => ({ ...s, convCursor: s.convos.length ? Math.min(s.convos.length - 1, s.convCursor + 1) : 0 })),
    /** @param {Ctx} ctx */
    cursorUp: (ctx) => ctx.set((s) => ({ ...s, convCursor: Math.max(0, s.convCursor - 1) })),

    /**
     * Open the conversation under the cursor (or at payload index): view it, then
     * auto-mark it read.
     * @param {Ctx} ctx @param {number} [i]
     */
    async openThread(ctx, i) {
      const idx = typeof i === 'number' ? i : ctx.state.convCursor;
      const convo = ctx.state.convos[idx];
      if (!convo) return;
      if (!ctx.state.auth) {
        ctx.signal.setBanner('Not ready yet — press g to refresh', 'action');
        return;
      }
      const auth = ctx.state.auth;
      ctx.set((s) => ({ ...s, convCursor: idx, openUrn: convo.urn, thread: [], threadScroll: 0 }));
      ctx.signal.setStatus('Loading thread…');
      const vc = await ctx.execute(viewThreadCommand, { ...baseOpts(ctx.state), csrf: auth.csrf, conversationUrn: convo.urn });
      if (!vc.ok) {
        ctx.signal.setStatus(null);
        bannerError(ctx, vc.error);
        return;
      }
      ctx.set((s) => ({ ...s, thread: applyFromMe(vc.data, auth.memberId) }));
      await ctx.execute(markReadCommand, { ...baseOpts(ctx.state), csrf: auth.csrf, conversationUrn: convo.urn });
      ctx.set((s) => ({ ...s, convos: s.convos.map((c) => (c.urn === convo.urn ? { ...c, unread: false } : c)) }));
      ctx.signal.setStatus(null);
      ctx.signal.clearBanner();
      updateUnread(ctx);
    },

    /** Enter reply (compose) mode. @param {Ctx} ctx */
    startReply: (ctx) => {
      if (!ctx.state.openUrn) {
        ctx.signal.setBanner('Open a conversation first', 'action');
        return;
      }
      ctx.set((s) => ({ ...s, mode: 'reply', draft: '' }));
      ctx.signal.setMode('compose');
      ctx.signal.clearBanner();
    },
    /** The host line-editor draft (capture binding). @param {Ctx} ctx @param {string} [draft] */
    setDraft: (ctx, draft) => ctx.set((s) => ({ ...s, draft: typeof draft === 'string' ? draft : '' })),
    /** Leave reply/react mode without acting. @param {Ctx} ctx */
    cancelCompose: (ctx) => {
      ctx.set((s) => ({ ...s, mode: 'list', draft: '' }));
      ctx.signal.setMode(null);
    },

    /**
     * Send the current draft to the open conversation's recipient.
     * @param {Ctx} ctx
     */
    async submitReply(ctx) {
      const text = ctx.state.draft.trim();
      if (!text) {
        ctx.set((s) => ({ ...s, mode: 'list', draft: '' }));
        ctx.signal.setMode(null);
        return;
      }
      const convo = openConvo(ctx.state);
      const auth = ctx.state.auth;
      if (!convo || !auth) {
        ctx.signal.setBanner('No open conversation to reply to.', 'error');
        ctx.set((s) => ({ ...s, mode: 'list' }));
        ctx.signal.setMode(null);
        return;
      }
      const openUrn = ctx.state.openUrn;
      ctx.set((s) => ({ ...s, mode: 'list' }));
      ctx.signal.setMode(null);
      ctx.signal.setStatus('Sending…');
      const r = await ctx.execute(sendMessageCommand, { ...baseOpts(ctx.state), csrf: auth.csrf, myMemberId: auth.memberId, recipient: convo.recipientId, text, conversationUrn: openUrn || undefined });
      if (!r.ok) {
        ctx.signal.setStatus(null);
        bannerError(ctx, r.error); // not-connection → inline error banner over the open thread
        return;
      }
      // Optimistic append, then reconcile by re-viewing the thread.
      ctx.set((s) => ({ ...s, thread: [...s.thread, { urn: '', sender: 'You', text, ts: Date.now(), fromMe: true }], draft: '' }));
      const vc = await ctx.execute(viewThreadCommand, { ...baseOpts(ctx.state), csrf: auth.csrf, conversationUrn: openUrn || '' });
      if (vc.ok) ctx.set((s) => ({ ...s, thread: applyFromMe(vc.data, auth.memberId) }));
      ctx.signal.clearBanner();
      ctx.signal.setStatus('Sent');
    },

    /** Enter react mode. @param {Ctx} ctx */
    startReact: (ctx) => {
      if (!ctx.state.openUrn || ctx.state.thread.length === 0) {
        ctx.signal.setBanner('Open a conversation first', 'action');
        return;
      }
      ctx.set((s) => ({ ...s, mode: 'react', reactCursor: 0 }));
      ctx.signal.setMode('react');
      ctx.signal.clearBanner();
    },
    /** @param {Ctx} ctx */
    reactPrev: (ctx) => ctx.set((s) => ({ ...s, reactCursor: Math.max(0, s.reactCursor - 1) })),
    /** @param {Ctx} ctx */
    reactNext: (ctx) => ctx.set((s) => ({ ...s, reactCursor: Math.min(EMOJIS.length - 1, s.reactCursor + 1) })),
    /** @param {Ctx} ctx @param {number} [i] */
    reactPick: (ctx, i) => ctx.set((s) => ({ ...s, reactCursor: typeof i === 'number' ? Math.max(0, Math.min(EMOJIS.length - 1, i)) : s.reactCursor })),

    /**
     * React to the most recent message in the open thread with the selected emoji.
     * @param {Ctx} ctx
     */
    async submitReact(ctx) {
      const target = ctx.state.thread.length ? ctx.state.thread[ctx.state.thread.length - 1] : null;
      const auth = ctx.state.auth;
      ctx.set((s) => ({ ...s, mode: 'list' }));
      ctx.signal.setMode(null);
      if (!target || !target.urn || !auth) {
        ctx.signal.setBanner('No message to react to.', 'error');
        return;
      }
      const emoji = EMOJIS[ctx.state.reactCursor] || EMOJIS[0];
      ctx.signal.setStatus('Reacting…');
      const r = await ctx.execute(reactCommand, { ...baseOpts(ctx.state), csrf: auth.csrf, messageUrn: target.urn, emoji });
      if (!r.ok) {
        ctx.signal.setStatus(null);
        bannerError(ctx, r.error);
        return;
      }
      ctx.signal.clearBanner();
      ctx.signal.setStatus('Reacted ' + emoji);
    },

    /** @param {Ctx} ctx */
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
