// @ts-check
/**
 * Combined `inbox` view — the PORTABLE CORE (manifest · init · sources ·
 * commands · intents). One core renders in BOTH targets: the tmux TUI
 * (`crtr view run inbox`, via `tui.mjs`) and the React+Tailwind web page
 * (`crtr view serve inbox`, via `web.jsx`).
 *
 * Runs in BOTH Node and the browser, so it imports nothing host-bound — no
 * `node:*`, no crtr. The LinkedIn data layer lives ONCE in the sibling
 * browser-safe `../linkedin/core.mjs` (shared `Source`/`Command` descriptors +
 * the single `classify`/`applyFromMe`), imported here rather than duplicated.
 * Gmail's data logic is inlined as transport-agnostic `Source`/`Command`
 * descriptors (`{id, request, parse}`): the core describes WHAT capture command
 * to run, the host's Transport runs it (local `execFile` for the TUI, the HTTP
 * bridge for web), and the pure `parse()` turns bytes → typed data | typed
 * `SourceError`.
 *
 * NOTHING throws. Sources return a `Result<T>`; each source owns its
 * discover→auth→settle recovery state machine, restated in the `refresh` intent
 * via `ctx.resolve`/`ctx.execute`. Partial readiness is mandatory: a down source
 * contributes zero rows + its own slim banner; every ready source's rows show.
 *
 * @module inbox/core
 */

import {
  discoverTabSource,
  contextSource,
  conversationsSource,
  openTabCommand,
  navigateCommand,
  viewThreadCommand,
  sendMessageCommand,
  reactCommand,
  applyFromMe,
} from '../linkedin/core.mjs';

/**
 * @typedef {import('../../core/view/contract.js').SourceError} SourceError
 * @typedef {import('../../core/view/contract.js').IntentCtx<InboxState>} Ctx
 */

// ── Merge currency (the shared shapes presenters read) ────────────────────────

/**
 * One left-pane row in the merged stream.
 * @typedef {Object} UnifiedRow
 * @property {string}  sourceId  'linkedin' | 'gmail'
 * @property {string}  key       Globally-unique selection id (`<src>:<id>`).
 * @property {string}  name
 * @property {string}  snippet
 * @property {boolean} unread
 * @property {number}  ts        Epoch ms (0 if unknown).
 * @property {any}     ref       Opaque source handle round-tripped to open/reply.
 */
/**
 * One message in the right-pane thread.
 * @typedef {Object} UnifiedMessage
 * @property {string}  sender
 * @property {boolean} fromMe
 * @property {string}  text
 * @property {number}  ts
 */
/**
 * Right-pane thread payload.
 * @typedef {Object} UnifiedThread
 * @property {string}  title
 * @property {string}  [subtitle]
 * @property {UnifiedMessage[]} messages
 * @property {boolean} canReply
 * @property {boolean} canReact
 */
/**
 * @typedef {Object} Conversation
 * @property {string} urn
 * @property {string} name
 * @property {string} lastMessage
 * @property {boolean} unread
 * @property {number} ts
 * @property {string} recipientId
 */
/**
 * The view's immutable state (the core owns it; intents replace it via ctx.set).
 * @typedef {Object} InboxState
 * @property {{linkedin:any, gmail:any}} subs   Per-source auth/tab substate.
 * @property {Record<string, UnifiedRow[]>} rowsBySource
 * @property {UnifiedRow[]} rows
 * @property {number} cursor
 * @property {number} scroll
 * @property {string|null} openKey
 * @property {UnifiedRow|null} openRow
 * @property {UnifiedThread|null} thread
 * @property {number} threadScroll
 * @property {'list'|'reply'|'react'} mode
 * @property {string} draft
 * @property {number} reactCursor
 * @property {'all'|'linkedin'|'gmail'} filter
 * @property {Record<string, SourceError|null>} banners
 * @property {Record<string, boolean>} ready
 * @property {number} lastFetch
 */

// ── Result helpers (inlined — the core imports nothing) ───────────────────────

/** @template T @param {T} [data] @returns {{ok:true, data:any}} */
function ok(data) {
  return { ok: true, data };
}
/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) {
  return { ok: false, error };
}

// ── Presenter-facing constants ────────────────────────────────────────────────

/** Fixed emoji set for the react picker. */
export const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/** Severity rank for choosing one banner / one guided panel across sources. */
const LEVEL_RANK = { error: 3, action: 2, info: 1 };

/** Ordered source metadata (LinkedIn first). The presenters read this. */
export const SOURCES_META = [
  { id: 'linkedin', label: 'LinkedIn', badge: { glyph: 'in', fg: '36' }, connectKey: 'L' },
  { id: 'gmail', label: 'Gmail', badge: { glyph: '@', fg: '31' }, connectKey: 'G' },
];

/** id → meta, for badge/label lookup. */
const SOURCE_BY_ID = {};
for (const m of SOURCES_META) SOURCE_BY_ID[m.id] = m;

/** @param {string} id @returns {{glyph:string, fg:string}} */
export function badgeFor(id) {
  const m = SOURCE_BY_ID[id];
  return (m && m.badge) || { glyph: '?', fg: '37' };
}

/** @param {string} id @returns {string} */
function labelFor(id) {
  const m = SOURCE_BY_ID[id];
  return (m && m.label) || id;
}

// ── Pure presenter helpers (shared by tui + web + text) ───────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
 * Relative-timestamp ladder, max ~5 cols: now / {m}m / {h}h / {d}d /
 * `Mon D` (this year) / `Mon ʼYY` (prior year).
 * @param {number} ts epoch ms (0 ⇒ '') @param {number} [now] @returns {string}
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

