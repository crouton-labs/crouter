// @ts-check
/**
 * Data layer for the `workspace-sidebar` view — the left rail of `crtr workspace`.
 *
 * Self-contained ESM, Node-builtins-only, imports NOTHING from crtr (ships
 * verbatim, dynamically import()ed where there is no TS toolchain). It shells the
 * `crtr` binary (read-only `--json` leaves) and the `tmux` binary (reading a pane
 * option) — same posture as the `canvas` view's client. NOTHING here throws;
 * every export returns a `Result<T>` so the view renders guidance, not a crash.
 *
 * crtr help-gate note: a `crtr` spawned from inside the view host is a grandchild
 * of `node dist/cli.js view run`, not a pi tool call, so it is never gated.
 *
 * @module workspace-sidebar/client
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One canvas node, flattened from `node inspect list --json`.
 * @typedef {Object} CanvasNode
 * @property {string} nodeId
 * @property {string} name
 * @property {string} kind
 * @property {string} mode
 * @property {string} lifecycle
 * @property {string} status      active | idle | done | dead | canceled.
 * @property {string} cwd         Originating cwd — the workspace scope key.
 * @property {string|null} parent Spawn/subscription parent id (null ⇒ a root).
 * @property {string} created     ISO 8601 birth timestamp (drives ordering).
 */

/**
 * @typedef {{kind:'crtr-missing', message:string}
 *   | {kind:'crtr-failed', message:string}
 *   | {kind:'parse', message:string}
 *   | {kind:'error', message:string}} ClientError
 */

/**
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

// ── Locating the `crtr` binary (same ladder as canvas/client.mjs) ─────────────

/** @typedef {Object} Candidate @property {string} bin @property {string[]} prefix */

/** @returns {Candidate[]} */
function crtrCandidates() {
  /** @type {Candidate[]} */
  const out = [];
  if (process.env.CRTR_BIN) out.push({ bin: process.env.CRTR_BIN, prefix: [] });
  out.push({ bin: 'crtr', prefix: [] });
  out.push({ bin: 'crouter', prefix: [] });
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // …/dist/builtin-views/workspace-sidebar
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
 * @property {boolean} spawned
 * @property {number}  exitCode
 * @property {string}  stdout
 * @property {string}  stderr
 */

/** @param {Candidate} c @param {string[]} argv @returns {Promise<RunResult>} */
function runOnce(c, argv) {
  return new Promise((resolve) => {
    execFile(c.bin, [...c.prefix, ...argv], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const errOut = typeof stderr === 'string' ? stderr : '';
      if (err && /** @type {any} */ (err).code === 'ENOENT') {
        resolve({ spawned: false, exitCode: -1, stdout: out, stderr: errOut });
        return;
      }
      const code = err ? (typeof /** @type {any} */ (err).code === 'number' ? /** @type {any} */ (err).code : 1) : 0;
      resolve({ spawned: true, exitCode: code, stdout: out, stderr: errOut });
    });
  });
}

/** @param {string[]} argv @returns {Promise<RunResult>} */
async function runCrtr(argv) {
  /** @type {RunResult} */
  let last = { spawned: false, exitCode: -1, stdout: '', stderr: '' };
  for (const c of crtrCandidates()) {
    last = await runOnce(c, argv);
    if (last.spawned) return last;
  }
  return last;
}

/** @returns {ClientError} */
function crtrMissingError() {
  return {
    kind: 'crtr-missing',
    message: "crtr not found — tried CRTR_BIN, PATH 'crtr'/'crouter', and the local cli.js. Install crtr or set CRTR_BIN.",
  };
}

/** @param {string} stderr @returns {string} */
function extractMessage(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i])) return lines[i].replace(/^ERROR:\s*/i, '').trim();
  }
  if (lines.length) return lines[lines.length - 1];
  return 'crtr command failed';
}

/** @param {string} stderr @returns {ClientError} */
function classifyError(stderr) {
  const s = String(stderr || '');
  if (/help-gate:\s*blocked/i.test(s)) {
    return { kind: 'error', message: 'crtr help-gate blocked the call (run the command with -h once).' };
  }
  return { kind: 'crtr-failed', message: extractMessage(s) };
}

