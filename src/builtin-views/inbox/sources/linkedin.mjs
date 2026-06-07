// @ts-check
/**
 * LinkedIn Source adapter for the combined `inbox` view.
 *
 * A thin adapter over the EXISTING, unchanged `../../linkedin/client.mjs`
 * (capture-exec + never-throw `Result` + `classifyError`). It implements the
 * `inbox` Source contract: `{ id, label, badge, connectKey, init, ensureReady,
 * listRows, loadThread, reply, react, connect }`. The combined view owns the
 * merge, the screen, the chrome, and the keymap; THIS module owns LinkedIn's
 * data fetching AND its full discover→auth→settle recovery state machine.
 *
 * The recovery machine (`attempt` / `recover` / `settle`) is PORTED from
 * `../../linkedin/view.mjs` into `ensureReady` here — the standalone `linkedin`
 * view keeps its own copy untouched. Auto-fix branches drive the browser
 * (open/navigate) then bounded-settle-poll; terminal states return a typed
 * `SourceError` whose `display` the view renders as this source's banner/panel.
 *
 * Self-contained ESM, Node-builtins only, imports NOTHING from crtr. NEVER
 * throws: every async returns a `Result` (`{ok:true,data}` | `{ok:false,error}`).
 *
 * @module inbox/sources/linkedin
 */

import {
  discoverTab,
  getContext,
  listConversations,
  viewConversation,
  sendMessage,
  reactToMessage,
  openMessagingTab,
  navigateToMessaging,
} from '../../linkedin/client.mjs';

/** @typedef {import('../../linkedin/client.mjs').LiContext} LiContext */
/** @typedef {import('../../linkedin/client.mjs').Conversation} Conversation */
/** @typedef {import('../../linkedin/client.mjs').Message} Message */
/** @typedef {import('../../linkedin/client.mjs').ClientError} ClientError */

// ── Tunables (match the standalone linkedin view) ────────────────────────────

/** How many conversations to request per refresh. */
const CONVO_COUNT = 25;

/** Bounded settle-poll: retry readiness up to N times, spaced ~MS, after an
 *  auto open/navigate — a hard ceiling so the flow never spins forever. */
const SETTLE_MAX = 5;
const SETTLE_INTERVAL_MS = 1200;

