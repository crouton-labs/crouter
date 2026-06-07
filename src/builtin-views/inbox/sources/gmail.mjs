// @ts-check
/**
 * Gmail data layer for the combined crtr `inbox` view.
 *
 * A self-contained `Source` adapter (default export) over the forked Gmail vault
 * libs (`libs/gmail`). The combined view merges N of these sources into one
 * ranked stream; this module owns Gmail's data fetching AND its own
 * discover→open→settle recovery state machine.
 *
 * Mirrors `../../linkedin/client.mjs` exactly in shape — the capture-exec
 * plumbing (buildExec / runCapture candidate-walk / classifyError), the
 * never-throw `Result` discipline, the getContext-cached-once pattern, and the
 * recovery flow (discoverTab via `capture list`, openMailTab via
 * `capture open <url>`, bounded settle-poll) — but Gmail-flavored:
 *   • the tab is `mail.google.com` (no `--target`/`--port` is consumed from the
 *     view; Gmail discovers its OWN tab),
 *   • auth context is `{xsrf, account, globals}` read once via getContext() and
 *     threaded into every later call,
 *   • errors map to a `SourceError` whose `display` the VIEW renders verbatim
 *     (the view does NOT interpret `kind`).
 *
 * Self-contained ESM, Node-builtins-only. Imports NOTHING from crtr so the build
 * can `cp -R src/builtin-views dist/builtin-views` verbatim and the view can
 * dynamically `import()` it at runtime. NOTHING here throws — every async
 * returns a `Result<T>`.
 *
 * @module inbox/sources/gmail
 */

import { execFile } from 'node:child_process';

// ── Shared data shapes (the merge currency; see inbox source contract) ───────

/**
 * One left-pane row in the merged stream.
 * @typedef {Object} UnifiedRow
 * @property {'gmail'} sourceId
 * @property {string}  key       Globally-unique selection id (`gmail:<threadId>`).
 * @property {string}  name      Sender display name / address.
 * @property {string}  snippet   Last-message preview (single line; view truncates).
 * @property {boolean} unread
 * @property {number}  ts        Epoch ms (0 if unknown).
 * @property {GmailRef} ref      Opaque source handle handed back to loadThread/reply.
 */

/**
 * Opaque per-row handle. The view never inspects this; it round-trips it back.
 * @typedef {Object} GmailRef
 * @property {string} threadId
 * @property {string} messageId  Latest message id at list time.
 * @property {string} subject
 * @property {string} fromEmail
 * @property {string} fromName
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
 * Gmail auth context, read ONCE via getContext() and cached on the sub.
 * @typedef {Object} GmailContext
 * @property {string} xsrf      XSRF token for API requests.
 * @property {number} account   Account number (0-indexed, from /u/{N}/).
 * @property {string} email     Current account email.
 * @property {{g2:number,g3:string,g9:string,g10:string}} globals  Internal Gmail values for the BTAI header.
 */

/**
 * Typed failure. `kind` drives the recovery state machine internally; `display`
 * is what the view renders (it does NOT interpret `kind`).
 * @typedef {{kind:'no-cdp'}
 *   | {kind:'no-tab'}
 *   | {kind:'not-logged-in'}
 *   | {kind:'rate-limited'}
 *   | {kind:'capture-not-dev'}
 *   | {kind:'still-loading'}
 *   | {kind:'error', message:string}} ClientError
 */

/**
 * Per-source down-state descriptor the view renders (banner + guided panel).
 * @typedef {Object} ErrorDisplay
 * @property {string} headline
 * @property {(string|string[])} [explanation]
 * @property {(string|null)} [nextStep]
 * @property {string} banner
 * @property {'info'|'action'|'error'} level
 * @property {boolean} blocking
 */

/**
 * Per-source typed error surfaced to the view.
 * @typedef {Object} SourceError
 * @property {string} kind
 * @property {ErrorDisplay} display
 */

/**
 * Never-throw return contract.
 * @template T
 * @typedef {{ok:true, data:T} | {ok:false, error:SourceError}} Result
 */

/**
 * This source's private mutable substate (stored by the view at state.subs.gmail).
 * @typedef {Object} GmailSub
 * @property {string|null} target          CDP tab id of the mail.google.com tab (discovered/opened).
 * @property {string|number|undefined} port  CDP port — Gmail does NOT consume the view's port; stays undefined (capture auto-detects).
 * @property {GmailContext|null} ctx        Cached auth context (read once).
 * @property {boolean} loginTabOpened       True once the login tab was opened this not-logged-in episode; reset on ready.
 */

