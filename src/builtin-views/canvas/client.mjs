// @ts-check
/**
 * Canvas data layer for the crtr `canvas` view (the monitor archetype).
 *
 * Self-contained ESM, Node-builtins-only. Imports NOTHING from crtr so it ships
 * verbatim (`cp -R src/builtin-views dist/builtin-views`) and is dynamically
 * `import()`ed by the view at runtime where there is no TS toolchain.
 *
 * It shells the `crtr` binary itself — exactly as the LinkedIn view shells
 * `capture`. Two read-only `--json` leaves give the whole graph:
 *   - `crtr node inspect list --json`   → every node row, incl. `parent` (so the
 *                                          view rebuilds the forest) + `lifecycle`.
 *   - `crtr canvas attention list --json` → which nodes have pending human asks
 *                                          (the "blocked on a human" signal).
 * Both are read-only (query canvas.db) and exit 0. No `--json` affordance was
 * missing — every command we need already emits machine-readable JSON.
 *
 * NOTHING here throws. Every exported function returns a `Result<T>`; failures
 * surface as a typed `ClientError` so the view renders guidance, not a crash.
 *
 * NOTE on the crtr help-gate: that gate is a pi-side `bash` tool-call
 * interceptor — it inspects the AGENT's command string. A `crtr` spawned from
 * inside the view host (a grandchild of `node dist/cli.js view run`) is not a
 * tool call pi can see, so these shell-outs are never gated.
 *
 * @module canvas/client
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One canvas node, flattened from `node inspect list --json`.
 * @typedef {Object} CanvasNode
 * @property {string} nodeId      Full node id (`<time>-<hash>`).
 * @property {string} name        Display name.
 * @property {string} kind        Node kind (general/developer/explore/human/…).
 * @property {string} mode        base | orchestrator.
 * @property {string} lifecycle   resident | terminal.
 * @property {string} status      active | idle | done | dead | canceled.
 * @property {string|null} parent Spawn/subscription parent id (null ⇒ a forest root).
 * @property {string} created     ISO 8601 birth timestamp (drives child ordering).
 */

/**
 * One cwd with pending human asks, from `canvas attention list --json`. The
 * `nodeId` is the cwd's representative node — the node the attention system
 * points at.
 * @typedef {Object} AttentionItem
 * @property {string} nodeId
 * @property {string} name
 * @property {string} cwd
 * @property {number} count    Pending ask count.
 */

/**
 * Typed failure. `kind` drives the guidance banner the view shows.
 * @typedef {{kind:'crtr-missing', message:string}
 *   | {kind:'crtr-failed', message:string}
 *   | {kind:'parse', message:string}
 *   | {kind:'error', message:string}} ClientError
 */

/**
 * Never-throw return contract.
 * @template T
 * @typedef {{ok:true, data:T} | {ok:false, error:ClientError}} Result
 */

// ── Result helpers ───────────────────────────────────────────────────────────

/** @template T @param {T} data @returns {Result<T>} */
function ok(data) {
  return { ok: true, data };
}

/** @param {ClientError} error @returns {{ok:false, error:ClientError}} */
function fail(error) {
  return { ok: false, error };
}

// ── Locating the `crtr` binary ───────────────────────────────────────────────

/**
 * One candidate way to invoke crtr: a binary plus any fixed prefix args.
 * @typedef {Object} Candidate
 * @property {string} bin
 * @property {string[]} prefix
 */

/**
 * Candidates, in order: explicit override → PATH `crtr` → PATH `crouter` → the
 * dev fallback `node <dist/cli.js>` resolved relative to THIS file (which, when
 * shipped, lives at `dist/builtin-views/canvas/client.mjs`, so `../../cli.js` is
 * `dist/cli.js`). We try the next only when a candidate fails to spawn (ENOENT);
 * a candidate that spawns and exits nonzero is authoritative.
 * @returns {Candidate[]}
 */
function crtrCandidates() {
  /** @type {Candidate[]} */
  const out = [];
  if (process.env.CRTR_BIN) out.push({ bin: process.env.CRTR_BIN, prefix: [] });
  out.push({ bin: 'crtr', prefix: [] });
  out.push({ bin: 'crouter', prefix: [] });
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // …/dist/builtin-views/canvas
    const cli = join(here, '..', '..', 'cli.js'); // …/dist/cli.js
    if (existsSync(cli)) out.push({ bin: process.execPath, prefix: [cli] });
  } catch {
    /* import.meta.url unavailable — skip the dev fallback */
  }
  return out;
}

// ── Process runner (never throws) ────────────────────────────────────────────

/**
 * @typedef {Object} RunResult
 * @property {boolean} spawned   False ⇒ no candidate binary could be spawned.
 * @property {number}  exitCode  Process exit code (0 on success; -1 if not spawned).
 * @property {string}  stdout
 * @property {string}  stderr
 */

/**
 * Run one candidate. Resolves (never rejects). ENOENT ⇒ `spawned:false` so the
 * caller can try the next candidate.
 * @param {Candidate} c
 * @param {string[]} argv
 * @returns {Promise<RunResult>}
 */
