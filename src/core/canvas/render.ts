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
import { jobDir } from './paths.js';
import { countAsks } from './attention.js';
import type { NodeStatus } from './types.js';

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<NodeStatus, string> = {
  active: '●',
  idle:   '○',
  done:   '✓',
  dead:   '✗',
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

  return `${indent}${connector}${glyph} ${node.name} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}`;
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
  out.push(`${glyph} ${node.name} [${node.kind}/${node.mode}] ctx ${ctx}${askSuffix}`);

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
  // Fine to use parent===null: roots are created by `node session` / `node new`
  // without a parent; non-roots always have a parent.
  const roots = all.filter((n) => n.parent === null);

  // If for some reason we have no parent===null nodes (unusual: e.g., all nodes
  // were created by hand with a parent), fall back to all nodes.
  const renderRoots = roots.length > 0 ? roots : all;

  const parts: string[] = [];
  for (const r of renderRoots) {
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
      name: node.name,
      status: node.status,
      kind: node.kind,
      mode: node.mode,
      ctx_tokens: tel.tokens_in ?? 0,
      asks: countAsks(id),
    }];
  });
}

/** One row per node across the entire canvas. */
export function dashboardRowsAll(): DashboardRow[] {
  return listNodes().flatMap((row) => {
    const tel = readNodeTelemetry(row.node_id);
    return [{
      node_id: row.node_id,
      name: row.name,
      status: row.status,
      kind: row.kind,
      mode: row.mode,
      ctx_tokens: tel.tokens_in ?? 0,
      asks: countAsks(row.node_id),
    }];
  });
}
