// @ts-check
/**
 * LinkedIn data layer for the crtr `linkedin` view (Phase A).
 *
 * Self-contained ESM, Node-builtins-only. Imports NOTHING from crtr so it can be
 * shipped verbatim (`cp -R src/builtin-views dist/builtin-views`) and dynamically
 * `import()`ed by the view at runtime where there is no TS toolchain.
 *
 * It wraps the `capture` CLI (`capture exec "<js>" --target <tabId> [--port N]`),
 * which esbuild-bundles the forked LinkedIn vault libs and `Runtime.evaluate`s
 * them inside the logged-in LinkedIn browser page over CDP. Each call is a fresh
 * `capture` process (~1–3s); the view calls `getContext()` ONCE and threads
 * `csrf`/`memberId` explicitly on every later call to skip re-auth round-trips.
 *
 * NOTHING here throws. Every exported function returns a `Result<T>` discriminated
 * union; failures surface as a typed `ClientError` so the view can render guidance
 * instead of crashing.
 *
 * @module linkedin/client
 */

import { execFile } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Auth context read once from the page session via `getContext()`.
 * @typedef {Object} LiContext
 * @property {string} csrf      CSRF token (form `"ajax:<digits>"`), from the JSESSIONID cookie.
 * @property {string} memberId  Current user member ID (`ACo…`).
 */

/**
 * One inbox conversation, flattened from the vault `listConversations` shape.
 * @typedef {Object} Conversation
 * @property {string}  urn          Conversation URN (`urn:li:msg_conversation:(…)`).
 * @property {string}  name         Display name: group title, else first participant's name.
 * @property {string}  lastMessage  Text of the most recent message.
 * @property {boolean} unread       True when `unreadCount > 0`.
 * @property {number}  ts           Last-activity time as epoch ms (0 if unknown).
 * @property {string}  recipientId  `participants[0].memberId` (the 1:1 counterpart; '' for empty/group).
 */

/**
 * One message in a thread, flattened from the vault `viewConversation` shape.
 * @typedef {Object} Message
 * @property {string}  urn     Message URN (`urn:li:msg_message:(…)`).
 * @property {string}  sender  Sender full name.
 * @property {string}  text    Message body text.
 * @property {number}  ts      Delivery time as epoch ms (0 if unknown).
 * @property {boolean} fromMe  True when the sender's member ID equals the caller's `myMemberId`.
 */

/**
 * Typed failure. `kind` drives the guidance banner the view shows; `error` only
 * for the `error` catch-all carries a raw message.
 * @typedef {{kind:'no-cdp'}
 *   | {kind:'no-tab'}
 *   | {kind:'not-logged-in'}
 *   | {kind:'not-messaging'}
 *   | {kind:'rate-limited'}
 *   | {kind:'not-connection'}
 *   | {kind:'capture-not-dev'}
 *   | {kind:'error', message:string}} ClientError
 */

/**
 * Never-throw return contract. `ok:true` carries data; `ok:false` carries a typed error.
 * @template T
 * @typedef {{ok:true, data:T} | {ok:false, error:ClientError}} Result
 */

/**
 * Common options every function accepts. `target` is the CDP tab id from
 * {@link discoverTab}; `port` (string|number) skips capture's port auto-detection.
 * @typedef {Object} BaseOpts
 * @property {string} [target]      CDP tab id (`--target`). Omit ⇒ capture falls back to $CDP_TARGET/session.
 * @property {string|number} [port] CDP port (`--port`); optional speed-up.
 */

// ── Config: locating the `capture` binary ────────────────────────────────────

/**
 * Dev-checkout fallback. The LinkedIn vault libs are dev-checkout-only (the
 * published `capture` package throws `DEV_ONLY_MSG`), so this path is the most
 * likely place a working binary lives if `capture` is not on PATH.
 */
const CAPTURE_DEV_FALLBACK = '/Users/silasrhyneer/Code/cli/capture/bin/capture';