/** Calendar-day key for day-divider grouping. @param {number} ts @returns {string} */
export function dayKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Human day label for the divider: Today / Yesterday / Mon D / Mon D, YYYY. */
export function dayLabel(ts, now = Date.now()) {
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
 * Prefix a source's banner with its label — `Gmail: log in, then press g`. Stays
 * robust if a source baked the label in (no double-prefix).
 * @param {string} label @param {string} banner @returns {string}
 */
export function labeled(label, banner) {
  const b = String(banner == null ? '' : banner);
  const lead = `${label}:`.toLowerCase();
  return b.toLowerCase().startsWith(lead) ? b : `${label}: ${b}`;
}

/** Sum unread across READY sources (independent of the visible filter). */
export function unreadCount(state) {
  let n = 0;
  for (const m of SOURCES_META) {
    if (!state.ready[m.id]) continue;
    for (const r of state.rowsBySource[m.id] || []) if (r.unread) n++;
  }
  return n;
}

/**
 * Pick the most-severe down-source display for the no-rows guided panel
 * (blocking states win decisively).
 * @param {InboxState} state @returns {{label:string, d:any}|null}
 */
export function pickGuided(state) {
  let best = null;
  let bestScore = -1;
  for (const m of SOURCES_META) {
    const e = state.banners[m.id];
    if (!e || !e.display) continue;
    const score = (LEVEL_RANK[e.display.level] || 0) + (e.display.blocking ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { label: m.label, d: e.display };
    }
  }
  return best;
}

// ── Shared capture plumbing (exec code strings + classifiers) ─────────────────

const GMAIL_URL = 'https://mail.google.com';
const CONVO_COUNT = 25;
const INBOX_COUNT = 25;
const SETTLE_MAX = 5;
const SETTLE_INTERVAL_MS = 1200;
/** Error kinds that waiting can't fix — stop the settle-poll and guide. */
const HARD_STOP = new Set(['no-cdp', 'not-logged-in', 'capture-not-dev', 'capture-missing']);

/** Pure: setTimeout exists in both Node and the browser. @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialize a JS arg object as a literal safe to splice into the exec code
 * string (escape U+2028/U+2029).
 * @param {Record<string, unknown>} obj @returns {string}
 */
function jsLiteral(obj) {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build the vault-lib exec code string. `libArgs === null` ⇒ a no-arg call.
 * @param {string} lib @param {string} fn @param {Record<string, unknown>|null} libArgs
 * @returns {string}
 */
function execCode(lib, fn, libArgs) {
  const call = libArgs === null ? `${fn}()` : `${fn}(${jsLiteral(libArgs)})`;
  return `import {${fn}} from '${lib}'; return await ${call}`;
}

/** Append --target / --port to an argv (in place). @param {string[]} argv */
function withTP(argv, target, port) {
  if (target) argv.push('--target', String(target));
  if (port != null && port !== '') argv.push('--port', String(port));
  return argv;
}

/** Append only --port. @param {string[]} argv */
function withPort(argv, port) {
  if (port != null && port !== '') argv.push('--port', String(port));
  return argv;
}

/** Parse capture stdout JSON; '' ⇒ null. @param {string} stdout */
function parseJson(stdout) {
  const out = String(stdout || '').trim();
  if (out === '') return null;
  return JSON.parse(out);
}

/**
 * Pull a human message out of capture stderr: prefer the last `ERROR:` line,
 * else the last non-empty line, else a generic fallback.
 * @param {string} stderr @returns {string}
 */
function extractErrorMessage(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i])) return lines[i].replace(/^ERROR:\s*/i, '').trim();
  }
  if (lines.length) return lines[lines.length - 1];
  return 'capture exec failed';
}

// ── SourceError helper (shared by gmail descriptors + inbox-local glue) ───────

/** @param {string} kind @param {object} display @returns {SourceError} */
function srcError(kind, display) {
  return { kind, display: /** @type {any} */ (display) };
}

// ── Gmail: classify + display ─────────────────────────────────────────────────

const DEV_ONLY_MSG =
  'This view needs a capture dev checkout (vault/ source + esbuild). Not available in the published package.';

/** @param {string} stderr @returns {{kind:string, message?:string}} */
function classifyGmail(stderr) {
  const s = String(stderr || '');
  if (/No browser with CDP found/i.test(s)) return { kind: 'no-cdp' };
  if (/fetch failed/i.test(s) || /failed to fetch/i.test(s) || /ECONNREFUSED/i.test(s)) return { kind: 'no-cdp' };
  if (/No tab found/i.test(s)) return { kind: 'no-tab' };
  if (/DEV_ONLY/i.test(s) || /dev-only feature of capture/i.test(s) || /published package/i.test(s)) {
    return { kind: 'capture-not-dev' };
  }
  if (/RateLimited/i.test(s) || /\b429\b/.test(s)) return { kind: 'rate-limited' };
  if (
    /Unauthenticated/i.test(s) ||
    /XSRF token not found/i.test(s) ||
    /GLOBALS not found/i.test(s) ||
    /may not be logged in/i.test(s) ||
    /not be logged in/i.test(s) ||
    /Not on Gmail domain/i.test(s) ||
    /Account number not found/i.test(s) ||
    /Navigate to mail\.google\.com/i.test(s)
  ) {
    return { kind: 'not-logged-in' };
  }
  return { kind: 'error', message: extractErrorMessage(s) };
}