/** ClientError kinds that waiting can't fix — stop the settle-poll and guide. */
const HARD_STOP = new Set(['no-cdp', 'not-logged-in', 'capture-not-dev']);

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Result helpers (Source contract — distinct from client.mjs's) ────────────

/** @template T @param {T} [data] @returns {{ok:true, data:T}} */
function ok(data) {
  return { ok: true, data: /** @type {any} */ (data) };
}

/** @param {{kind:string, display:object}} error @returns {{ok:false, error:any}} */
function fail(error) {
  return { ok: false, error };
}

// ── ClientError → SourceError (typed display the view renders) ───────────────

/**
 * @param {string} kind
 * @param {{headline:string, explanation?:string|string[], nextStep?:string|null,
 *   banner:string, level:'info'|'action'|'error', blocking:boolean}} display
 * @returns {{kind:string, display:object}}
 */
function srcError(kind, display) {
  return { kind, display };
}

/**
 * Map a typed {@link ClientError} into a Source `SourceError`. The `banner` text
 * is bare (no source label) — the view prefixes it with `LinkedIn: `.
 * @param {ClientError} error
 * @returns {{kind:string, display:object}}
 */
function toSourceError(error) {
  const kind = (error && error.kind) || 'error';
  switch (kind) {
    case 'not-logged-in':
      return srcError('not-logged-in', {
        headline: 'Log in to continue',
        explanation: 'LinkedIn needs a sign-in in the browser.',
        nextStep: 'Log in in the opened tab, then press g',
        banner: 'log in, then press g',
        level: 'action',
        blocking: true,
      });
    case 'no-cdp':
      return srcError('no-cdp', {
        headline: 'No debuggable browser',
        explanation: 'crtr drives a browser over CDP and none is running.',
        nextStep: 'Launch Arc, or Chrome with --remote-debugging-port=9222, then press g',
        banner: 'no debuggable browser — launch one, then press g',
        level: 'error',
        blocking: true,
      });
    case 'rate-limited':
      return srcError('rate-limited', {
        headline: 'LinkedIn is throttling',
        explanation: 'Too many requests — waiting before trying again.',
        nextStep: 'Press g to retry',
        banner: 'throttling — wait, then press g',
        level: 'info',
        blocking: false,
      });
    case 'capture-not-dev':
      return srcError('capture-not-dev', {
        headline: 'Browser bridge unavailable',
        explanation: 'This view needs a capture dev checkout (vault/ + esbuild).',
        nextStep: null,
        banner: 'browser bridge unavailable — capture dev checkout required',
        level: 'error',
        blocking: true,
      });
    case 'not-connection':
      return srcError('not-connection', {
        headline: 'Not a 1st-degree connection',
        explanation: 'LinkedIn only allows messaging 1st-degree connections.',
        nextStep: null,
        banner: 'can only message 1st-degree connections',
        level: 'error',
        blocking: false,
      });
    case 'no-tab':
      return srcError('no-tab', {
        headline: 'No LinkedIn tab',
        explanation: 'No messaging tab is open.',
        nextStep: 'Press L to open LinkedIn Messages',
        banner: 'no messaging tab — press L to open',
        level: 'action',
        blocking: true,
      });
    case 'not-messaging':
      return srcError('not-messaging', {
        headline: 'LinkedIn is on another page',
        explanation: 'A LinkedIn tab is open but not on Messages.',
        nextStep: 'Press L to open Messages',
        banner: 'on another page — press L for Messages',
        level: 'action',
        blocking: true,
      });
    case 'error':
    default:
      return srcError('error', {
        headline: 'Something went wrong',
        explanation: (error && /** @type {any} */ (error).message) || 'Unknown error.',
        nextStep: 'Press g to retry',
        banner: (error && /** @type {any} */ (error).message) || 'something went wrong',
        level: 'error',
        blocking: true,
      });
  }
}

/** Settle-poll exhaustion (transient): keep other rows, nudge a manual retry. */
function settlingError() {
  return srcError('settling', {
    headline: 'Still loading',
    explanation: 'LinkedIn is taking a moment to load.',
    nextStep: 'Press g to retry',
    banner: 'still loading — press g to retry',
    level: 'action',
    blocking: false,
  });
}

/**
 * Which auto-fix branch a ClientError takes (drive the browser), if any.
 * @param {ClientError} error @returns {'open'|'navigate'|null}
 */
function autoFixFor(error) {
  const k = error && error.kind;
  if (k === 'no-tab') return 'open';
  if (k === 'not-messaging') return 'navigate';
  return null;
}

// ── Sub (private mutable substate the view stores at state.subs.linkedin) ─────

/**
 * @typedef {Object} LiSub
 * @property {LiContext|null} ctx     Cached after the first getContext().
 * @property {string|null} target     Discovered/opened CDP tab id (or options.target).
 * @property {string|undefined} port  options.port passthrough.
 * @property {Conversation[]} convos  Last successful inbox fetch (raw order; the view sorts the merge).
 * @property {Record<string, Message[]>} threads  urn → loaded messages (with urns, for react()).
 * @property {boolean} loginTabOpened Once-per-episode login-tab gate; reset on ready.
 */

/** @param {LiSub} sub @returns {{target:string|undefined, port:string|undefined}} */
function baseOpts(sub) {
  return { target: sub.target || undefined, port: sub.port };
}

// ── Readiness state machine (ported from linkedin/view.mjs) ──────────────────

/**
 * One readiness attempt: discover the tab (unless known), read auth context
 * once, list conversations (the readiness probe; caches into sub.convos).
 * Returns a client-shaped result ({ok:true} or the first ClientError).
 * @param {LiSub} sub
 * @returns {Promise<{ok:true} | {ok:false, error:ClientError}>}
 */
async function attempt(sub) {
  if (!sub.target) {
    const r = await discoverTab({ port: sub.port });
    if (!r.ok) return r;
    sub.target = r.data;
  }
  if (!sub.ctx) {
    const r = await getContext(baseOpts(sub));
    if (!r.ok) return r;
    sub.ctx = r.data;
  }
  const lc = await listConversations({
    ...baseOpts(sub),
    csrf: sub.ctx.csrf,
    memberId: sub.ctx.memberId,
    count: CONVO_COUNT,
  });
  if (!lc.ok) return lc;
  sub.convos = lc.data;
  return { ok: true };
}

/**
 * Bounded settle-poll after an auto open/navigate: retry readiness up to
 * SETTLE_MAX times spaced SETTLE_INTERVAL_MS. Ready ⇒ ok. Hard-stop ⇒ guided
 * SourceError. Exhaustion ⇒ transient settlingError (no infinite spin).
 * @param {LiSub} sub
 * @returns {Promise<{ok:true}|{ok:false, error:any}>}
 */
async function settle(sub) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    const r = await attempt(sub);
    if (r.ok) {
      sub.loginTabOpened = false;
      return ok();
    }
    if (HARD_STOP.has(r.error.kind)) return fail(toSourceError(r.error));
    // transient (no-tab / not-messaging / rate-limited / error) → keep polling
  }
  return fail(settlingError());
}

