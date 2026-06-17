/**
 * Pure tree logic for the graph rail (design §2a). Derives the current node's
 * graph (root + full subtree in DFS preorder with depth) and the roots of other
 * active graphs for the "ELSEWHERE" section.
 */

import type { NodeSummary } from '@/shared/protocol.js';

export interface GraphNode {
  node: NodeSummary;
  depth: number;
}

/** Map of parent id → child rows. */
function childIndex(nodes: NodeSummary[]): Map<string, NodeSummary[]> {
  const byParent = new Map<string, NodeSummary[]>();
  for (const n of nodes) {
    if (n.parent === null) continue;
    const list = byParent.get(n.parent);
    if (list) list.push(n);
    else byParent.set(n.parent, [n]);
  }
  return byParent;
}

/** Walk from a given root in DFS preorder, producing GraphNode[] with depth. */
function dfsPreorder(
  root: NodeSummary,
  byParent: Map<string, NodeSummary[]>,
): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  const stack: Array<{ node: NodeSummary; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (seen.has(item.node.node_id)) continue;
    seen.add(item.node.node_id);
    out.push({ node: item.node, depth: item.depth });
    // Push children in reverse order so first child is processed first.
    const kids = byParent.get(item.node.node_id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i]!, depth: item.depth + 1 });
    }
  }
  return out;
}

/** Find the spine root of a given node (walk parent pointers). */
function findRoot(nodeId: string, byId: Map<string, NodeSummary>): NodeSummary | null {
  let cur = byId.get(nodeId);
  const seen = new Set<string>();
  while (cur && cur.parent !== null) {
    if (seen.has(cur.node_id)) return null; // cycle guard
    seen.add(cur.node_id);
    cur = byId.get(cur.parent);
  }
  return cur ?? null;
}

/**
 * Given all canvas nodes and the current node id, return:
 * - `thisGraph`: the current node's root + full subtree, DFS preorder with depth
 * - `otherGraphs`: roots of OTHER broker-hosted root graphs that are active OR
 *   have attention_count > 0
 */
export function buildGraphTree(
  nodes: NodeSummary[],
  currentId: string,
): { thisGraph: GraphNode[]; otherGraphs: NodeSummary[] } {
  const byId = new Map<string, NodeSummary>(nodes.map((n) => [n.node_id, n]));
  const byParent = childIndex(nodes);

  const currentRoot = findRoot(currentId, byId);
  const currentRootId = currentRoot?.node_id ?? null;

  const thisGraph: GraphNode[] =
    currentRoot !== null ? dfsPreorder(currentRoot, byParent) : [];

  const otherGraphs: NodeSummary[] = nodes.filter(
    (n) =>
      n.parent === null &&
      n.host_kind === 'broker' &&
      n.node_id !== currentRootId &&
      (n.status === 'active' || n.attention_count > 0),
  );

  return { thisGraph, otherGraphs };
}