/** @param {{kind:string, message?:string}} error @returns {SourceError} */
function toGmailSourceError(error) {
  const kind = (error && error.kind) || 'error';
  switch (kind) {
    case 'no-cdp':
      return srcError('no-cdp', {
        headline: 'No debuggable browser',
        explanation: 'crtr drives a browser over CDP and none is running.',
        nextStep: 'Launch Chrome with --remote-debugging-port=9222 (or Arc), then press g',
        banner: 'Gmail: no debuggable browser — launch one, then g',
        level: 'error',
        blocking: true,
      });
    case 'no-tab':
      return srcError('no-tab', {
        headline: 'No Gmail tab',
        explanation: 'Open mail.google.com in the debuggable browser.',
        nextStep: 'Press G to connect',
        banner: 'Gmail: open mail.google.com, then press g',
        level: 'action',
        blocking: true,
      });
    case 'not-logged-in':
      return srcError('not-logged-in', {
        headline: 'Log in to Gmail',
        explanation: 'Gmail needs a sign-in in the browser.',
        nextStep: 'Log in in the opened tab, then press g',
        banner: 'Gmail: log in, then press g',
        level: 'action',
        blocking: true,
      });
    case 'rate-limited':
      return srcError('rate-limited', {
        headline: 'Gmail is throttling',
        explanation: 'Too many requests — wait a moment before retrying.',
        nextStep: 'Press g to retry',
        banner: 'Gmail: throttled — wait, then press g',
        level: 'info',
        blocking: false,
      });
    case 'capture-not-dev':
      return srcError('capture-not-dev', {
        headline: 'Browser bridge unavailable',
        explanation: DEV_ONLY_MSG,
        nextStep: null,
        banner: 'Gmail: browser bridge unavailable — capture dev checkout required',
        level: 'error',
        blocking: true,
      });
    case 'still-loading':
      return srcError('still-loading', {
        headline: 'Still loading Gmail…',
        explanation: 'Gmail is taking a while to load.',
        nextStep: 'Press g to retry',
        banner: 'Gmail: still loading — press g to retry',
        level: 'action',
        blocking: false,
      });
    case 'error':
    default: {
      const msg = (error && error.message) || 'Unknown error.';
      return srcError('error', {
        headline: 'Something went wrong',
        explanation: msg,
        nextStep: 'Press g to retry',
        banner: `Gmail: ${truncate(msg, 80)}`,
        level: 'error',
        blocking: true,
      });
    }
  }
}

/** @returns {SourceError} */
function gmailCaptureMissing() {
  return toGmailSourceError({ kind: 'error', message: 'capture binary not found — install capture or set CAPTURE_BIN.' });
}