/**
 * Common options threaded to capture. Gmail always discovers its own tab, so
 * `target` comes from {@link discoverTab}/{@link openMailTab}, never from the view.
 * @typedef {Object} BaseOpts
 * @property {string} [target]
 * @property {string|number} [port]
 */

// ── Config ───────────────────────────────────────────────────────────────────

/** The Gmail login / inbox URL the recovery flow opens / focuses. */
const GMAIL_URL = 'https://mail.google.com';

/**
 * Dev-checkout fallback. The Gmail vault libs are dev-checkout-only (the
 * published `capture` package throws `DEV_ONLY_MSG`), so this is the most likely
 * place a working binary lives if `capture` is not on PATH.
 */
const CAPTURE_DEV_FALLBACK = '/Users/silasrhyneer/Code/cli/capture/bin/capture';

/** The verbatim dev-only degradation message capture emits (mirrored for the panel). */
const DEV_ONLY_MSG =
  'This view needs a capture dev checkout (vault/ source + esbuild). ' +
  'Not available in the published package.';

/** Rows to request from the Gmail inbox per refresh. */
const INBOX_COUNT = 25;

/** Bounded settle-poll after an auto open (no infinite spin). */
const SETTLE_MAX = 5;
const SETTLE_INTERVAL_MS = 1200;

/** Error kinds that waiting can't fix — stop the settle-poll and guide. */
const HARD_STOP = new Set(['no-cdp', 'not-logged-in', 'capture-not-dev']);

/**
 * Binary candidates, in order: explicit override, PATH `capture`, dev checkout.
 * We try the next only when a candidate fails to spawn (ENOENT) — a candidate
 * that spawns and exits nonzero is authoritative.
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

/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) {
  return { ok: false, error };
}

/** @param {string} s @param {number} n @returns {string} */
function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── capture stderr → ClientError ─────────────────────────────────────────────

/**
 * Map a failed `capture` invocation's stderr to a typed {@link ClientError}.
 *
 * Mapping table:
 *   No browser with CDP found | fetch failed | ECONNREFUSED ... no-cdp
 *   No tab found ...................................... no-tab
 *   DEV_ONLY_MSG / dev-only feature .................. capture-not-dev
 *   RateLimited | 429 ............................... rate-limited
 *   Unauthenticated | XSRF/GLOBALS not found |
 *     not be logged in | Not on Gmail domain |
 *     Account number not found ...................... not-logged-in
 *   (anything else) ................................. error{message}
 *
 * Order matters: capture-not-dev and rate-limited are checked before the broad
 * not-logged-in patterns.
 * @param {string} stderr
 * @returns {ClientError}
 */
