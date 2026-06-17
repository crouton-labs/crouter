/**
 * Conversation derivation (design §4.3). A Studio "conversation" is exactly one
 * broker-hosted root node; the list is the spine-forest roots. Sub-nodes are
 * never shown — their existence only contributes to a conversation's "needs
 * you" indicator (any node in the sub-DAG with a pending ask) and its activity
 * count. This module is the pure mapping from a canvas snapshot to the
 * consumer-facing conversation rows; the page only renders what comes out.
 *
 * Data limits (honest): the canvas snapshot carries no per-conversation
 * last-message text, so the row preview is a plain-language status line (not a
 * message excerpt) and titles fall back from `name` to `kind · cwd-basename`
 * (see deriveNodeTitle). Recency prefers `last_activity` and falls back to
 * `created`. The preview/title upgrade for free if the snapshot grows a
 * first-message field later.
 */

import type { NodeLifeStatus, NodeSummary } from '@/shared/protocol.js';

/** The four consumer-facing conversation states (design §5.1). */
export type ConversationState = 'needs-you' | 'active' | 'idle' | 'done';

export interface Conversation {
  id: string;
  title: string;
  state: ConversationState;
  /** Pending human asks anywhere in this conversation's sub-DAG. */
  attention: number;
  /** Count of working (active) nodes in the sub-DAG — drives the activity hint. */
  activeChildren: number;
  /** Total nodes in this conversation's sub-DAG (root included). */
  nodeCount: number;
  /** Canvas cycle count of the root, when the snapshot carries it. */
  cycles?: number;
  /** ISO-8601; the root's most recent work (`last_activity`, else `created`). */
  lastActivity: string;
}

/** Last path segment of a cwd (the project basename), for fallback titles. */
function cwdBasename(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Derive a human title for a node (design R5). The canvas snapshot carries no
 * first-user-message text, so the auto-titled-chat ideal (truncated prompt) is
 * not yet available; we use the best signal present:
 *   - a meaningful `name` (i.e. one the user/runtime actually set) → use it;
 *   - the "general general" default (`name === kind`) → `kind · <cwd-basename>`,
 *     which at least distinguishes conversations by project instead of
 *     repeating the kind. Upgrades to the real prompt for free once the
 *     snapshot grows a first-message field.
 */
export function deriveNodeTitle(n: NodeSummary): string {
  const name = n.name?.trim();
  if (name && name !== n.kind) return name;
  const base = cwdBasename(n.cwd);
  return base ? `${n.kind} · ${base}` : n.kind;
}

/** A node is a conversation root iff it's a broker-hosted spine root. */
function isConversationRoot(n: NodeSummary): boolean {
  return n.parent === null && n.host_kind === 'broker';
}

/** Map of parent id → child rows, for sub-DAG walks. */
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

/** Every node in `root`'s sub-DAG, including the root (cycle-safe). */
function subDag(root: NodeSummary, byParent: Map<string, NodeSummary[]>): NodeSummary[] {
  const out: NodeSummary[] = [];
  const seen = new Set<string>();
  const stack: NodeSummary[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n.node_id)) continue;
    seen.add(n.node_id);
    out.push(n);
    const kids = byParent.get(n.node_id);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

/** A finished lifecycle status (the conversation reads "Finished"). */
function isDone(status: NodeLifeStatus): boolean {
  return status === 'done' || status === 'dead' || status === 'canceled';
}

/** Resolve a conversation's single state from the root + its sub-DAG. */
function deriveState(
  root: NodeSummary,
  attention: number,
  activeChildren: number,
): ConversationState {
  if (attention > 0) return 'needs-you';
  if (root.status === 'active' || activeChildren > 0) return 'active';
  if (isDone(root.status)) return 'done';
  return 'idle';
}

/** State sort rank — needs-you first, then active, then the rest. */
function stateRank(state: ConversationState): number {
  switch (state) {
    case 'needs-you':
      return 0;
    case 'active':
      return 1;
    case 'idle':
      return 2;
    case 'done':
      return 3;
  }
}

/**
 * Build the sorted conversation list from a canvas snapshot: roots only, each
 * enriched from its sub-DAG, ordered needs-you-first then most-recent.
 */
export function buildConversations(nodes: NodeSummary[]): Conversation[] {
  const byParent = childIndex(nodes);
  const convos: Conversation[] = [];

  for (const root of nodes) {
    if (!isConversationRoot(root)) continue;
    const dag = subDag(root, byParent);
    let attention = 0;
    let activeChildren = 0;
    for (const n of dag) {
      attention += Math.max(0, n.attention_count);
      if (n.node_id !== root.node_id && n.status === 'active') activeChildren += 1;
    }
    convos.push({
      id: root.node_id,
      title: deriveNodeTitle(root),
      state: deriveState(root, attention, activeChildren),
      attention,
      activeChildren,
      nodeCount: dag.length,
      ...(root.cycles !== undefined ? { cycles: root.cycles } : {}),
      lastActivity: root.last_activity ?? root.created,
    });
  }

  convos.sort((a, b) => {
    const byState = stateRank(a.state) - stateRank(b.state);
    if (byState !== 0) return byState;
    // Most-recent first (created proxy; descending ISO compares lexically).
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  return convos;
}

/**
 * Every node beneath `rootId` in the spine forest (excluding the root itself).
 * The Studio ActivityRail summarizes these as plain-language activity instead of
 * showing the raw child graph.
 */
export function descendantsOf(nodes: NodeSummary[], rootId: string): NodeSummary[] {
  const byParent = childIndex(nodes);
  const root = nodes.find((n) => n.node_id === rootId);
  if (!root) return [];
  return subDag(root, byParent).filter((n) => n.node_id !== rootId);
}

/** A plain-language one-line preview for a conversation row (no message text in
 *  the snapshot — see module note). */
export function previewLine(c: Conversation): string {
  switch (c.state) {
    case 'needs-you':
      return c.attention > 1 ? `${c.attention} things need your input` : 'Needs your input';
    case 'active':
      return c.activeChildren > 0
        ? `Working — ${c.activeChildren} ${c.activeChildren === 1 ? 'task' : 'tasks'} in progress`
        : 'Working…';
    case 'done':
      return 'Finished';
    case 'idle':
      return 'Idle';
  }
}