// ── Field mappers ─────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {number} epoch ms (Gmail dates are already ms) */
function asMs(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** @param {any} addr @returns {string} */
function addrName(addr) {
  const a = addr || {};
  if (typeof a.name === 'string' && a.name.trim()) return a.name;
  if (typeof a.email === 'string' && a.email.trim()) return a.email;
  return 'Unknown';
}
/** @param {any} addr @returns {string} */
function addrEmail(addr) {
  const a = addr || {};
  return typeof a.email === 'string' ? a.email : '';
}
/** @param {any} m @returns {UnifiedRow} */
function toUnifiedRow(m) {
  const o = m || {};
  const threadId = typeof o.threadId === 'string' ? o.threadId : '';
  const from = o.from || {};
  return {
    sourceId: 'gmail',
    key: `gmail:${threadId}`,
    name: addrName(from),
    snippet: typeof o.snippet === 'string' && o.snippet ? o.snippet : typeof o.subject === 'string' ? o.subject : '',
    unread: o.unread === true,
    ts: asMs(o.date),
    ref: {
      threadId,
      messageId: typeof o.messageId === 'string' ? o.messageId : '',
      subject: typeof o.subject === 'string' ? o.subject : '',
      fromEmail: addrEmail(from),
      fromName: addrName(from),
    },
  };
}
/** @param {any} m @param {string} myEmail @returns {UnifiedMessage} */
function toUnifiedMessage(m, myEmail) {
  const o = m || {};
  const from = o.from || {};
  const fromEmail = addrEmail(from);
  return {
    sender: addrName(from),
    fromMe: !!myEmail && fromEmail.toLowerCase() === myEmail.toLowerCase(),
    text: typeof o.body === 'string' && o.body ? o.body : typeof o.snippet === 'string' ? o.snippet : '',
    ts: asMs(o.date),
  };
}
/** Strip leading `Re:` chains, then prefix a single `Re: `. @param {string} s */
function reSubject(s) {
  const base = String(s || '').replace(/^\s*(re:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

/** @param {string} url @returns {boolean} */
function isGmailUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'mail.google.com';
  } catch {
    return false;
  }
}

// ── Sources (reads) ────────────────────────────────────────────────────────────

/** Gmail: discover the mail.google.com tab id via `capture list`. */
const gmailDiscover = {
  id: 'gmail-discover',
  request: (a) => ({ kind: 'exec', bin: 'capture', args: withPort(['list'], a && a.port) }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let tabs;
    try {
      tabs = parseJson(raw.stdout) || [];
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse capture list output' }));
    }
    if (!Array.isArray(tabs)) return fail(toGmailSourceError({ kind: 'no-tab' }));
    const chosen = tabs.filter((t) => t && typeof t.url === 'string' && isGmailUrl(t.url))[0];
    if (chosen && chosen.id) return ok(String(chosen.id));
    return fail(toGmailSourceError({ kind: 'no-tab' }));
  },
};

/** Gmail: read page auth context `{xsrf, account, email, globals}`. */
const gmailContext = {
  id: 'gmail-context',
  request: (a) => ({
    kind: 'exec', bin: 'capture',
    args: withTP(['exec', execCode('libs/gmail', 'getContext', null)], a && a.target, a && a.port),
  }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let d;
    try {
      d = parseJson(raw.stdout) || {};
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse getContext output' }));
    }
    if (!d.xsrf || d.account == null || !d.globals) {
      return fail(toGmailSourceError({ kind: 'error', message: 'getContext() returned no xsrf/account/globals' }));
    }
    return ok({ xsrf: String(d.xsrf), account: Number(d.account), email: typeof d.email === 'string' ? d.email : '', globals: d.globals });
  },
};

/** Gmail: list inbox rows (one per thread). */
const gmailInbox = {
  id: 'gmail-inbox',
  request: (a) => ({
    kind: 'exec', bin: 'capture',
    args: withTP(
      ['exec', execCode('libs/gmail', 'listInbox', { xsrf: a.xsrf, account: a.account, globals: a.globals, count: (a && a.count) || INBOX_COUNT })],
      a && a.target, a && a.port
    ),
  }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let r;
    try {
      r = parseJson(raw.stdout) || {};
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse listInbox output' }));
    }
    const arr = r && Array.isArray(r.messages) ? r.messages : [];
    return ok(arr.map(toUnifiedRow));
  },
};

/** Gmail: read a thread's raw messages (for buildThread + reply resolution). */
const gmailThread = {
  id: 'gmail-thread',
  request: (a) => ({
    kind: 'exec', bin: 'capture',
    args: withTP(
      ['exec', execCode('libs/gmail', 'readEmail', { xsrf: a.xsrf, account: a.account, globals: a.globals, threadId: a.threadId })],
      a && a.target, a && a.port
    ),
  }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let r;
    try {
      r = parseJson(raw.stdout) || {};
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse readEmail output' }));
    }
    return ok(r && Array.isArray(r.messages) ? r.messages : []);
  },
};

// ── Commands (writes) ──────────────────────────────────────────────────────────

/** Gmail: open/reuse the mail.google.com tab → its tab id. */
const gmailOpen = {
  id: 'gmail-open',
  request: (a) => ({ kind: 'exec', bin: 'capture', args: withPort(['open', GMAIL_URL], a && a.port) }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let body;
    try {
      body = parseJson(raw.stdout) || {};
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse capture open output' }));
    }
    if (body && body.id) return ok(String(body.id));
    return fail(toGmailSourceError({ kind: 'error', message: 'capture open returned no tab id' }));
  },
};

/** Gmail: send a reply. */
const gmailReply = {
  id: 'gmail-reply',
  request: (a) => ({
    kind: 'exec', bin: 'capture',
    args: withTP(
      ['exec', execCode('libs/gmail', 'replyEmail', {
        xsrf: a.xsrf, account: a.account, globals: a.globals, threadId: a.threadId,
        originalMsgId: a.originalMsgId, to: a.to, subject: a.subject, body: a.body,
      })],
      a && a.target, a && a.port
    ),
  }),
  parse: (raw) => {
    if (!raw.ok) return fail(gmailCaptureMissing());
    if (raw.exitCode !== 0) return fail(toGmailSourceError(classifyGmail(raw.stderr)));
    let out;
    try {
      out = parseJson(raw.stdout) || {};
    } catch {
      return fail(toGmailSourceError({ kind: 'error', message: 'could not parse replyEmail output' }));
    }
    if (out && out.success === false) return fail(toGmailSourceError({ kind: 'error', message: 'Gmail rejected the reply' }));
    return ok(undefined);
  },
};

// ── Orchestration (restated ensureReady state machines) ───────────────────────

/** @param {string} headline @param {any} e @returns {SourceError} */
function defensiveError(headline, e) {
  const msg = e && e.message ? String(e.message) : headline;
  return srcError('error', { headline, explanation: msg, nextStep: 'Press g to retry', banner: msg, level: 'error', blocking: false });
}

/** Which auto-fix branch a LinkedIn error kind takes. @returns {'open'|'navigate'|null} */
function autoFixFor(kind) {
  if (kind === 'no-tab') return 'open';
  if (kind === 'not-messaging') return 'navigate';
  return null;
}

/** One LinkedIn readiness attempt: discover → context → listConversations. */
async function attemptLi(ctx, sub) {
  if (!sub.target) {
    const r = await ctx.resolve(discoverTabSource, { port: sub.port });
    if (!r.ok) return r;
    sub.target = r.data;
  }
  if (!sub.ctx) {
    const r = await ctx.resolve(contextSource, { target: sub.target, port: sub.port });
    if (!r.ok) return r;
    sub.ctx = r.data;
  }
  const lc = await ctx.resolve(conversationsSource, { target: sub.target, port: sub.port, csrf: sub.ctx.csrf, memberId: sub.ctx.memberId, count: CONVO_COUNT });
  if (!lc.ok) return lc;
  sub.convos = lc.data;
  return { ok: true };
}

/** Bounded settle-poll after a LinkedIn auto open/navigate. */
async function settleLi(ctx, sub) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    const r = await attemptLi(ctx, sub);
    if (r.ok) {
      sub.loginTabOpened = false;
      return { ok: true };
    }
    if (HARD_STOP.has(r.error.kind)) return r;
  }
  // Settle-exhaustion is inbox glue (a "still loading" nudge), not a classify dup.
  return fail(srcError('settling', {
    headline: 'Still loading',
    explanation: 'LinkedIn is taking a moment to load.',
    nextStep: 'Press g to retry',
    banner: 'still loading — press g to retry',
    level: 'action',
    blocking: false,
  }));
}

/** LinkedIn ensureReady: discover→auth→settle with auto-fix branches. */
async function ensureLinkedin(ctx, sub) {
  const probe = await attemptLi(ctx, sub);
  if (probe.ok) {
    sub.loginTabOpened = false;
    return { ok: true };
  }
  const error = probe.error;
  const auto = autoFixFor(error.kind);
  if (auto) {
    const fix = auto === 'open'
      ? await ctx.execute(openTabCommand, { port: sub.port })
      : await ctx.execute(navigateCommand, { target: sub.target, port: sub.port });
    if (!fix.ok) return fix;
    if (auto === 'open' && fix.data) sub.target = fix.data;
    sub.ctx = null;
    return settleLi(ctx, sub);
  }
  // not-logged-in: open the messaging tab ONCE per episode, then guide.
  if (error.kind === 'not-logged-in' && !sub.loginTabOpened) {
    const o = await ctx.execute(openTabCommand, { port: sub.port });
    if (o.ok && o.data) sub.target = o.data;
    sub.loginTabOpened = true;
  }
  return probe;
}