function classifyError(stderr) {
  const s = String(stderr || '');
  if (/No browser with CDP found/i.test(s)) return { kind: 'no-cdp' };
  // A dead/unreachable debugger port surfaces as a raw connection failure: capture
  // probes http://localhost:<port>/json/version, so an unlistened port yields
  // `fetch failed` (Node fetch wrapping ECONNREFUSED). Treat it as no-cdp.
  if (/fetch failed/i.test(s) || /failed to fetch/i.test(s) || /ECONNREFUSED/i.test(s)) {
    return { kind: 'no-cdp' };
  }
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

// ── ClientError → SourceError (the view's render payload) ─────────────────────

/**
 * Build the {@link ErrorDisplay} the view renders for a given error. The view
 * never inspects `kind`; it shows this `display` as the source's banner/panel.
 * @param {ClientError} error
 * @returns {ErrorDisplay}
 */
function buildDisplay(error) {
  const kind = error && error.kind;
  switch (kind) {
    case 'no-cdp':
      return {
        headline: 'No debuggable browser',
        explanation: 'crtr drives a browser over CDP and none is running.',
        nextStep: 'Launch Chrome with --remote-debugging-port=9222 (or Arc), then press g',
        banner: 'Gmail: no debuggable browser — launch one, then g',
        level: 'error',
        blocking: true,
      };
    case 'no-tab':
      return {
        headline: 'No Gmail tab',
        explanation: 'Open mail.google.com in the debuggable browser.',
        nextStep: 'Press G to connect',
        banner: 'Gmail: open mail.google.com, then press g',
        level: 'action',
        blocking: true,
      };
    case 'not-logged-in':
      return {
        headline: 'Log in to Gmail',
        explanation: 'Gmail needs a sign-in in the browser.',
        nextStep: 'Log in in the opened tab, then press g',
        banner: 'Gmail: log in, then press g',
        level: 'action',
        blocking: true,
      };
    case 'rate-limited':
      return {
        headline: 'Gmail is throttling',
        explanation: 'Too many requests — wait a moment before retrying.',
        nextStep: 'Press g to retry',
        banner: 'Gmail: throttled — wait, then press g',
        level: 'info',
        blocking: false,
      };
    case 'capture-not-dev':
      return {
        headline: 'Browser bridge unavailable',
        explanation: DEV_ONLY_MSG,
        nextStep: null,
        banner: 'Gmail: browser bridge unavailable — capture dev checkout required',
        level: 'error',
        blocking: true,
      };
    case 'still-loading':
      return {
        headline: 'Still loading Gmail…',
        explanation: 'Gmail is taking a while to load.',
        nextStep: 'Press g to retry',
        banner: 'Gmail: still loading — press g to retry',
        level: 'action',
        blocking: false,
      };
    case 'error':
    default: {
      const msg = (error && /** @type {any} */ (error).message) || 'Unknown error.';
      return {
        headline: 'Something went wrong',
        explanation: msg,
        nextStep: 'Press g to retry',
        banner: `Gmail: ${truncate(msg, 80)}`,
        level: 'error',
        blocking: true,
      };
    }
  }
}

/** @param {ClientError} error @returns {SourceError} */
function toSourceError(error) {
  return { kind: (error && error.kind) || 'error', display: buildDisplay(error) };
}

// ── capture command construction ─────────────────────────────────────────────

/**
 * Serialize a JS arg object as a literal safe to splice into the exec code
 * string. JSON is a near-subset of JS object-literal syntax; additionally escape
 * U+2028/U+2029 (valid in JSON strings, historically illegal in JS) so a pasted
 * reply can't break the splice.
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function jsLiteral(obj) {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build the argv + exec code string for a vault-lib call. The code string is a
 * SINGLE argv element (never a shell string) so there is no quoting to escape at
 * the process boundary. `libArgs === null` emits a no-arg call (getContext).
 * @param {string} fnName
 * @param {Record<string, unknown> | null} libArgs
 * @param {BaseOpts} [opts]
 * @returns {{argv:string[], code:string}}
 */
function buildExec(fnName, libArgs, opts) {
  const call = libArgs === null ? `${fnName}()` : `${fnName}(${jsLiteral(libArgs)})`;
  const code = `import {${fnName}} from 'libs/gmail'; return await ${call}`;
  /** @type {string[]} */
  const argv = ['exec', code];
  if (opts && opts.target) argv.push('--target', String(opts.target));
  if (opts && opts.port != null && opts.port !== '') argv.push('--port', String(opts.port));
  return { argv, code };
}

/**
 * Build the `capture list` argv (tab discovery; no CDP target).
 * @param {BaseOpts} [opts]
 * @returns {string[]}
 */
function buildListArgv(opts) {
  const argv = ['list'];
  if (opts && opts.port != null && opts.port !== '') argv.push('--port', String(opts.port));
  return argv;
}

/**
 * Build the `capture open <gmail url>` argv (open/reuse a mail.google.com tab).
 * @param {BaseOpts} [opts]
 * @returns {string[]}
 */
function buildOpenArgv(opts) {
  const argv = ['open', GMAIL_URL];
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
    argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
  );
}

// ── Process runner (never throws) ────────────────────────────────────────────

/**
 * @typedef {Object} RunResult
 * @property {boolean} spawned   False ⇒ no candidate binary could be spawned.
 * @property {number}  exitCode  Process exit code (0 on success; -1 if not spawned).
 * @property {string}  stdout
 * @property {string}  stderr
 * @property {string}  [bin]
 */

/**
 * Run one candidate binary. Resolves (never rejects). ENOENT is signalled by
 * `spawned:false` so the caller can try the next candidate.
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

/** @returns {SourceError} */
function captureMissingError() {
  return toSourceError({
    kind: 'error',
    message:
      `capture binary not found — tried CAPTURE_BIN, PATH 'capture', and dev fallback ` +
      `${CAPTURE_DEV_FALLBACK}. Install capture or set CAPTURE_BIN.`,
  });
}

