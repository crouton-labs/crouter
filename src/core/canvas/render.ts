// render.ts — ASCII tree rendering of the canvas subscription sub-DAG.
//
// `subscriptionsOf(nodeId)` returns the nodes a node subscribes to, which in
// the crtr model are its *reports* / *children*: a parent auto-subscribes to
// each child it spawns so it wakes on the child's output. Walking subscriptionsOf
// recursively therefore walks DOWN the org chart.
//
// Telemetry is read directly from <crtrHome>/nodes/<id>/job/telemetry.json
// (the node-local job dir written by canvas-stophook on every turn_end).
// Missing or corrupt telemetry → ctx 0k (best-effort, never throws).
//
// Cycle guard: the subscription graph is declared acyclic (a node cannot
// subscribe to its own ancestor), but we track visited ids defensively because
// the db is mutable and bugs happen.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, listNodes, subscriptionsOf, view } from './canvas.js';
import { fullName } from './labels.js';
import { jobDir, contextDir } from './paths.js';
import { countAsks, asksForNodes } from './attention.js';
import { isPidAlive } from './pid.js';
import { listFocuses } from './focuses.js';
import { resolveNodeVisual, hangingLabel, hangingCountdown } from './status-glyph.js';
import { readErrorStall, type ErrorStall } from '../runtime/error-stall.js';
import type { NodeStatus, Lifecycle, NodeMeta } from './types.js';

// ---------------------------------------------------------------------------
// Hanging overlay (parked on an exhausted-retry engine error). Read the marker
// pid-gated for LIVE nodes only — mirrors isStreaming: a stale marker from a
// crashed broker fails the isPidAlive AND and reads as not-hanging.
// ---------------------------------------------------------------------------
function hangingFor(node: NodeMeta): ErrorStall | null {
  if (node.status !== 'active' && node.status !== 'idle') return null;
  if (!isPidAlive(node.pi_pid)) return null;
  return readErrorStall(node.node_id);
}

// ---------------------------------------------------------------------------
// Telemetry (best-effort)
// ---------------------------------------------------------------------------

interface NodeTelemetry {
  tokens_in?: number;
}

function readNodeTelemetry(nodeId: string): NodeTelemetry {
  const path = join(jobDir(nodeId), 'telemetry.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as NodeTelemetry;
  } catch {
    return {};
  }
}