/**
 * Binary candidates, in order. Prefer an explicit override, then PATH `capture`,
 * then the dev checkout. We try the next only when a candidate fails to spawn
 * (ENOENT) — a candidate that spawns and exits nonzero is authoritative.
 * @returns {string[]}
 */
function captureCandidates() {
  const out = [];
  if (process.env.CAPTURE_BIN) out.push(process.env.CAPTURE_BIN);
  out.push('capture');
  out.push(CAPTURE_DEV_FALLBACK);
  return out;
}

// ── Result helpers ───────────────────────────────────────────────────────────

/** @template T @param {T} data @returns {Result<T>} */
function ok(data) {
  return { ok: true, data };
}

/** @param {ClientError} error @returns {{ok:false, error:ClientError}} */
function fail(error) {
  return { ok: false, error };
}

// ── capture stderr → ClientError mapping ─────────────────────────────────────

/**
 * Map a failed `capture` invocation's stderr to a typed {@link ClientError}.
 *
 * Mapping table (kept in lockstep with the crtr-views spec "Data model"):
 *   No browser with CDP found ............................. no-cdp
 *   No tab found ......................................... no-tab
 *   Unauthenticated ..................................... not-logged-in
 *   Messaging queryId not found | Navigate to /messaging/  not-messaging
 *   RateLimited | 429 ................................... rate-limited
 *   must be a 1st-degree connection .................... not-connection
 *   DEV_ONLY_MSG ....................................... capture-not-dev
 *   (anything else) .................................... error{message}
 *
 * @param {string} stderr
 * @returns {ClientError}
 */
function classifyError(stderr) {
  const s = String(stderr || '');
  if (/No browser with CDP found/i.test(s)) return { kind: 'no-cdp' };
  if (/No tab found/i.test(s)) return { kind: 'no-tab' };
  if (/Unauthenticated/i.test(s)) return { kind: 'not-logged-in' };
  if (/Messaging queryId not found/i.test(s) || /Navigate to \/messaging\//i.test(s)) {
    return { kind: 'not-messaging' };
  }
  if (/RateLimited/i.test(s) || /\b429\b/.test(s)) return { kind: 'rate-limited' };
  if (/must be a 1st-degree connection/i.test(s)) return { kind: 'not-connection' };
  if (/DEV_ONLY_MSG/i.test(s)) return { kind: 'capture-not-dev' };
  return { kind: 'error', message: extractErrorMessage(s) };
}

/**
 * Pull a human message out of capture stderr: prefer the last `ERROR:` line,
 * else the last non-empty line, else a generic fallback.
 * @param {string} stderr
 * @returns {string}
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

// ── capture command construction ─────────────────────────────────────────────

/**
 * Serialize a JS arg object as a literal safe to splice into the exec code
 * string. JSON is a near-subset of JS object-literal syntax; we additionally
 * escape U+2028/U+2029 (valid in JSON strings, historically illegal in JS) so a
 * pasted reply can't break the splice.
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function jsLiteral(obj) {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build the argv (for `execFile`) and the exec code string for a vault-lib call.
 * The code string is a SINGLE argv element — passed as an array element, never a
 * shell string — so there is no quoting to escape at the process boundary.
 * `libArgs === null` emits a no-arg call (used by getContext).
 *
 * @param {string} fnName
 * @param {Record<string, unknown> | null} libArgs
 * @param {BaseOpts} [opts]
 * @returns {{argv:string[], code:string}}
 */
function buildExec(fnName, libArgs, opts) {
  const call = libArgs === null ? `${fnName}()` : `${fnName}(${jsLiteral(libArgs)})`;
  const code = `import {${fnName}} from 'libs/linkedin'; return await ${call}`;
  /** @type {string[]} */
  const argv = ['exec', code];
  if (opts && opts.target) argv.push('--target', String(opts.target));
  if (opts && opts.port != null && opts.port !== '') argv.push('--port', String(opts.port));
  return { argv, code };
}