/**
 * Run a vault-lib call and return the parsed JSON return value as a Result.
 * @param {string} fnName
 * @param {Record<string, unknown> | null} libArgs
 * @param {BaseOpts} opts
 * @returns {Promise<Result<any>>}
 */
async function execLib(fnName, libArgs, opts) {
  const { argv } = buildExec(fnName, libArgs, opts);
  const r = await runCapture(argv);
  if (!r.spawned) return fail(captureMissingError());
  if (r.exitCode !== 0) return fail(toSourceError(classifyError(r.stderr)));
  const out = String(r.stdout || '').trim();
  if (out === '') return ok(null);
  try {
    return ok(JSON.parse(out));
  } catch {
    return fail(
      toSourceError({ kind: 'error', message: `could not parse capture output as JSON: ${truncate(out, 300)}` })
    );
  }
}

// ── Field mappers ────────────────────────────────────────────────────────────

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

/**
 * Map a raw Gmail `MessageSummary` (one per thread) to a {@link UnifiedRow}.
 * @param {any} m
 * @returns {UnifiedRow}
 */
function toUnifiedRow(m) {
  const o = m || {};
  const threadId = typeof o.threadId === 'string' ? o.threadId : '';
  const from = o.from || {};
  return {
    sourceId: 'gmail',
    key: `gmail:${threadId}`,
    name: addrName(from),
    snippet: typeof o.snippet === 'string' && o.snippet ? o.snippet : (typeof o.subject === 'string' ? o.subject : ''),
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

/**
 * Map a raw Gmail `MessageContent` to a {@link UnifiedMessage}.
 * @param {any} m
 * @param {string} myEmail
 * @returns {UnifiedMessage}
 */
function toUnifiedMessage(m, myEmail) {
  const o = m || {};
  const from = o.from || {};
  const fromEmail = addrEmail(from);
  return {
    sender: addrName(from),
    fromMe: !!myEmail && fromEmail.toLowerCase() === myEmail.toLowerCase(),
    text: typeof o.body === 'string' && o.body ? o.body : (typeof o.snippet === 'string' ? o.snippet : ''),
    ts: asMs(o.date),
  };
}

/** Strip leading `Re:` chains, then prefix a single `Re: `. @param {string} s @returns {string} */
function reSubject(s) {
  const base = String(s || '').replace(/^\s*(re:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

// ── Recovery primitives (Gmail-flavored, mirroring linkedin/client.mjs) ──────

/** @param {string} url @returns {boolean} */
function isGmailUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'mail.google.com';
  } catch {
    return false;
  }
}

/**
 * Find a usable mail.google.com tab id via `capture list`. No Gmail tab ⇒ no-tab.
 * @param {BaseOpts} [opts]
 * @returns {Promise<Result<string>>}
 */
async function discoverTab(opts = {}) {
  const r = await runCapture(buildListArgv(opts));
  if (!r.spawned) return fail(captureMissingError());
  if (r.exitCode !== 0) return fail(toSourceError(classifyError(r.stderr)));
  let tabs;
  try {
    tabs = JSON.parse(String(r.stdout || '').trim() || '[]');
  } catch {
    return fail(
      toSourceError({ kind: 'error', message: `could not parse capture list output: ${truncate(r.stdout, 300)}` })
    );
  }
  if (!Array.isArray(tabs)) return fail(toSourceError({ kind: 'no-tab' }));
  const gmail = tabs.filter((t) => t && typeof t.url === 'string' && isGmailUrl(t.url));
  const chosen = gmail[0];
  if (chosen && chosen.id) return ok(String(chosen.id));
  return fail(toSourceError({ kind: 'no-tab' }));
}

/**
 * Open (or focus/reuse) the mail.google.com tab and return its CDP tab id. Shells
 * `capture open <url> [--port N]`, which finds an existing matching tab or opens
 * one and BLOCKS on `Page.loadEventFired` (~10s) — doing the first page settle.
 * Stdout is clean JSON `{id,title,url,port}`; we parse `.id`.
 * @param {BaseOpts} [opts]
 * @returns {Promise<Result<string>>}
 */
async function openMailTab(opts = {}) {
  const r = await runCapture(buildOpenArgv(opts));
  if (!r.spawned) return fail(captureMissingError());
  if (r.exitCode !== 0) return fail(toSourceError(classifyError(r.stderr)));
  let body;
  try {
    body = JSON.parse(String(r.stdout || '').trim() || '{}');
  } catch {
    return fail(
      toSourceError({ kind: 'error', message: `could not parse capture open output: ${truncate(r.stdout, 300)}` })
    );
  }
  if (body && body.id) return ok(String(body.id));
  return fail(toSourceError({ kind: 'error', message: 'capture open returned no tab id' }));
}

/** @param {GmailSub} sub @returns {BaseOpts} */
function baseOpts(sub) {
  /** @type {BaseOpts} */
  const o = {};
  if (sub.target) o.target = sub.target;
  if (sub.port != null && sub.port !== '') o.port = sub.port;
  return o;
}

/**
 * Read the page auth context. Call ONCE; cache `{xsrf, account, globals}` and
 * thread them into later calls.
 * @param {BaseOpts} opts
 * @returns {Promise<Result<GmailContext>>}
 */
async function getContext(opts) {
  const r = await execLib('getContext', null, opts);
  if (!r.ok) return r;
  const d = r.data || {};
  if (!d.xsrf || d.account == null || !d.globals) {
    return fail(toSourceError({ kind: 'error', message: 'getContext() returned no xsrf/account/globals' }));
  }
  return ok({
    xsrf: String(d.xsrf),
    account: Number(d.account),
    email: typeof d.email === 'string' ? d.email : '',
    globals: d.globals,
  });
}

/**
 * One readiness attempt: discover the tab (unless known), then read auth context
 * once. Returns a Result-shaped value — never throws.
 * @param {GmailSub} sub
 * @returns {Promise<Result<void>>}
 */
async function attemptReady(sub) {
  if (!sub.target) {
    const r = await discoverTab(baseOpts(sub));
    if (!r.ok) return r;
    sub.target = r.data;
  }
  if (!sub.ctx) {
    const r = await getContext(baseOpts(sub));
    if (!r.ok) return r;
    sub.ctx = r.data;
  }
  return ok(undefined);
}

/** Mark ready: reset the once-per-episode login-tab gate. @param {GmailSub} sub */
function markReady(sub) {
  sub.loginTabOpened = false;
}

/**
 * Bounded settle-poll after an auto open: retry readiness up to SETTLE_MAX times
 * spaced SETTLE_INTERVAL_MS. On success → ready. On a hard-stop error → guide.
 * On exhaustion → a `still-loading` action display (no infinite spin).
 * @param {GmailSub} sub
 * @param {any} [host]
 * @returns {Promise<Result<void>>}
 */
async function settlePoll(sub, host) {
  for (let i = 1; i <= SETTLE_MAX; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    note(host, `Loading Gmail… (${i})`);
    const r = await attemptReady(sub);
    if (r.ok) {
      markReady(sub);
      return ok(undefined);
    }
    if (HARD_STOP.has(r.error.kind)) return r;
    // transient (no-tab / rate-limited / error) → keep polling
  }
  return fail(toSourceError({ kind: 'still-loading' }));
}

/**
 * Optional progress narration. The host may expose `setStatus`; guard it so this
 * module stays decoupled from any specific view.
 * @param {any} host @param {string} msg
 */
function note(host, msg) {
  if (host && typeof host.setStatus === 'function') {
    try {
      host.setStatus(msg);
    } catch {
      /* never throw */
    }
  }
}

// ── Source object (default export) ───────────────────────────────────────────

export default {
  id: 'gmail',
  label: 'Gmail',
  badge: { glyph: '@', fg: '31' },
  connectKey: 'G',

  /**
   * Build this source's private mutable substate. Cheap, sync. Gmail discovers
   * its OWN mail.google.com tab — it does NOT consume the view's `--target`/
   * `--port` (those apply to LinkedIn only), so `target`/`port` start unset.
   * @param {any} [_host]
   * @returns {GmailSub}
   */
  init(_host) {
    return { target: null, port: undefined, ctx: null, loginTabOpened: false };
  },

  /**
   * Discover tab → auth → settle, mutating `sub` in place. Owns the full recovery
   * state machine: a direct attempt, then on failure an error-kind-driven branch
   * (no-tab → open + bounded settle-poll; not-logged-in → open the login tab once
   * per episode then guide; hard stops / rate-limit / generic → guide). Returns
   * ok when ready; otherwise a {@link SourceError} whose `display` the view shows.
   * @param {GmailSub} sub
   * @param {any} [host]
   * @returns {Promise<Result<void>>}
   */
  async ensureReady(sub, host) {
    // Direct attempt first.
    let r = await attemptReady(sub);
    if (r.ok) {
      markReady(sub);
      return ok(undefined);
    }
    const kind = r.error.kind;

    // no-tab → open a Gmail tab, then bounded settle-poll.
    if (kind === 'no-tab') {
      note(host, 'Opening Gmail…');
      const o = await openMailTab(baseOpts(sub));
      if (!o.ok) return o;
      sub.target = o.data;
      sub.ctx = null; // re-read auth for the (possibly new) tab
      return await settlePoll(sub, host);
    }

    // not-logged-in → open the Gmail tab ONCE so the login page is visible, then
    // STOP and guide. Logged out, Gmail redirects away from mail.google.com, so
    // a NEW tab would otherwise be spawned on EVERY auto-refresh; gate to once
    // per episode (markReady resets the flag on a later success).
    if (kind === 'not-logged-in') {
      if (!sub.loginTabOpened) {
        const o = await openMailTab(baseOpts(sub));
        if (o.ok && o.data) sub.target = o.data;
        sub.loginTabOpened = true;
      }
      return r;
    }

    // hard stops (no-cdp, capture-not-dev), rate-limit, and generic → guide.
    return r;
  },

  /**
   * List inbox rows for the merged stream (one per thread, latest message).
   * Caller only invokes after ensureReady ok, so `sub.ctx` is set.
   * @param {GmailSub} sub
   * @returns {Promise<Result<UnifiedRow[]>>}
   */
  async listRows(sub) {
    if (!sub.ctx) return fail(toSourceError({ kind: 'error', message: 'listRows called before ready' }));
    const r = await execLib(
      'listInbox',
      { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, count: INBOX_COUNT },
      baseOpts(sub)
    );
    if (!r.ok) return r;
    const arr = r.data && Array.isArray(r.data.messages) ? r.data.messages : [];
    return ok(arr.map(toUnifiedRow));
  },

  /**
   * Load the full thread for a selected row's `ref`.
   * @param {GmailSub} sub
   * @param {GmailRef} ref
   * @returns {Promise<Result<UnifiedThread>>}
   */
  async loadThread(sub, ref) {
    if (!sub.ctx) return fail(toSourceError({ kind: 'error', message: 'loadThread called before ready' }));
    const threadId = ref && ref.threadId ? ref.threadId : '';
    if (!threadId) return fail(toSourceError({ kind: 'error', message: 'loadThread: missing threadId' }));
    const r = await execLib(
      'readEmail',
      { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, threadId },
      baseOpts(sub)
    );
    if (!r.ok) return r;
    const msgs = r.data && Array.isArray(r.data.messages) ? r.data.messages : [];
    const myEmail = sub.ctx.email || '';
    const first = msgs[0] || {};
    const last = msgs[msgs.length - 1] || {};
    const title =
      (typeof first.subject === 'string' && first.subject) || (ref && ref.subject) || '(no subject)';
    const fromAddr = addrEmail(last.from) || addrEmail(first.from);
    const toAddr = (last.to && last.to[0] && addrEmail(last.to[0])) || (first.to && first.to[0] && addrEmail(first.to[0])) || '';
    const subtitle = fromAddr || toAddr ? `from ${fromAddr || '—'} · to ${toAddr || '—'}` : undefined;
    /** @type {UnifiedThread} */
    const thread = {
      title,
      ...(subtitle ? { subtitle } : {}),
      messages: msgs.map((/** @type {any} */ m) => toUnifiedMessage(m, myEmail)),
      canReply: true,
      canReact: false,
    };
    return ok(thread);
  },

  /**
   * Send a reply in the thread identified by `ref`. Reads the thread first to
   * resolve the message being replied to + the counterpart address (a private
   * reply to the latest non-self sender; CC is not inherited).
   * @param {GmailSub} sub
   * @param {GmailRef} ref
   * @param {string} text
   * @returns {Promise<Result<void>>}
   */
  async reply(sub, ref, text) {
    if (!sub.ctx) return fail(toSourceError({ kind: 'error', message: 'reply called before ready' }));
    const threadId = ref && ref.threadId ? ref.threadId : '';
    if (!threadId) return fail(toSourceError({ kind: 'error', message: 'reply: missing threadId' }));
    const body = String(text == null ? '' : text);
    if (!body.trim()) return fail(toSourceError({ kind: 'error', message: 'reply: empty body' }));

    // Read the thread to resolve originalMsgId + recipient.
    const read = await execLib(
      'readEmail',
      { xsrf: sub.ctx.xsrf, account: sub.ctx.account, globals: sub.ctx.globals, threadId },
      baseOpts(sub)
    );
    if (!read.ok) return read;
    const msgs = read.data && Array.isArray(read.data.messages) ? read.data.messages : [];
    if (msgs.length === 0) return fail(toSourceError({ kind: 'error', message: 'reply: thread has no messages' }));
    const myEmail = (sub.ctx.email || '').toLowerCase();
    const latest = msgs[msgs.length - 1] || {};
    const originalMsgId = typeof latest.messageId === 'string' ? latest.messageId : (ref && ref.messageId) || '';
    if (!originalMsgId) return fail(toSourceError({ kind: 'error', message: 'reply: could not resolve message id' }));

    // Reply to the latest message NOT sent by me; fall back to the latest message's
    // recipients, then to the row's cached sender.
    /** @type {any} */
    let target = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const fe = addrEmail((msgs[i] || {}).from).toLowerCase();
      if (fe && fe !== myEmail) {
        target = msgs[i];
        break;
      }
    }
    let toEmail = target ? addrEmail(target.from) : '';
    if (!toEmail) toEmail = (latest.to && latest.to[0] && addrEmail(latest.to[0])) || '';
    if (!toEmail && ref && ref.fromEmail) toEmail = ref.fromEmail;
    if (!toEmail) return fail(toSourceError({ kind: 'error', message: 'reply: could not determine recipient' }));

    const subject = reSubject((target && target.subject) || latest.subject || (ref && ref.subject) || '');

    const send = await execLib(
      'replyEmail',
      {
        xsrf: sub.ctx.xsrf,
        account: sub.ctx.account,
        globals: sub.ctx.globals,
        threadId,
        originalMsgId,
        to: toEmail,
        subject,
        body,
      },
      baseOpts(sub)
    );
    if (!send.ok) return send;
    const out = send.data || {};
    if (out.success === false) {
      return fail(toSourceError({ kind: 'error', message: 'Gmail rejected the reply' }));
    }
    return ok(undefined);
  },

  /**
   * Manual connect (bound to connectKey `G`): open/focus the Gmail tab; the next
   * refresh re-runs ensureReady. Clears the cached auth so it re-reads on the
   * (possibly switched) tab.
   * @param {GmailSub} sub
   * @param {any} [host]
   * @returns {Promise<Result<void>>}
   */
  async connect(sub, host) {
    note(host, 'Opening Gmail…');
    const o = await openMailTab(baseOpts(sub));
    if (!o.ok) return o;
    sub.target = o.data;
    sub.ctx = null;
    sub.loginTabOpened = true; // we just opened it; don't double-open on the next ensureReady
    return ok(undefined);
  },
};

/**
 * Introspection helper (not used at runtime): render the exact `capture` command
 * each call constructs, with placeholder args, so the command shape can be
 * eyeballed without a live browser.
 * @param {BaseOpts} [opts]
 * @returns {Record<string, string>}
 */
export function describeCommands(opts = {}) {
  const o = { target: opts.target || '<tabId>', port: opts.port };
  const g = { g2: 0, g3: '<g3>', g9: '<g9>', g10: '<email>' };
  return {
    discoverTab: toDisplay(buildListArgv(o)),
    openMailTab: toDisplay(buildOpenArgv(o)),
    getContext: toDisplay(buildExec('getContext', null, o).argv),
    listInbox: toDisplay(buildExec('listInbox', { xsrf: '<xsrf>', account: 0, globals: g, count: INBOX_COUNT }, o).argv),
    readEmail: toDisplay(buildExec('readEmail', { xsrf: '<xsrf>', account: 0, globals: g, threadId: '<threadId>' }, o).argv),
    replyEmail: toDisplay(
      buildExec(
        'replyEmail',
        { xsrf: '<xsrf>', account: 0, globals: g, threadId: '<threadId>', originalMsgId: '<msgId>', to: '<email>', subject: 'Re: …', body: 'hello' },
        o
      ).argv
    ),
  };
}