/** Format a token count as `Nk` (rounded down to nearest 1 k). */
function fmtCtx(tokensIn: number | undefined): string {
  if (tokensIn === undefined || tokensIn === 0) return '0k';
  return `${Math.floor(tokensIn / 1000)}k`;
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

/** Build one line of the ASCII tree. */
function nodeLine(nodeId: string, indent: string, connector: string): string {
  const node = getNode(nodeId);
  if (node === null) {
    // Node id is in the db but meta.json is gone — paranoid guard.
    return `${indent}${connector}? <missing meta: ${nodeId}>`;
  }

  const hanging = hangingFor(node);
  const glyph = resolveNodeVisual(node.status, { hanging }).glyph;
  const tel = readNodeTelemetry(nodeId);
  const ctx = fmtCtx(tel.tokens_in);
  const asks = countAsks(nodeId);
  const askSuffix = asks > 0 ? ` ⚑${asks}` : '';
  const hangSuffix = hanging !== null ? ` · ${hangingLabel(hanging.kind)} · ${hangingCountdown(hanging.since)}` : '';

  return `${indent}${connector}${glyph} ${fullName(node)} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}${hangSuffix}`;
}

/**
 * Recursively walk the subscription sub-DAG rooted at `nodeId`, appending
 * rendered lines to `out`. Cycle-safe via `visited`.
 */
function walkTree(
  nodeId: string,
  indent: string,
  isLast: boolean,
  visited: Set<string>,
  out: string[],
): void {
  // Guard: if we have already rendered this node in this traversal, emit a
  // back-ref marker instead of recursing (prevents infinite loops in graphs
  // with cycles introduced by manual edge manipulation).
  if (visited.has(nodeId)) {
    // The line for this node was already emitted by the caller; just return.
    return;
  }
  visited.add(nodeId);

  const connector = isLast ? '└─ ' : '├─ ';
  out.push(nodeLine(nodeId, indent, connector));

  const children = subscriptionsOf(nodeId);
  const childIndent = indent + (isLast ? '   ' : '│  ');

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const childIsLast = i === children.length - 1;

    if (visited.has(child.node_id)) {
      // Cycle reference — show the back-edge without recursing.
      const cycleConnector = childIsLast ? '└─ ' : '├─ ';
      out.push(`${childIndent}${cycleConnector}↺ <cycle: ${child.node_id}>`);
      continue;
    }

    walkTree(child.node_id, childIndent, childIsLast, visited, out);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the subscription sub-DAG rooted at `rootId` as an ASCII tree.
 * The root is the first line (no connector prefix); children are indented.
 *
 * Each line: `<glyph> <name> [<kind>/<mode>] ctx <Nk>[ ⚑<asks>]`
 *
 * Returns a multi-line string (no trailing newline).
 */
export function renderTree(rootId: string): string {
  const node = getNode(rootId);
  if (node === null) return `? <missing node: ${rootId}>`;

  const tel = readNodeTelemetry(rootId);
  const ctx = fmtCtx(tel.tokens_in);
  const asks = countAsks(rootId);
  const askSuffix = asks > 0 ? ` ⚑${asks}` : '';
  const hanging = hangingFor(node);
  const glyph = resolveNodeVisual(node.status, { hanging }).glyph;
  const hangSuffix = hanging !== null ? ` · ${hangingLabel(hanging.kind)} · ${hangingCountdown(hanging.since)}` : '';

  const out: string[] = [];
  out.push(`${glyph} ${fullName(node)} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}${hangSuffix}`);

  // visited starts with root already rendered (walkTree doesn't re-emit root).
  const visited = new Set<string>([rootId]);
  const children = subscriptionsOf(rootId);
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === children.length - 1;
    walkTree(child.node_id, '', isLast, visited, out);
  }

  return out.join('\n');
}

/**
 * Render all canvas roots as a forest. A root is a node with no subscribers
 * (no one subscribes to it = it has no managers in the org chart).
 *
 * If there are no roots on the canvas, returns a placeholder string.
 */
export function renderForest(): string {
  const all = listNodes();
  if (all.length === 0) return '(canvas is empty)';

  // A root has no subscribers (nobody is watching it). We discover this by
  // looking for nodes whose node_id never appears as a "to" side of a
  // subscribes_to edge — equivalently, nodes with parent === null are the
  // authoritative roots per the spawn contract (spawn sets parent and records
  // a spawned_by edge + subscribe). Fall back to parent===null because querying
  // the full edge table would require opening the db here.
  //
  // Fine to use parent===null: roots are created by bare `crtr` / `node new --root`
  // without a parent; non-roots always have a parent.
  //
  // Filter to LIVE roots: each `/new` parks a `done` root (option C relaunch)
  // with parent===null, so an unfiltered forest would render every parked root
  // as a sibling tree and clutter the dashboard. Showing only active|idle roots
  // drops parked (`done`) roots and, as a bonus, stray `dead`/`canceled` roots.
  // Parked roots stay reachable by id (inspect / revive / focus).
  const roots = all.filter(
    (n) => n.parent === null && (n.status === 'active' || n.status === 'idle'),
  );

  // No LIVE roots: render an empty/placeholder forest rather than resurrecting
  // parked (`done`) / dead / canceled roots. The live-only filter is the intent;
  // falling back to all-status roots would re-clutter the dashboard with the very
  // parked trees the filter drops (e.g. a sole root `/quit`'d with no `/new`).
  // Parked roots stay reachable by id (inspect / revive / focus).
  if (roots.length === 0) return '(no live roots)';

  const parts: string[] = [];
  for (const r of roots) {
    parts.push(renderTree(r.node_id));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Structured row builder (for dashboard leaf output)
// ---------------------------------------------------------------------------

export interface DashboardRow {
  node_id: string;
  name: string;
  status: NodeStatus;
  kind: string;
  mode: string;
  ctx_tokens: number;
  asks: number;
  /** The dir the node is pinned to (its cwd). Drives the browser's cwd-scope
   *  filter + the All-dirs basename cue. */
  cwd: string;
  /** ISO 8601 birth timestamp — drives the recency sort + the relative-age cue. */
  created: string;
  /** terminal = one-shot worker (finalizes on push --final); resident = persistent
   *  agent you come back to. Drives the browser's resident-only lifecycle filter.
   *  Only populated by dashboardRowsAll (the browser snapshot). */
  lifecycle?: Lifecycle;
  /** "Most recent activity" sort key — epoch ms. The cheap boot stats the node's
   *  job/telemetry.json (rewritten on every turn_end at a DETERMINISTIC path, so
   *  no meta read), falling back to `created`'s epoch when a node never ran a turn.
   *  This is the cheap proxy for last-message recency the attention sort tie-breaks
   *  on. Always set by dashboardRowsAll; optional only so synthetic test rows + the
   *  scoped dashboardRows can omit it. (NB: the pi session-file mtime would be truer
   *  but its path lives in meta.json at a non-deterministic location — reading it
   *  per node would defeat the cheap boot, so telemetry mtime is used instead.) */
  mtimeMs?: number;
  /** The node's spawn prompt (context/initial-prompt.md), trimmed + capped. Populated
   *  LAZILY by loadPreview (selected-row preview) — NOT on the cheap boot path.
   *  Indexed by super-search and shown in the preview panel when there is no query. */
  goal?: string;
  /** EVERY user prompt across the node's pi session — the whole conversation, not just
   *  the spawn prompt — joined + capped. Populated LAZILY by loadPreview (ONE session
   *  read, folded with lastAssistant); undefined for never-revived nodes (no session
   *  file). Powers whole-conversation super-search + the windowed preview snippet. */
  prompts?: string;
  /** The node's LAST assistant message (text only), trimmed + capped. Populated LAZILY
   *  by loadPreview (same single session read as `prompts`); undefined for a node whose
   *  session has no assistant reply yet. Shown in the preview's reply block. */
  lastAssistant?: string;
  /** True when the node is GENUINELY mid-turn right now — its `busy` marker exists
   *  AND its broker pid is alive (not merely an `active`, between-turns node). The
   *  live "is it generating?" cue. Computed on the cheap boot path for LIVE nodes
   *  only (dormant rows are always false). */
  streaming?: boolean;
  /** Set when the node is PARKED on an exhausted-retry engine error (rate-limit /
   *  overloaded / connection / other) — its `error-stall` marker exists AND its
   *  broker pid is alive. The otherwise-invisible "stuck, awaiting the daemon's
   *  auto-revive" window. Mutually exclusive with `streaming` (hanging means the
   *  turn ended, so `busy` is gone); when set, dashboardRowsAll forces
   *  `streaming:false`. Computed on the cheap boot path for LIVE nodes only. */
  hanging?: ErrorStall | null;
  /** True when a viewer (focus row) is attached to the node — i.e. someone has it
   *  open on screen. Set on the cheap boot path from the one listFocuses() query. */
  viewed?: boolean;
  /** Lazy-enrichment guard (internal): true once enrichRow/enrichRows has folded in
   *  the full label (meta), ctx tokens (telemetry), and ⚑ asks. Idempotency marker so
   *  progressive paint can re-call enrich for a viewport every keystroke for free. */
  enriched?: boolean;
  /** Lazy-enrichment guard (internal): true once loadPreview has read goal + the
   *  session (prompts + lastAssistant). Idempotency marker for the selected row. */
  previewLoaded?: boolean;
}

/** The spawn prompt, read straight off disk (canvas-home state) and capped so a
 *  giant initial-prompt.md can't bloat the snapshot. Mirrors how telemetry is
 *  read here directly rather than via the runtime layer (which would invert the
 *  canvas→runtime dependency). Never throws. */
const GOAL_CAP = 4096;
function readGoalText(nodeId: string): string | undefined {
  try {
    const p = join(contextDir(nodeId), 'initial-prompt.md');
    if (!existsSync(p)) return undefined;
    const body = readFileSync(p, 'utf8').trim();
    if (body === '') return undefined;
    return body.length > GOAL_CAP ? body.slice(0, GOAL_CAP) : body;
  } catch {
    return undefined;
  }
}

/** The node's session-derived preview text in ONE file read (today's two reads,
 *  folded): EVERY user prompt across the pi session (`prompts` — the whole
 *  conversation, not just the spawn prompt) AND the LAST assistant message text
 *  (`lastAssistant`). The single jsonl read is split once; a forward pass collects
 *  user prompts (prefiltering to user-role lines so the big assistant/toolResult
 *  lines are never JSON-parsed) and a backward pass finds the newest assistant
 *  reply with text content (tool-only replies skipped). Both are capped per-message
 *  + total so a long session can't bloat the snapshot. Never throws; returns an
 *  empty object when there is no session file yet (a node that was never revived). */
const CONVO_CAP = 8192;
const CONVO_MSG_CAP = 2048;
interface SessionParts {
  prompts?: string;
  lastAssistant?: string;
}
function readSessionParts(sessionFile: string | null | undefined): SessionParts {
  if (sessionFile === undefined || sessionFile === null || sessionFile === '') return {};
  let lines: string[];
  try {
    if (!existsSync(sessionFile)) return {};
    lines = readFileSync(sessionFile, 'utf8').split('\n');
  } catch {
    return {};
  }

  // Forward pass: every user prompt, joined + capped.
  const parts: string[] = [];
  let total = 0;
  for (const line of lines) {
    // Cheap prefilter: skip every line that isn't a user-role message before the
    // (relatively costly) JSON.parse. Pi writes compact JSON (no spaces), but
    // tolerate the spaced form too.
    if (line === '' || (line.indexOf('"role":"user"') === -1 && line.indexOf('"role": "user"') === -1)) continue;
    let rec: { type?: string; message?: { role?: string; content?: unknown } };
    try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
    if (rec.type !== 'message' || rec.message?.role !== 'user') continue;
    const text = extractUserText(rec.message.content);
    if (text === '') continue;
    const capped = text.length > CONVO_MSG_CAP ? text.slice(0, CONVO_MSG_CAP) : text;
    parts.push(capped);
    total += capped.length + 1;
    if (total >= CONVO_CAP) break;
  }
  let prompts: string | undefined;
  if (parts.length > 0) {
    const joined = parts.join('\n');
    prompts = joined.length > CONVO_CAP ? joined.slice(0, CONVO_CAP) : joined;
  }

  // Backward pass: the newest assistant message carrying text.
  let lastAssistant: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line === '' || (line.indexOf('"role":"assistant"') === -1 && line.indexOf('"role": "assistant"') === -1)) continue;
    let rec: { type?: string; message?: { role?: string; content?: unknown } };
    try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
    if (rec.type !== 'message' || rec.message?.role !== 'assistant') continue;
    const text = extractUserText(rec.message.content);
    if (text === '') continue;
    lastAssistant = text.length > CONVO_MSG_CAP ? text.slice(0, CONVO_MSG_CAP) : text;
    break;
  }

  return { prompts, lastAssistant };
}

/** Did this node's engine ever PRODUCE something — an assistant message with real
 *  text, a tool call, or non-empty reasoning? The signal that a node did work and
 *  is not an empty shell. A never-revived node (no session file) is trivially
 *  false; an assistant turn that is only an empty/aborted `thinking` stub does NOT
 *  count (that's a node started and killed before it did anything). CONSERVATIVE
 *  by design: ANY substance keeps the node, so the reap never deletes real work
 *  — a tool-call-only turn (no final text) still counts. Drives reap-on-close/
 *  detach. One file read with an early exit on the first substantive turn. */
export function nodeHasAssistantMessage(sessionFile: string | null | undefined): boolean {
  if (sessionFile === undefined || sessionFile === null || sessionFile === '') return false;
  let lines: string[];
  try {
    if (!existsSync(sessionFile)) return false;
    lines = readFileSync(sessionFile, 'utf8').split('\n');
  } catch {
    return false;
  }
  for (const line of lines) {
    if (line === '' || (line.indexOf('"role":"assistant"') === -1 && line.indexOf('"role": "assistant"') === -1)) continue;
    let rec: { type?: string; message?: { role?: string; content?: unknown } };
    try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
    if (rec.type !== 'message' || rec.message?.role !== 'assistant') continue;
    if (assistantContentIsSubstantive(rec.message.content)) return true;
  }
  return false;
}

/** True when an assistant message's content has at least one block that PRODUCED
 *  something: non-empty text, non-empty thinking, a tool call (`toolCall`/
 *  `tool_use`/…), or any other non-thinking/text block type. The lone non-case is
 *  an empty thinking stub (`[{type:'thinking',thinking:''}]`) or empty content —
 *  what an immediately-aborted first turn leaves behind. */
function assistantContentIsSubstantive(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown; thinking?: unknown };
    const t = (b.type ?? '').toLowerCase();
    if (t === 'text') { if (typeof b.text === 'string' && b.text.trim() !== '') return true; }
    else if (t === 'thinking') { if (typeof b.thinking === 'string' && b.thinking.trim() !== '') return true; }
    else return true; // toolCall / tool_use / toolResult / any other block = real output
  }
  return false;
}