/** One Gmail readiness attempt: discover → context. */
async function attemptGmail(ctx, sub) {
  if (!sub.target) {
    const r = await ctx.resolve(gmailDiscover, { port: sub.port });
    if (!r.ok) return r;
    sub.target = r.data;
  }
  if (!sub.ctx) {
    const r = await ctx.resolve(gmailContext, { target: sub.target, port: sub.port });
    if (!r.ok) return r;
    sub.ctx = r.data;
  }
  return { ok: true };
}

/** Bounded settle-poll after a Gmail auto open. */
async function settleGmail(ctx, sub) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    ctx.signal.setStatus(`Loading Gmail… (${i})`);
    const r = await attemptGmail(ctx, sub);
    if (r.ok) {
      sub.loginTabOpened = false;
      return { ok: true };
    }
    if (HARD_STOP.has(r.error.kind)) return r;
  }
  return fail(toGmailSourceError({ kind: 'still-loading' }));
}

/** Gmail ensureReady: discover→auth→settle. */
async function ensureGmail(ctx, sub) {
  const r = await attemptGmail(ctx, sub);
  if (r.ok) {
    sub.loginTabOpened = false;
    return { ok: true };
  }
  const kind = r.error.kind;
  if (kind === 'no-tab') {
    ctx.signal.setStatus('Opening Gmail…');
    const o = await ctx.execute(gmailOpen, { port: sub.port });
    if (!o.ok) return o;
    sub.target = o.data;
    sub.ctx = null;
    return settleGmail(ctx, sub);
  }
  if (kind === 'not-logged-in') {
    if (!sub.loginTabOpened) {
      const o = await ctx.execute(gmailOpen, { port: sub.port });
      if (o.ok && o.data) sub.target = o.data;
      sub.loginTabOpened = true;
    }
    return r;
  }
  return r;
}

/** Map cached LinkedIn conversations → UnifiedRows (pure). */
function liRowsFromConvos(sub) {
  const csrf = sub.ctx ? sub.ctx.csrf : '';
  const memberId = sub.ctx ? sub.ctx.memberId : '';
  return (sub.convos || []).map((c) => ({
    sourceId: 'linkedin',
    key: `linkedin:${c.urn}`,
    name: c.name || 'Unknown',
    snippet: c.lastMessage || '',
    unread: !!c.unread,
    ts: c.ts || 0,
    ref: { urn: c.urn, recipientId: c.recipientId, csrf, memberId },
  }));
}

/** Load a LinkedIn thread; caches raw msgs (urns) for react; clears unread. */
async function loadLiThread(ctx, sub, ref) {
  const csrf = (sub.ctx && sub.ctx.csrf) || ref.csrf;
  const memberId = (sub.ctx && sub.ctx.memberId) || ref.memberId;
  if (!csrf) {
    return fail(srcError('error', {
      headline: 'Something went wrong', explanation: 'not authenticated yet',
      nextStep: 'Press g to retry', banner: 'not authenticated yet', level: 'error', blocking: false,
    }));
  }
  const vc = await ctx.execute(viewThreadCommand, { target: sub.target, port: sub.port, csrf, conversationUrn: ref.urn });
  if (!vc.ok) return vc;
  // applyFromMe resolves fromMe and keeps each message's urn (needed by react).
  const raw = applyFromMe(vc.data, memberId);
  sub.threads = { ...sub.threads, [ref.urn]: raw };
  const c = (sub.convos || []).find((x) => x.urn === ref.urn);
  if (c) c.unread = false;
  const name = c ? c.name : 'Conversation';
  const messages = raw.map((m) => ({ sender: m.sender, fromMe: m.fromMe, text: m.text, ts: m.ts }));
  return ok({ title: name || 'Conversation', messages, canReply: true, canReact: true });
}

/** Load a Gmail thread → UnifiedThread (with from/to subtitle). */
async function loadGmailThread(ctx, sub, ref) {
  const threadId = ref && ref.threadId ? ref.threadId : '';
  if (!threadId) return fail(toGmailSourceError({ kind: 'error', message: 'loadThread: missing threadId' }));
  const r = await ctx.resolve(gmailThread, { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, threadId, target: sub.target, port: sub.port });
  if (!r.ok) return r;
  const msgs = r.data;
  const myEmail = sub.ctx.email || '';
  const first = msgs[0] || {};
  const last = msgs[msgs.length - 1] || {};
  const title = (typeof first.subject === 'string' && first.subject) || (ref && ref.subject) || '(no subject)';
  const fromAddr = addrEmail(last.from) || addrEmail(first.from);
  const toAddr = (last.to && last.to[0] && addrEmail(last.to[0])) || (first.to && first.to[0] && addrEmail(first.to[0])) || '';
  const subtitle = fromAddr || toAddr ? `from ${fromAddr || '—'} · to ${toAddr || '—'}` : undefined;
  return ok({
    title,
    ...(subtitle ? { subtitle } : {}),
    messages: msgs.map((m) => toUnifiedMessage(m, myEmail)),
    canReply: true,
    canReact: false,
  });
}