function runOnce(c, argv) {
  return new Promise((resolve) => {
    execFile(
      c.bin,
      [...c.prefix, ...argv],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errOut = typeof stderr === 'string' ? stderr : '';
        if (err && /** @type {any} */ (err).code === 'ENOENT') {
          resolve({ spawned: false, exitCode: -1, stdout: out, stderr: errOut });
          return;
        }
        const code = err
          ? typeof /** @type {any} */ (err).code === 'number'
            ? /** @type {any} */ (err).code
            : 1
          : 0;
        resolve({ spawned: true, exitCode: code, stdout: out, stderr: errOut });
      }
    );
  });
}

/**
 * Run `crtr` with the given argv, walking candidates until one spawns.
 * @param {string[]} argv
 * @returns {Promise<RunResult>}
 */
async function runCrtr(argv) {
  /** @type {RunResult} */
  let last = { spawned: false, exitCode: -1, stdout: '', stderr: '' };
  for (const c of crtrCandidates()) {
    last = await runOnce(c, argv);
    if (last.spawned) return last;
  }
  return last; // never spawned
}

/** @returns {ClientError} */
function crtrMissingError() {
  return {
    kind: 'crtr-missing',
    message:
      "crtr not found — tried CRTR_BIN, PATH 'crtr'/'crouter', and the local cli.js. " +
      'Install crtr or set CRTR_BIN.',
  };
}

/**
 * Pull a human message out of crtr stderr: prefer the last `ERROR:` line, else
 * the last non-empty line, else a generic fallback.
 * @param {string} stderr
 * @returns {string}
 */
function extractMessage(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i])) return lines[i].replace(/^ERROR:\s*/i, '').trim();
  }
  if (lines.length) return lines[lines.length - 1];
  return 'crtr command failed';
}

/**
 * Map a failed crtr invocation to a typed {@link ClientError}.
 * @param {string} stderr
 * @returns {ClientError}
 */
function classifyError(stderr) {
  const s = String(stderr || '');
  if (/help-gate:\s*blocked/i.test(s)) {
    return { kind: 'error', message: 'crtr help-gate blocked the call (run the command with -h once).' };
  }
  return { kind: 'crtr-failed', message: extractMessage(s) };
}

/**
 * Run a crtr `--json` leaf and parse stdout as JSON.
 * @param {string[]} argv
 * @returns {Promise<Result<any>>}
 */
async function runJson(argv) {
  const r = await runCrtr(argv);
  if (!r.spawned) return fail(crtrMissingError());
  if (r.exitCode !== 0) return fail(classifyError(r.stderr || r.stdout));
  const out = String(r.stdout || '').trim();
  if (out === '') return ok(null);
  try {
    return ok(JSON.parse(out));
  } catch {
    return fail({ kind: 'parse', message: `could not parse \`crtr ${argv.join(' ')}\` output as JSON` });
  }
}

// ── Field mappers ────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {string} */
function str(v) {
  return v == null ? '' : String(v);
}

/** @param {any} n @returns {CanvasNode} */
function toNode(n) {
  const o = n || {};
  return {
    nodeId: str(o.node_id),
    name: str(o.name) || '(unnamed)',
    kind: str(o.kind) || '?',
    mode: str(o.mode) || '?',
    lifecycle: str(o.lifecycle) || '?',
    status: str(o.status) || '?',
    parent: o.parent ? str(o.parent) : null,
    created: str(o.created),
  };
}

/** @param {any} i @returns {AttentionItem} */
function toAttention(i) {
  const o = i || {};
  return {
    nodeId: str(o.node_id),
    name: str(o.name),
    cwd: str(o.cwd),
    count: typeof o.count === 'number' ? o.count : 0,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Every node on the canvas (all statuses). The view rebuilds the forest from the
 * `parent` edges and filters to active trees itself.
 * @returns {Promise<Result<CanvasNode[]>>}
 */
export async function fetchNodes() {
  const r = await runJson(['node', 'inspect', 'list', '--json']);
  if (!r.ok) return r;
  const arr = r.data && Array.isArray(r.data.nodes) ? r.data.nodes : [];
  return ok(arr.map(toNode));
}

/**
 * Pending human asks across the canvas (the "blocked on a human" signal).
 * @returns {Promise<Result<{items:AttentionItem[], total:number}>>}
 */
export async function fetchAttention() {
  const r = await runJson(['canvas', 'attention', 'list', '--json']);
  if (!r.ok) return r;
  const items = r.data && Array.isArray(r.data.items) ? r.data.items : [];
  const total = r.data && typeof r.data.total === 'number' ? r.data.total : 0;
  return ok({ items: items.map(toAttention), total });
}

/**
 * Introspection helper (not used at runtime): the exact crtr commands this
 * client shells, so the shape can be eyeballed without a live canvas.
 * @returns {Record<string,string>}
 */
export function describeCommands() {
  return {
    fetchNodes: 'crtr node inspect list --json',
    fetchAttention: 'crtr canvas attention list --json',
  };
}