/** {@link isStreaming} keyed by node id alone — hydrates the broker pid off the
 *  db row. The exported "is this node actively generating right now?" guard so a
 *  reap never nukes a node mid-first-turn before its output lands on disk. */
export function isNodeStreaming(nodeId: string): boolean {
  return isStreaming(nodeId, getNode(nodeId)?.pi_pid ?? null);
}

/** Is the node GENUINELY mid-turn right now? The `busy` marker (touched on
 *  agent_start, removed on agent_end) AND-ed with broker-pid liveness, so a stale
 *  marker from a crashed pi reads false. This is the live "generating?" signal
 *  — distinct from `status: 'active'`, which only means the engine never closed
 *  (an active node is usually dormant between turns). Read directly off disk
 *  (mirrors telemetry) to avoid inverting the canvas→runtime dependency. */
function isStreaming(nodeId: string, piPid: number | null | undefined): boolean {
  if (!isPidAlive(piPid)) return false;
  try {
    return existsSync(join(jobDir(nodeId), 'busy'));
  } catch {
    return false;
  }
}

/** Concatenate the `text` blocks of one pi user message's content. Content is
 *  usually an array of `{type,text}` blocks but may be a bare string. */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    }
  }
  return out.join(' ').trim();
}

/** One row per node visible in the sub-DAG of `rootId` (including root). */
export function dashboardRows(rootId: string): DashboardRow[] {
  const ids = [rootId, ...view(rootId)];
  return ids.flatMap((id) => {
    const node = getNode(id);
    if (node === null) return [];
    const tel = readNodeTelemetry(id);
    return [{
      node_id: id,
      name: fullName(node),
      status: node.status,
      kind: node.kind,
      mode: node.mode,
      ctx_tokens: tel.tokens_in ?? 0,
      asks: countAsks(id),
      cwd: node.cwd,
      created: node.created,
    }];
  });
}

