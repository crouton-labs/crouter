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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, listNodes, subscriptionsOf, view } from './canvas.js';
import { fullName } from './labels.js';
import { jobDir, contextDir } from './paths.js';
import { countAsks } from './attention.js';
import type { NodeStatus } from './types.js';

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<NodeStatus, string> = {
  active:   '●',
  idle:     '○',
  done:     '✓',
  dead:     '✗',
  canceled: '⊘',
};

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

  const glyph = STATUS_GLYPH[node.status] ?? '?';
  const tel = readNodeTelemetry(nodeId);
  const ctx = fmtCtx(tel.tokens_in);
  const asks = countAsks(nodeId);
  const askSuffix = asks > 0 ? ` ⚑${asks}` : '';

  return `${indent}${connector}${glyph} ${fullName(node)} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}`;
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
  const glyph = STATUS_GLYPH[node.status] ?? '?';

  const out: string[] = [];
  out.push(`${glyph} ${fullName(node)} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}`);

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
  /** The node's spawn prompt (context/initial-prompt.md), trimmed + capped. Only
   *  populated by dashboardRowsAll (the browser snapshot) — the dashboard leaf
   *  leaves it undefined to avoid a file read per node. Indexed by super-search
   *  and shown in the preview panel. */
  goal?: string;
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

/** One row per node across the entire canvas. */
export function dashboardRowsAll(): DashboardRow[] {
  return listNodes().flatMap((row) => {
    const tel = readNodeTelemetry(row.node_id);
    // listNodes() returns the db projection (no description); read the meta to
    // get the full label. Falls back to the row name if the meta is gone.
    const meta = getNode(row.node_id);
    return [{
      node_id: row.node_id,
      name: meta !== null ? fullName(meta) : row.name,
      status: row.status,
      kind: row.kind,
      mode: row.mode,
      ctx_tokens: tel.tokens_in ?? 0,
      asks: countAsks(row.node_id),
      cwd: row.cwd,
      created: row.created,
      goal: readGoalText(row.node_id),
    }];
  });
}