/** @param {string[]} argv @returns {Promise<Result<any>>} */
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
    cwd: str(o.cwd),
    parent: o.parent ? str(o.parent) : null,
    created: str(o.created),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Every node on the canvas (all statuses). The view filters to the workspace cwd
 * and rebuilds the forest from `parent` edges itself.
 * @returns {Promise<Result<CanvasNode[]>>}
 */
export async function fetchNodes() {
  const r = await runJson(['node', 'inspect', 'list', '--json']);
  if (!r.ok) return r;
  const arr = r.data && Array.isArray(r.data.nodes) ? r.data.nodes : [];
  return ok(arr.map(toNode));
}

/**
 * Per-node pending-ask counts for a visible set, in ONE pass: the current graph's
 * whole sub-DAG (`--view <root>`) unioned with explicit `nodeIds` (the other
 * roots in this cwd). Best-effort — a failure yields an empty map so the rail
 * still renders without ⚑ flags.
 * @param {string|null} viewRoot
 * @param {string[]} nodeIds
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchAttentionMap(viewRoot, nodeIds) {
  const argv = ['canvas', 'attention', 'map', '--json'];
  if (viewRoot) argv.push('--view', viewRoot);
  const extra = (nodeIds || []).filter(Boolean);
  if (extra.length) argv.push('--nodes', extra.join(','));
  if (!viewRoot && extra.length === 0) return {};
  const r = await runJson(argv);
  if (!r.ok) return {};
  const counts = r.data && r.data.counts && typeof r.data.counts === 'object' ? r.data.counts : {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(counts)) out[k] = typeof v === 'number' ? v : 0;
  return out;
}

/**
 * @typedef {Object} ChatPane
 * @property {string} pane  tmux pane id of the chat pane ('' if none found).
 * @property {string} node  node id that pane is attached to (@crtr_node), or ''.
 */

/**
 * Resolve the chat pane the rail drives — the pane in the rail's OWN tmux window
 * that `crtr attach` is hosting. Discovery (not a launch-time id) so it survives
 * the swap-pane `crtr node focus` does: scan the window's panes and prefer the
 * one tagged `@crtr_node` (attach self-tags its pane); else fall back to the
 * `override` (the forwarded --target), else any sibling pane. Never throws;
 * returns {pane:'', node:''} when nothing resolves (no tmux / lone pane).
 * @param {string} override  Optional explicit chat pane id (host.options.target).
 * @returns {Promise<ChatPane>}
 */
export async function resolveChatPane(override) {
  const self = process.env.TMUX_PANE || '';
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['list-panes', '-F', '#{pane_id}\t#{@crtr_node}'],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve({ pane: override && override !== self ? override : '', node: '' });
          return;
        }
        /** @type {{pane:string,node:string}[]} */
        const rows = [];
        for (const line of String(stdout || '').split(/\r?\n/)) {
          if (!line) continue;
          const tab = line.indexOf('\t');
          const pane = tab < 0 ? line : line.slice(0, tab);
          const node = tab < 0 ? '' : line.slice(tab + 1).trim();
          rows.push({ pane: pane.trim(), node });
        }
        // Prefer a sibling pane that attach has tagged with a node.
        const tagged = rows.find((r) => r.pane && r.pane !== self && r.node);
        if (tagged) {
          resolve({ pane: tagged.pane, node: tagged.node });
          return;
        }
        // Else the explicit override, else any sibling, else nothing.
        if (override && override !== self) {
          resolve({ pane: override, node: '' });
          return;
        }
        const sibling = rows.find((r) => r.pane && r.pane !== self);
        resolve({ pane: sibling ? sibling.pane : '', node: '' });
      },
    );
  });
}

/**
 * Focus `nodeId` into the chat pane (`tmux pane id` = `targetPane`) by shelling
 * `crtr node focus <id> --pane <pane>` — the same swap-pane call the Alt+G graph
 * overlay uses. Fire-and-forget: the swap lands in the OTHER pane, so the rail
 * neither waits on nor renders its result. Never throws.
 * @param {string} nodeId
 * @param {string} targetPane
 * @returns {void}
 */
export function focusInto(nodeId, targetPane) {
  if (!nodeId || !targetPane) return;
  try {
    const c = crtrCandidates()[0];
    execFile(c.bin, [...c.prefix, 'node', 'focus', nodeId, '--pane', targetPane], () => {
      /* best-effort — the rail is fire-and-forget */
    });
  } catch {
    /* best-effort */
  }
}