/** "Most recent activity" sort key (epoch ms) read CHEAPLY: a `statSync` (no file
 *  read, no parse) of the node's job/telemetry.json — rewritten on every turn_end at
 *  a deterministic canvas-home path, so it tracks last-message recency without a meta
 *  read. Falls back to `created`'s epoch when a node never ran a turn (no telemetry).
 *  Never throws. */
function sessionMtime(nodeId: string, created: string): number {
  try {
    const st = statSync(join(jobDir(nodeId), 'telemetry.json'), { throwIfNoEntry: false });
    if (st !== undefined) return st.mtimeMs;
  } catch {
    /* fall through to created */
  }
  const t = Date.parse(created);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * CHEAP boot builder — one row per node across the entire canvas, with only the
 * fields that need no per-node meta/telemetry/session read. Two db queries total:
 * `listNodes()` + `listFocuses()` (the focus set replaces 1473 `getFocusByNode`
 * calls). For each node:
 *   - identity/status/kind/mode/cwd/created/lifecycle straight off the db row;
 *   - `name` is the db HANDLE only (the informative label needs meta.description —
 *     fold it in lazily via {@link enrichRow}/{@link enrichRows});
 *   - `viewed` from the one focus-set;
 *   - `streaming` only for LIVE nodes (active|idle — the only ones that can be
 *     mid-turn); dormant rows are always false (skips an isPidAlive + statSync);
 *   - `mtimeMs` via a cheap telemetry statSync (no read) for the attention sort;
 *   - `ctx_tokens`/`asks` left 0 and `goal`/`prompts`/`lastAssistant` undefined —
 *     all deferred to the lazy enrichment API below.
 *
 * This is the first-frame path: paint from it immediately, then enrich the visible
 * viewport on demand. See {@link enrichRow}, {@link enrichRows}, {@link loadPreview}.
 */
export function dashboardRowsAll(): DashboardRow[] {
  const focusedNodeIds = new Set(listFocuses().map((f) => f.node_id));
  return listNodes().map((row) => {
    const live = row.status === 'active' || row.status === 'idle';
    // Hanging takes precedence over streaming (mutually exclusive in practice).
    // Both are LIVE-only and pid-gated off the row's pi_pid — no meta read, so
    // the cheap-boot contract holds (readErrorStall is one small file read, only
    // for live nodes, comparable to isStreaming's existsSync).
    const hanging = live && isPidAlive(row.pi_pid) ? readErrorStall(row.node_id) : null;
    return {
      node_id: row.node_id,
      name: row.name, // handle only; enrichRow upgrades to fullName (meta.description)
      status: row.status,
      kind: row.kind,
      mode: row.mode,
      ctx_tokens: 0, // lazy: enrichRow
      asks: 0,       // lazy: enrichRow / enrichRows
      cwd: row.cwd,
      created: row.created,
      lifecycle: row.lifecycle,
      mtimeMs: sessionMtime(row.node_id, row.created),
      streaming: hanging === null && live ? isStreaming(row.node_id, row.pi_pid) : false,
      hanging,
      viewed: focusedNodeIds.has(row.node_id),
    };
  });
}

// ---------------------------------------------------------------------------
// Lazy enrichment API — fold the expensive per-node reads into rows on demand,
// for the VISIBLE viewport / top tiers only (never all 1473 up front). Each
// function mutates the row in place (the browse tree holds the row reference, so
// a later flush re-renders the upgraded data) and is idempotent via a guard flag
// so progressive paint can call it for the viewport every keystroke for free.
// ---------------------------------------------------------------------------

/** Fold the cheap-boot row's deferred fields in for ONE row: the full label
 *  (meta.description → fullName), ctx tokens (telemetry.json), and ⚑ asks. One
 *  meta read + one telemetry read + one ask scan. Idempotent (no-op once enriched).
 *  For a batch, prefer {@link enrichRows} — it scans each cwd's ask inbox once. */
export function enrichRow(row: DashboardRow): DashboardRow {
  if (row.enriched === true) return row;
  const meta = getNode(row.node_id);
  if (meta !== null) row.name = fullName(meta);
  row.ctx_tokens = readNodeTelemetry(row.node_id).tokens_in ?? 0;
  row.asks = countAsks(row.node_id);
  row.enriched = true;
  return row;
}

/** Batch {@link enrichRow}: enrich every not-yet-enriched row, scanning each
 *  distinct cwd's ask inbox exactly ONCE (via `asksForNodes`) instead of per row.
 *  Use this for a whole viewport / the full forest; mutates each row in place. */
export function enrichRows(rows: DashboardRow[]): void {
  const todo = rows.filter((r) => r.enriched !== true);
  if (todo.length === 0) return;
  const asks = asksForNodes(todo.map((r) => r.node_id));
  for (const row of todo) {
    const meta = getNode(row.node_id);
    if (meta !== null) row.name = fullName(meta);
    row.ctx_tokens = readNodeTelemetry(row.node_id).tokens_in ?? 0;
    row.asks = asks[row.node_id] ?? 0;
    row.enriched = true;
  }
}

/** Load the SELECTED row's preview text: the spawn `goal` (initial-prompt.md) plus
 *  the whole-conversation `prompts` and the `lastAssistant` reply — the latter two
 *  folded into ONE session-file read (see {@link readSessionParts}). Mutates the row
 *  in place; idempotent. Call only for the cursor row (and lazily/in-background to
 *  warm the prompt super-search corpus), never on the boot path. */
export function loadPreview(row: DashboardRow): DashboardRow {
  if (row.previewLoaded === true) return row;
  row.goal = readGoalText(row.node_id);
  const meta = getNode(row.node_id);
  const { prompts, lastAssistant } = readSessionParts(meta?.pi_session_file);
  row.prompts = prompts;
  row.lastAssistant = lastAssistant;
  row.previewLoaded = true;
  return row;
}