// ── Source contract methods ──────────────────────────────────────────────────

/**
 * Build private substate. Cheap, sync. Seeds target/port from the view options
 * (LinkedIn honors host.options.target / host.options.port).
 * @param {{options?: Record<string,string>}} host @returns {LiSub}
 */
function init(host) {
  const opts = (host && host.options) || {};
  return {
    ctx: null,
    target: opts.target || null,
    port: opts.port || undefined,
    convos: [],
    threads: {},
    loginTabOpened: false,
  };
}

/**
 * Discover → auth → settle, mutating sub in place. Owns the full recovery state
 * machine; returns ok when ready, else a SourceError.
 * @param {LiSub} sub @param {object} _host
 * @returns {Promise<{ok:true}|{ok:false, error:any}>}
 */
async function ensureReady(sub, _host) {
  const probe = await attempt(sub);
  if (probe.ok) {
    sub.loginTabOpened = false;
    return ok();
  }
  const error = probe.error;
  const auto = autoFixFor(error);
  if (auto) {
    const fix = auto === 'open'
      ? await openMessagingTab({ port: sub.port })
      : await navigateToMessaging({ target: sub.target || undefined, port: sub.port });
    if (!fix.ok) return fail(toSourceError(fix.error));
    if (auto === 'open' && fix.data) sub.target = fix.data;
    sub.ctx = null; // re-read auth for the (possibly new) tab/page
    return settle(sub);
  }
  // not-logged-in: open the messaging tab ONCE per episode so the login page is
  // visible, then STOP (logged out, /messaging/ redirects to /login, so a new
  // tab would spawn on every poll). onReady (probe.ok above) resets the gate.
  if (error && error.kind === 'not-logged-in' && !sub.loginTabOpened) {
    const o = await openMessagingTab({ port: sub.port });
    if (o.ok && o.data) sub.target = o.data;
    sub.loginTabOpened = true;
  }
  return fail(toSourceError(error));
}

/**
 * Map the cached conversations into UnifiedRows. Only invoked after ensureReady
 * ok. The view sorts the merged set; we keep raw order here.
 * @param {LiSub} sub
 * @returns {Promise<{ok:true, data:object[]}>}
 */
async function listRows(sub) {
  const csrf = sub.ctx ? sub.ctx.csrf : '';
  const memberId = sub.ctx ? sub.ctx.memberId : '';
  const rows = (sub.convos || []).map((c) => ({
    sourceId: 'linkedin',
    key: `linkedin:${c.urn}`,
    name: c.name || 'Unknown',
    snippet: c.lastMessage || '',
    unread: !!c.unread,
    ts: c.ts || 0,
    ref: { urn: c.urn, recipientId: c.recipientId, csrf, memberId },
  }));
  return ok(rows);
}