/** Resolve recipient + originalMsgId from a Gmail thread, then send the reply. */
async function sendGmail(ctx, sub, ref, text) {
  const threadId = ref && ref.threadId ? ref.threadId : '';
  if (!threadId) return fail(toGmailSourceError({ kind: 'error', message: 'reply: missing threadId' }));
  const body = String(text == null ? '' : text);
  if (!body.trim()) return fail(toGmailSourceError({ kind: 'error', message: 'reply: empty body' }));
  const read = await ctx.resolve(gmailThread, { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, threadId, target: sub.target, port: sub.port });
  if (!read.ok) return read;
  const msgs = read.data;
  if (msgs.length === 0) return fail(toGmailSourceError({ kind: 'error', message: 'reply: thread has no messages' }));
  const myEmail = (sub.ctx.email || '').toLowerCase();
  const latest = msgs[msgs.length - 1] || {};
  const originalMsgId = typeof latest.messageId === 'string' ? latest.messageId : (ref && ref.messageId) || '';
  if (!originalMsgId) return fail(toGmailSourceError({ kind: 'error', message: 'reply: could not resolve message id' }));
  let tgt = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const fe = addrEmail((msgs[i] || {}).from).toLowerCase();
    if (fe && fe !== myEmail) {
      tgt = msgs[i];
      break;
    }
  }
  let toEmail = tgt ? addrEmail(tgt.from) : '';
  if (!toEmail) toEmail = (latest.to && latest.to[0] && addrEmail(latest.to[0])) || '';
  if (!toEmail && ref && ref.fromEmail) toEmail = ref.fromEmail;
  if (!toEmail) return fail(toGmailSourceError({ kind: 'error', message: 'reply: could not determine recipient' }));
  const subject = reSubject((tgt && tgt.subject) || latest.subject || (ref && ref.subject) || '');
  return ctx.execute(gmailReply, {
    xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, threadId,
    originalMsgId, to: toEmail, subject, body, target: sub.target, port: sub.port,
  });
}

// ── Merge / chrome helpers ─────────────────────────────────────────────────────

