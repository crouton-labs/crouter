// attention.ts — pending human-ask counters across the canvas.
//
// Human asks are stored per-cwd, not per-node (interactionsRoot is keyed by
// the cwd the agent ran in, same pattern as humanloop's human list command).
// A cwd can be shared by multiple nodes, so we de-dup on cwd before summing to
// avoid counting the same pending ask N times.
//
// All public functions are best-effort: scanInbox failures return 0 / empty.
// Callers are display code (dashboard, attention queue) that must not blow up
// on a cold canvas or missing humanloop state.

import { scanInbox } from '@crouton-kit/humanloop';
import { interactionsRoot } from '../artifact.js';
import { getNode, listNodes, view } from './canvas.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface AskEntry {
  node_id: string;
  name: string;
  cwd: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count pending asks for a single cwd root. Never throws.
 *
 * When `nodeId` is given, count only asks raised by THAT node — humanloop
 * stamps `deck.source.nodeId` with the originating CRTR_NODE_ID, so two nodes
 * sharing a cwd no longer pollute each other's count. Asks with no stamp
 * (legacy, or raised outside a canvas node) are not attributable to any node
 * and are excluded from the per-node count. Read via a cast so this doesn't
 * hard-depend on a humanloop type bump.
 */
function countForCwd(cwd: string, nodeId?: string): number {
  try {
    const items = scanInbox([interactionsRoot(cwd)]);
    if (nodeId === undefined) return items.length;
    return items.filter(
      (i) => (i.source as { nodeId?: string } | undefined)?.nodeId === nodeId,
    ).length;
  } catch {
    // humanloop not installed, or interactions dir doesn't exist — both fine.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count pending asks for the cwd of a single node.
 * Returns 0 when the node is unknown or humanloop is unavailable.
 */
export function countAsks(nodeId: string): number {
  const node = getNode(nodeId);
  if (node === null) return 0;
  return countForCwd(node.cwd, nodeId);
}

/**
 * Pending asks for all nodes reachable in the subscription sub-DAG from
 * `rootId` (including root itself). De-duped by cwd: when multiple nodes
 * share a cwd the first one encountered claims the entry.
 *
 * Returns only entries with count > 0.
 */
export function pendingAsksForView(rootId: string): AskEntry[] {
  // view() returns children only (excludes root), so prepend root.
  const ids = [rootId, ...view(rootId)];

  const seen = new Map<string, AskEntry>(); // cwd → entry

  for (const id of ids) {
    const node = getNode(id);
    if (node === null) continue;
    if (seen.has(node.cwd)) continue; // already counted this cwd

    const count = countForCwd(node.cwd);
    if (count === 0) {
      // Still mark the cwd seen so later nodes with the same cwd are skipped.
      seen.set(node.cwd, { node_id: id, name: node.name, cwd: node.cwd, count: 0 });
    } else {
      seen.set(node.cwd, { node_id: id, name: node.name, cwd: node.cwd, count });
    }
  }

  return Array.from(seen.values()).filter((e) => e.count > 0);
}

/**
 * Per-node pending ask counts for an explicit set of node ids — the batched
 * counterpart to `countAsks`, used by the nav chrome to label every visible
 * node in ONE pass. Groups ids by their cwd so each distinct interactions dir
 * is scanned exactly once, then buckets the decks by the `source.nodeId` stamp
 * (same attribution as `countForCwd(cwd, nodeId)`). Asks with no node stamp are
 * not attributable to any node and are excluded. Every requested id appears in
 * the result (0 when it has none). Never throws.
 */
export function asksForNodes(ids: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = 0;

  // Bucket the requested ids by cwd so we scan each inbox once, not per id.
  const idsByCwd = new Map<string, string[]>();
  for (const id of ids) {
    const node = getNode(id);
    if (node === null) continue;
    const arr = idsByCwd.get(node.cwd) ?? [];
    arr.push(id);
    idsByCwd.set(node.cwd, arr);
  }

  for (const [cwd, cwdIds] of idsByCwd) {
    let items;
    try {
      items = scanInbox([interactionsRoot(cwd)]);
    } catch {
      continue; // humanloop missing / no interactions dir — leave these at 0
    }
    const want = new Set(cwdIds);
    for (const i of items) {
      const nid = (i.source as { nodeId?: string } | undefined)?.nodeId;
      if (nid !== undefined && want.has(nid)) counts[nid] = (counts[nid] ?? 0) + 1;
    }
  }

  return counts;
}

/**
 * Pending asks across the entire canvas — every distinct cwd among all known
 * nodes. Returns only entries with count > 0.
 */
export function asksAcrossCanvas(): AskEntry[] {
  const rows = listNodes();
  const seen = new Map<string, AskEntry>(); // cwd → entry

  for (const row of rows) {
    if (seen.has(row.cwd)) continue;

    const count = countForCwd(row.cwd);
    seen.set(row.cwd, { node_id: row.node_id, name: row.name, cwd: row.cwd, count });
  }

  return Array.from(seen.values()).filter((e) => e.count > 0);
}