/**
 * Build the `capture list` argv (tab discovery; no CDP, no target).
 * @param {BaseOpts} [opts]
 * @returns {string[]}
 */
function buildListArgv(opts) {
  const argv = ['list'];
  if (opts && opts.port != null && opts.port !== '') argv.push('--port', String(opts.port));
  return argv;
}

/**
 * Render an argv as the human-readable shell command (for logs/eyeballing). The
 * code element (which contains spaces) gets double-quoted; nothing is executed.
 * @param {string[]} argv
 * @returns {string}
 */
function toDisplay(argv) {
  return (
    'capture ' +
    argv
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ')
  );
}

// ── Process runner (never throws) ────────────────────────────────────────────

/**
 * @typedef {Object} RunResult
 * @property {boolean} spawned   False ⇒ no candidate binary could be spawned.
 * @property {number}  exitCode  Process exit code (0 on success; -1 if not spawned).
 * @property {string}  stdout
 * @property {string}  stderr
 * @property {string}  [bin]     Which candidate actually ran.
 */

/**
 * Run one candidate binary. Resolves (never rejects). `spawnError` (ENOENT) is
 * signalled by `spawned:false` so the caller can try the next candidate.
 * @param {string} bin
 * @param {string[]} argv
 * @returns {Promise<RunResult>}
 */
function runOnce(bin, argv) {
  return new Promise((resolve) => {
    execFile(
      bin,
      argv,
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errOut = typeof stderr === 'string' ? stderr : '';
        if (err && /** @type {any} */ (err).code === 'ENOENT') {
          resolve({ spawned: false, exitCode: -1, stdout: out, stderr: errOut, bin });
          return;
        }
        const code = err
          ? typeof /** @type {any} */ (err).code === 'number'
            ? /** @type {any} */ (err).code
            : 1
          : 0;
        resolve({ spawned: true, exitCode: code, stdout: out, stderr: errOut, bin });
      }
    );
  });
}

/**
 * Run `capture` with the given argv, walking the candidate list until one spawns.
 * @param {string[]} argv
 * @returns {Promise<RunResult>}
 */
async function runCapture(argv) {
  let last = /** @type {RunResult} */ ({ spawned: false, exitCode: -1, stdout: '', stderr: '' });
  for (const bin of captureCandidates()) {
    last = await runOnce(bin, argv);
    if (last.spawned) return last;
  }
  return last; // never spawned
}

/** @returns {ClientError} */
function captureMissingError() {
  return {
    kind: 'error',
    message:
      `capture binary not found — tried CAPTURE_BIN, PATH 'capture', and dev fallback ` +
      `${CAPTURE_DEV_FALLBACK}. Install capture or set CAPTURE_BIN.`,
  };
}

/**
 * Run a vault-lib call and return the parsed JSON return value as a Result. The
 * generic path; per-function wrappers map the raw value into the view's types.
 * @param {string} fnName
 * @param {Record<string, unknown> | null} libArgs
 * @param {BaseOpts} opts
 * @returns {Promise<Result<any>>}
 */
async function execLib(fnName, libArgs, opts) {
  const { argv } = buildExec(fnName, libArgs, opts);
  const r = await runCapture(argv);
  if (!r.spawned) return fail(captureMissingError());
  if (r.exitCode !== 0) return fail(classifyError(r.stderr));
  const out = String(r.stdout || '').trim();
  if (out === '') return ok(null);
  try {
    return ok(JSON.parse(out));
  } catch {
    return fail({ kind: 'error', message: `could not parse capture output as JSON: ${truncate(out, 300)}` });
  }
}

/** @param {string} s @param {number} n @returns {string} */
function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ── Field mappers ────────────────────────────────────────────────────────────