/**
 * Load a thread for a row's ref. Caches the raw messages (with urns) so react()
 * can target the latest. LinkedIn omits the subtitle.
 * @param {LiSub} sub @param {{urn:string, recipientId:string, csrf:string, memberId:string}} ref
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:any}>}
 */
async function loadThread(sub, ref) {
  const csrf = (sub.ctx && sub.ctx.csrf) || ref.csrf;
  const memberId = (sub.ctx && sub.ctx.memberId) || ref.memberId;
  if (!csrf) return fail(toSourceError({ kind: 'error', message: 'not authenticated yet' }));
  const vc = await viewConversation({
    ...baseOpts(sub),
    csrf,
    conversationUrn: ref.urn,
    myMemberId: memberId,
  });
  if (!vc.ok) return fail(toSourceError(vc.error));
  sub.threads[ref.urn] = vc.data; // raw messages (urns) for react()
  // Optimistic local read-clear (no markConversationAsRead per adapter scope):
  // keeps the row visually read until the next server fetch re-lists it.
  const c = (sub.convos || []).find((x) => x.urn === ref.urn);
  if (c) c.unread = false;
  const name = c ? c.name : 'Conversation';
  return ok({
    title: name || 'Conversation',
    messages: vc.data.map((m) => ({ sender: m.sender, fromMe: m.fromMe, text: m.text, ts: m.ts })),
    canReply: true,
    canReact: true,
  });
}

/**
 * Send a reply to the conversation's recipient.
 * @param {LiSub} sub @param {{urn:string, recipientId:string, csrf:string, memberId:string}} ref @param {string} text
 * @returns {Promise<{ok:true}|{ok:false, error:any}>}
 */
async function reply(sub, ref, text) {
  const csrf = (sub.ctx && sub.ctx.csrf) || ref.csrf;
  const memberId = (sub.ctx && sub.ctx.memberId) || ref.memberId;
  if (!csrf) return fail(toSourceError({ kind: 'error', message: 'not authenticated yet' }));
  const r = await sendMessage({
    ...baseOpts(sub),
    csrf,
    myMemberId: memberId,
    recipient: ref.recipientId,
    text,
    conversationUrn: ref.urn,
  });
  if (!r.ok) return fail(toSourceError(r.error));
  return ok();
}

/**
 * React to the latest message in the open thread with `emoji`.
 * @param {LiSub} sub @param {{urn:string, csrf:string}} ref @param {string} emoji
 * @returns {Promise<{ok:true}|{ok:false, error:any}>}
 */
async function react(sub, ref, emoji) {
  const csrf = (sub.ctx && sub.ctx.csrf) || ref.csrf;
  const msgs = sub.threads[ref.urn] || [];
  const target = msgs.length ? msgs[msgs.length - 1] : null;
  if (!target || !target.urn) return fail(toSourceError({ kind: 'error', message: 'no message to react to' }));
  if (!csrf) return fail(toSourceError({ kind: 'error', message: 'not authenticated yet' }));
  const r = await reactToMessage({ ...baseOpts(sub), csrf, messageUrn: target.urn, emoji });
  if (!r.ok) return fail(toSourceError(r.error));
  return ok();
}

/**
 * Manual connect (bound to connectKey 'L'): open/reuse the LinkedIn Messages
 * tab; the next refresh re-runs ensureReady against it.
 * @param {LiSub} sub @param {object} _host
 * @returns {Promise<{ok:true}|{ok:false, error:any}>}
 */
async function connect(sub, _host) {
  const o = await openMessagingTab({ port: sub.port });
  if (!o.ok) return fail(toSourceError(o.error));
  if (o.data) sub.target = o.data;
  sub.ctx = null;
  return ok();
}

// ── Source object (default export) ───────────────────────────────────────────

export default {
  id: 'linkedin',
  label: 'LinkedIn',
  badge: { glyph: 'in', fg: '36' },
  connectKey: 'L',
  init,
  ensureReady,
  listRows,
  loadThread,
  reply,
  react,
  connect,
};