/** Sort the merged set unread-first then ts desc. Mutates `arr`. */
function sortRows(arr) {
  arr.sort((a, b) => {
    if (!!a.unread !== !!b.unread) return a.unread ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

/** Re-merge rowsBySource into the visible, sorted list — keeping the cursor by key. */
function mergeRows(rowsBySource, filter, prevRows, prevCursor) {
  const prev = prevRows[prevCursor];
  const prevKey = prev && prev.key;
  let all = [];
  for (const m of SOURCES_META) {
    if (filter !== 'all' && filter !== m.id) continue;
    all = all.concat(rowsBySource[m.id] || []);
  }
  sortRows(all);
  let cursor = prevCursor;
  if (prevKey) {
    const i = all.findIndex((r) => r.key === prevKey);
    if (i >= 0) cursor = i;
  }
  if (cursor >= all.length) cursor = Math.max(0, all.length - 1);
  if (cursor < 0) cursor = 0;
  return { rows: all, cursor };
}

/** Collapse per-source down-states into ONE host banner (label-prefixed). */
function applyBanners(ctx, banners) {
  const downs = [];
  for (const m of SOURCES_META) {
    const e = banners && banners[m.id];
    if (e && e.display) downs.push({ label: m.label, d: e.display });
  }
  if (downs.length === 0) {
    ctx.signal.clearBanner();
    return;
  }
  let level = 'info';
  for (const x of downs) if ((LEVEL_RANK[x.d.level] || 0) > (LEVEL_RANK[level] || 0)) level = x.d.level;
  // LinkedIn's shared SourceError displays carry no `.banner`; fall back to
  // explanation/headline so the merged chrome banner is never blank.
  const msg = downs.map((x) => labeled(x.label, x.d.banner || x.d.explanation || x.d.headline)).join('   ·   ');
  ctx.signal.setBanner(msg, /** @type {any} */ (level));
}

/** Set a one-off banner for a per-action SourceError (open/reply/react). */
function bannerFromSource(ctx, id, error) {
  const label = labelFor(id);
  const d = error && error.display;
  const text = d && (d.banner || d.explanation || d.headline);
  if (text) ctx.signal.setBanner(labeled(label, text), (d && d.level) || 'error');
  else ctx.signal.setBanner(`${label}: error`, 'error');
}

/** Drive the live "N unread · <filter>" subtitle from current state. */
function updateSubtitle(ctx) {
  const s = ctx.state;
  const n = unreadCount(s);
  const parts = [];
  if (n > 0) parts.push(`${n} unread`);
  if (s.filter !== 'all') {
    const m = SOURCE_BY_ID[s.filter];
    parts.push(`${m ? m.label : s.filter} only`);
  }
  ctx.signal.setSubtitle(parts.length ? parts.join(' · ') : null);
}

// ── Sub cloning (immutable update discipline) ─────────────────────────────────

function cloneLi(sub) {
  return { ...sub, threads: { ...(sub.threads || {}) }, convos: (sub.convos || []).map((c) => ({ ...c })) };
}
function cloneGmail(sub) {
  return { ...sub };
}
function cloneSubs(subs) {
  return { linkedin: cloneLi(subs.linkedin), gmail: cloneGmail(subs.gmail) };
}

// ── The portable core ──────────────────────────────────────────────────────────

/** @type {import('../../core/view/contract.js').ViewCore<InboxState>} */
const core = {
  manifest: {
    id: 'inbox',
    title: 'Inbox',
    description: 'Combined inbox — triage LinkedIn + Gmail in one ranked list',
    refreshMs: 30000,
  },

  /** Cheap + synchronous initial state. NO fetch — the host paints a loading
   *  frame, then dispatches the first 'refresh'. @returns {InboxState} */
  init(opts) {
    return {
      subs: {
        linkedin: { ctx: null, target: (opts && opts.target) || null, port: (opts && opts.port) || undefined, convos: [], threads: {}, loginTabOpened: false },
        gmail: { target: null, port: undefined, ctx: null, loginTabOpened: false },
      },
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

  sources: { gmailDiscover, gmailContext, gmailInbox, gmailThread },
  commands: { gmailOpen, gmailReply },

  intents: {
    /**
     * For each source (LinkedIn first): ensureReady → list rows; merge + sort;
     * set per-source banners. Partial readiness: one down source never blanks the
     * view. Skips while composing/reacting so a poll can't disrupt input.
     * @param {Ctx} ctx
     */
    async refresh(ctx) {
      if (ctx.state.mode !== 'list') return;
      ctx.signal.setStatus('Refreshing…');
      const s0 = ctx.state;
      const subs = cloneSubs(s0.subs);
      /** @type {Record<string, UnifiedRow[]>} */
      const rowsBySource = {};
      /** @type {Record<string, SourceError|null>} */
      const banners = {};
      /** @type {Record<string, boolean>} */
      const ready = {};

      for (const meta of SOURCES_META) {
        const id = meta.id;
        const sub = subs[id];
        let er;
        try {
          er = id === 'linkedin' ? await ensureLinkedin(ctx, sub) : await ensureGmail(ctx, sub);
        } catch (e) {
          er = { ok: false, error: defensiveError('source error', e) };
        }
        if (er.ok) {
          ready[id] = true;
          banners[id] = null;
          if (id === 'linkedin') {
            rowsBySource[id] = liRowsFromConvos(sub);
          } else {
            let lr;
            try {
              lr = await ctx.resolve(gmailInbox, { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, count: INBOX_COUNT, target: sub.target, port: sub.port });
            } catch (e) {
              lr = { ok: false, error: defensiveError('list failed', e) };
            }
            if (lr.ok) {
              rowsBySource[id] = lr.data;
            } else {
              rowsBySource[id] = [];
              banners[id] = lr.error;
            }
          }
        } else {
          ready[id] = false;
          rowsBySource[id] = [];
          banners[id] = er.error;
        }
      }

      ctx.set((s) => {
        const { rows, cursor } = mergeRows(rowsBySource, s.filter, s.rows, s.cursor);
        return { ...s, subs, rowsBySource, banners, ready, rows, cursor, lastFetch: Date.now() };
      });
      ctx.signal.setStatus(null);
      applyBanners(ctx, banners);
      updateSubtitle(ctx);
    },

    /** @param {Ctx} ctx */
    cursorDown: (ctx) => ctx.set((s) => ({ ...s, cursor: s.rows.length ? Math.min(s.rows.length - 1, s.cursor + 1) : 0 })),
    /** @param {Ctx} ctx */
    cursorUp: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),

    /**
     * Open the row at `idx` (or the cursor): dispatch to its source's loadThread.
     * @param {Ctx} ctx @param {number} [idx]
     */
    async open(ctx, idx) {
      const s0 = ctx.state;
      const i = typeof idx === 'number' ? idx : s0.cursor;
      const row = s0.rows[i];
      if (!row) return;
      ctx.signal.setStatus('Loading thread…');
      const subs = cloneSubs(s0.subs);
      const id = row.sourceId;
      let result;
      try {
        result = id === 'linkedin' ? await loadLiThread(ctx, subs.linkedin, row.ref) : await loadGmailThread(ctx, subs.gmail, row.ref);
      } catch (e) {
        result = { ok: false, error: defensiveError('could not load thread', e) };
      }
      ctx.signal.setStatus(null);
      if (!result.ok) {
        ctx.set((s) => ({ ...s, subs, openKey: row.key, openRow: row, thread: null, threadScroll: 0 }));
        bannerFromSource(ctx, id, result.error);
        return;
      }
      ctx.set((s) => {
        // Mark the open row read (optimistic) across both views of it.
        const mark = (r) => (r.key === row.key ? { ...r, unread: false } : r);
        const rows = s.rows.map(mark);
        const rowsBySource = { ...s.rowsBySource };
        rowsBySource[id] = (rowsBySource[id] || []).map(mark);
        return { ...s, subs, rows, rowsBySource, openKey: row.key, openRow: row, thread: result.data, threadScroll: 0 };
      });
      updateSubtitle(ctx);
    },

    /** @param {Ctx} ctx */
    cycleFilter(ctx) {
      ctx.set((s) => {
        const cyc = ['all', 'linkedin', 'gmail'];
        const i = cyc.indexOf(s.filter);
        const filter = cyc[(i + 1) % cyc.length] || 'all';
        const { rows, cursor } = mergeRows(s.rowsBySource, filter, s.rows, s.cursor);
        return { ...s, filter, rows, cursor };
      });
      updateSubtitle(ctx);
    },

    /** @param {Ctx} ctx */
    startReply(ctx) {
      const s = ctx.state;
      if (!s.openKey || !s.thread) {
        ctx.signal.setBanner('Open a conversation first', 'action');
        return;
      }
      if (!s.thread.canReply) return;
      ctx.set((st) => ({ ...st, mode: 'reply', draft: '' }));
      ctx.signal.setMode('compose');
    },

    /** @param {Ctx} ctx */
    startReact(ctx) {
      const s = ctx.state;
      if (!s.openKey || !s.thread) {
        ctx.signal.setBanner('Open a conversation first', 'action');
        return;
      }
      if (!s.thread.canReact || (s.thread.messages || []).length === 0) return;
      ctx.set((st) => ({ ...st, mode: 'react', reactCursor: 0 }));
      ctx.signal.setMode('react');
    },

    /** @param {Ctx} ctx @param {string} payload */
    setDraft: (ctx, payload) => ctx.set((s) => ({ ...s, draft: typeof payload === 'string' ? payload : '' })),

    /** @param {Ctx} ctx */
    async submitReply(ctx) {
      const s0 = ctx.state;
      const text = s0.draft.trim();
      ctx.set((s) => ({ ...s, mode: 'list' }));
      ctx.signal.setMode(null);
      if (!text) return;
      const row = s0.openRow;
      const id = row ? row.sourceId : null;
      if (!row || !id) {
        ctx.signal.setBanner('No open conversation to reply to.', 'error');
        return;
      }
      ctx.signal.setStatus('Sending…');
      const subs = cloneSubs(s0.subs);
      let result;
      try {
        result = id === 'linkedin'
          ? await ctx.execute(sendMessageCommand, { target: subs.linkedin.target, port: subs.linkedin.port, csrf: (subs.linkedin.ctx && subs.linkedin.ctx.csrf) || row.ref.csrf, myMemberId: (subs.linkedin.ctx && subs.linkedin.ctx.memberId) || row.ref.memberId, recipient: row.ref.recipientId, text, conversationUrn: row.ref.urn })
          : await sendGmail(ctx, subs.gmail, row.ref, text);
      } catch (e) {
        result = { ok: false, error: defensiveError('send failed', e) };
      }
      if (!result.ok) {
        ctx.signal.setStatus(null);
        bannerFromSource(ctx, id, result.error);
        return;
      }
      // Reconcile by reloading the thread (best-effort).
      let thread = s0.thread;
      try {
        const reload = id === 'linkedin' ? await loadLiThread(ctx, subs.linkedin, row.ref) : await loadGmailThread(ctx, subs.gmail, row.ref);
        if (reload.ok) thread = reload.data;
      } catch { /* non-fatal */ }
      ctx.set((s) => ({ ...s, subs, draft: '', thread }));
      ctx.signal.setStatus('Sent');
      applyBanners(ctx, ctx.state.banners);
    },

    /** @param {Ctx} ctx */
    reactPrev: (ctx) => ctx.set((s) => ({ ...s, reactCursor: Math.max(0, s.reactCursor - 1) })),
    /** @param {Ctx} ctx */
    reactNext: (ctx) => ctx.set((s) => ({ ...s, reactCursor: Math.min(EMOJIS.length - 1, s.reactCursor + 1) })),

    /** @param {Ctx} ctx @param {number} [idx] */
    async submitReact(ctx, idx) {
      const s0 = ctx.state;
      const row = s0.openRow;
      const id = row ? row.sourceId : null;
      ctx.set((s) => ({ ...s, mode: 'list' }));
      ctx.signal.setMode(null);
      if (id !== 'linkedin' || !row) {
        ctx.signal.setBanner('Cannot react here.', 'error');
        return;
      }
      const emoji = EMOJIS[typeof idx === 'number' ? idx : s0.reactCursor] || EMOJIS[0];
      const subs = cloneSubs(s0.subs);
      const sub = subs.linkedin;
      const msgs = sub.threads[row.ref.urn] || [];
      const tgt = msgs.length ? msgs[msgs.length - 1] : null;
      if (!tgt || !tgt.urn) {
        ctx.signal.setBanner('LinkedIn: no message to react to', 'error');
        return;
      }
      const csrf = (sub.ctx && sub.ctx.csrf) || row.ref.csrf;
      if (!csrf) {
        ctx.signal.setBanner('LinkedIn: not authenticated yet', 'error');
        return;
      }
      ctx.signal.setStatus('Reacting…');
      let r;
      try {
        r = await ctx.execute(reactCommand, { target: sub.target, port: sub.port, csrf, messageUrn: tgt.urn, emoji });
      } catch (e) {
        r = { ok: false, error: defensiveError('react failed', e) };
      }
      if (!r.ok) {
        ctx.signal.setStatus(null);
        bannerFromSource(ctx, 'linkedin', r.error);
        return;
      }
      ctx.signal.setStatus('Reacted ' + emoji);
      applyBanners(ctx, ctx.state.banners);
    },

    /** @param {Ctx} ctx */
    cancelCompose(ctx) {
      ctx.set((s) => ({ ...s, mode: 'list', draft: '' }));
      ctx.signal.setMode(null);
    },

    /** @param {Ctx} ctx */
    async connectLinkedin(ctx) {
      const subs = cloneSubs(ctx.state.subs);
      const sub = subs.linkedin;
      ctx.signal.setStatus('Connecting LinkedIn…');
      let o;
      try {
        o = await ctx.execute(openTabCommand, { port: sub.port });
      } catch (e) {
        o = { ok: false, error: defensiveError('connect failed', e) };
      }
      ctx.signal.setStatus(null);
      if (!o.ok) {
        ctx.set((s) => ({ ...s, banners: { ...s.banners, linkedin: o.error } }));
        applyBanners(ctx, ctx.state.banners);
        return;
      }
      if (o.data) sub.target = o.data;
      sub.ctx = null;
      ctx.set((s) => ({ ...s, subs }));
      await ctx.dispatch('refresh');
    },

    /** @param {Ctx} ctx */
    async connectGmail(ctx) {
      const subs = cloneSubs(ctx.state.subs);
      const sub = subs.gmail;
      ctx.signal.setStatus('Connecting Gmail…');
      let o;
      try {
        o = await ctx.execute(gmailOpen, { port: sub.port });
      } catch (e) {
        o = { ok: false, error: defensiveError('connect failed', e) };
      }
      ctx.signal.setStatus(null);
      if (!o.ok) {
        ctx.set((s) => ({ ...s, banners: { ...s.banners, gmail: o.error } }));
        applyBanners(ctx, ctx.state.banners);
        return;
      }
      if (o.data) sub.target = o.data;
      sub.ctx = null;
      sub.loginTabOpened = true; // we just opened it; don't double-open on ensureReady
      ctx.set((s) => ({ ...s, subs }));
      await ctx.dispatch('refresh');
    },

    /** @param {Ctx} ctx */
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