/** @param {unknown} iso @returns {number} */
function parseTs(iso) {
  if (typeof iso !== 'string' || iso === '') return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * @param {any} c raw vault conversation
 * @returns {Conversation}
 */
function toConversation(c) {
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
 * @param {any} m raw vault message
 * @param {string} myMemberId
 * @returns {Message}
 */
function toMessage(m, myMemberId) {
  const o = m || {};
  return {
    urn: typeof o.messageUrn === 'string' ? o.messageUrn : '',
    sender: typeof o.fromName === 'string' ? o.fromName : '',
    text: typeof o.text === 'string' ? o.text : '',
    ts: parseTs(o.sentAt),
    fromMe: !!myMemberId && o.fromMemberId === myMemberId,
  };
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Find a usable CDP tab id. Runs `capture list`, parses the JSON, and returns the
 * first LinkedIn `/messaging/` tab (preferred), else any LinkedIn tab. No
 * LinkedIn tab ⇒ `no-tab`.
 * @param {BaseOpts} [opts]
 * @returns {Promise<Result<string>>}
 */
export async function discoverTab(opts = {}) {
  const r = await runCapture(buildListArgv(opts));
  if (!r.spawned) return fail(captureMissingError());
  if (r.exitCode !== 0) return fail(classifyError(r.stderr));
  let tabs;
  try {
    tabs = JSON.parse(String(r.stdout || '').trim() || '[]');
  } catch {
    return fail({ kind: 'error', message: `could not parse capture list output: ${truncate(r.stdout, 300)}` });
  }
  if (!Array.isArray(tabs)) return fail({ kind: 'no-tab' });
  const linkedin = tabs.filter((t) => t && typeof t.url === 'string' && isLinkedInUrl(t.url));
  const messaging = linkedin.find((t) => /\/messaging\//i.test(t.url));
  const chosen = messaging || linkedin[0];
  if (chosen && chosen.id) return ok(String(chosen.id));
  return fail({ kind: 'no-tab' });
}

/**
 * Read the page auth context. Call ONCE; cache `csrf`+`memberId` and thread them
 * into later calls.
 * @param {BaseOpts} [opts]
 * @returns {Promise<Result<LiContext>>}
 */
export async function getContext(opts = {}) {
  const r = await execLib('getContext', null, opts);
  if (!r.ok) return r;
  const d = r.data || {};
  if (!d.csrf || !d.memberId) {
    return fail({ kind: 'error', message: 'getContext() returned no csrf/memberId' });
  }
  return ok({ csrf: String(d.csrf), memberId: String(d.memberId) });
}

/**
 * List recent inbox conversations (newest-first from LinkedIn). Sorting
 * unread-first is the VIEW's job; here we only map fields.
 * @param {BaseOpts & {csrf?:string, memberId?:string, count?:number}} opts
 * @returns {Promise<Result<Conversation[]>>}
 */
export async function listConversations(opts) {
  const count = opts && typeof opts.count === 'number' ? opts.count : 20;
  /** @type {Record<string, unknown>} */
  const libArgs = { count };
  if (opts && opts.csrf) libArgs.csrf = opts.csrf;
  if (opts && opts.memberId) libArgs.memberId = opts.memberId;
  const r = await execLib('listConversations', libArgs, opts);
  if (!r.ok) return r;
  const arr = r.data && Array.isArray(r.data.conversations) ? r.data.conversations : [];
  return ok(arr.map(toConversation));
}

/**
 * Load a conversation's messages (oldest-first, up to ~40). `fromMe` is set by
 * comparing each sender's member ID to `opts.myMemberId`.
 * @param {BaseOpts & {csrf:string, conversationUrn:string, myMemberId?:string}} opts
 * @returns {Promise<Result<Message[]>>}
 */
export async function viewConversation(opts) {
  const libArgs = { csrf: opts.csrf, conversationUrn: opts.conversationUrn };
  const r = await execLib('viewConversation', libArgs, opts);
  if (!r.ok) return r;
  const arr = r.data && Array.isArray(r.data.messages) ? r.data.messages : [];
  const myId = (opts && opts.myMemberId) || '';
  return ok(arr.map((/** @type {any} */ m) => toMessage(m, myId)));
}

/**
 * Send a message to a 1st-degree connection (optionally replying within
 * `conversationUrn`). The 422 "must be a 1st-degree connection" maps to
 * `not-connection` whether it arrives as exit-1 stderr OR as a `{success:false}`
 * body.
 * @param {BaseOpts & {csrf:string, myMemberId:string, recipient:string, text:string, conversationUrn?:string}} opts
 * @returns {Promise<Result<void>>}
 */
export async function sendMessage(opts) {
  /** @type {Record<string, unknown>} */
  const libArgs = {
    csrf: opts.csrf,
    myMemberId: opts.myMemberId,
    recipient: opts.recipient,
    text: opts.text,
  };
  if (opts.conversationUrn) libArgs.conversationUrn = opts.conversationUrn;
  const r = await execLib('sendMessage', libArgs, opts);
  if (!r.ok) return r; // stderr-mapped errors (incl. 422 → not-connection)
  const body = r.data || {};
  if (body.success === false) {
    const msg = typeof body.error === 'string' ? body.error : 'send failed';
    if (/1st-degree connection/i.test(msg)) return fail({ kind: 'not-connection' });
    return fail({ kind: 'error', message: msg });
  }
  return ok(undefined);
}

/**
 * Mark a conversation as read (acknowledges its latest message).
 * @param {BaseOpts & {csrf:string, conversationUrn:string}} opts
 * @returns {Promise<Result<void>>}
 */
export async function markConversationAsRead(opts) {
  const r = await execLib('markConversationAsRead', { csrf: opts.csrf, conversationUrn: opts.conversationUrn }, opts);
  if (!r.ok) return r;
  return ok(undefined);
}

/**
 * Add an emoji reaction to a message.
 * @param {BaseOpts & {csrf:string, messageUrn:string, emoji:string}} opts
 * @returns {Promise<Result<void>>}
 */
export async function reactToMessage(opts) {
  const r = await execLib('reactToMessage', { csrf: opts.csrf, messageUrn: opts.messageUrn, emoji: opts.emoji }, opts);
  if (!r.ok) return r;
  const body = r.data || {};
  if (body.success === false) return fail({ kind: 'error', message: 'LinkedIn rejected the reaction' });
  return ok(undefined);
}

/**
 * Introspection helper (not used at runtime): render the exact `capture` command
 * each function constructs, with placeholder args, so the command shape can be
 * eyeballed without a live browser.
 * @param {BaseOpts} [opts]
 * @returns {Record<string, string>}
 */
export function describeCommands(opts = {}) {
  const o = { target: opts.target || '<tabId>', port: opts.port };
  return {
    discoverTab: toDisplay(buildListArgv(o)),
    getContext: toDisplay(buildExec('getContext', null, o).argv),
    listConversations: toDisplay(
      buildExec('listConversations', { count: 20, csrf: '<csrf>', memberId: '<memberId>' }, o).argv
    ),
    viewConversation: toDisplay(
      buildExec('viewConversation', { csrf: '<csrf>', conversationUrn: '<conversationUrn>' }, o).argv
    ),
    sendMessage: toDisplay(
      buildExec(
        'sendMessage',
        { csrf: '<csrf>', myMemberId: '<memberId>', recipient: '<recipientId>', text: 'hello' },
        o
      ).argv
    ),
    markConversationAsRead: toDisplay(
      buildExec('markConversationAsRead', { csrf: '<csrf>', conversationUrn: '<conversationUrn>' }, o).argv
    ),
    reactToMessage: toDisplay(
      buildExec('reactToMessage', { csrf: '<csrf>', messageUrn: '<messageUrn>', emoji: '👍' }, o).argv
    ),
  };
}
