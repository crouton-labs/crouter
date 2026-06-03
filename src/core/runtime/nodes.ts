// Runtime node operations — the behavior layer above the canvas store.
//
// canvas/ is the pure data-access layer (nodes + edges). This is where the
// design's *rules* live: how a node comes into being, the env contract its pi
// process inherits, and the spawn-time wiring of the subscription spine.
//
// Two ways a node is born:
//   • root  — a user-opened entry point (bare `crtr` / `crtr session new`).
//             No parent; resident by default (it's a conversation you live in).
//   • child — spawned by another node. Terminal until it must persist. On
//             spawn the PARENT auto-subscribes (active) to the child, so it
//             learns when the work finishes — this seeds the subscription
//             graph to mirror the spawn structure. A `spawned_by` audit edge
//             is also recorded.

import { randomBytes } from 'node:crypto';
import {
  createNode,
  getNode,
  subscribe,
  recordSpawn,
  type NodeMeta,
  type Mode,
  type Lifecycle,
  type LaunchSpec,
} from '../canvas/index.js';

/** Generate a node id in the same shape as job ids (time-sortable + random). */
export function newNodeId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// The env contract — what a node's pi process inherits and its children read.
// ---------------------------------------------------------------------------

export interface NodeContext {
  nodeId: string | null;
  parentNodeId: string | null;
  kind: string | null;
  mode: Mode | null;
}

/** Read the current node's identity from the environment. A spawned pi process
 *  runs with CRTR_NODE_ID set; its own `crtr` invocations spawn children under
 *  it by reading CRTR_NODE_ID as the parent. */
export function currentNodeContext(): NodeContext {
  const env = process.env;
  return {
    nodeId: env['CRTR_NODE_ID'] ?? null,
    parentNodeId: env['CRTR_NODE_ID'] ?? null, // a child's parent is the live node
    kind: env['CRTR_KIND'] ?? null,
    mode: (env['CRTR_MODE'] as Mode | undefined) ?? null,
  };
}

/** The env injected into a node's pi process. Self-gating extensions read
 *  CRTR_KIND/CRTR_MODE to flip behavior on polymorph without a respawn; the
 *  feed/inbox machinery reads CRTR_NODE_ID. */
export function nodeEnv(meta: NodeMeta): Record<string, string> {
  const env: Record<string, string> = {
    CRTR_NODE_ID: meta.node_id,
    CRTR_KIND: meta.kind,
    CRTR_MODE: meta.mode,
    CRTR_LIFECYCLE: meta.lifecycle,
    CRTR_NODE_CWD: meta.cwd,
  };
  if (meta.parent) env['CRTR_PARENT_NODE_ID'] = meta.parent;
  // Propagate an explicit canvas home so children share the same canvas.
  const home = process.env['CRTR_HOME'];
  if (home !== undefined && home !== '') env['CRTR_HOME'] = home;
  // Propagate the root's tmux session so every descendant spawns its windows
  // into the same root session.
  const rootSession = process.env['CRTR_ROOT_SESSION'];
  if (rootSession !== undefined && rootSession !== '') env['CRTR_ROOT_SESSION'] = rootSession;
  // Merge any launch-spec env last (it may override / extend).
  return { ...env, ...(meta.launch?.env ?? {}) };
}

// ---------------------------------------------------------------------------
// Birth
// ---------------------------------------------------------------------------

export interface SpawnNodeOpts {
  kind: string;
  mode?: Mode;
  lifecycle?: Lifecycle;
  cwd: string;
  name?: string;
  /** Parent node id. Omit for a user-opened root. */
  parent?: string | null;
  /** New subscriptions this node opens default to passive when true. */
  passiveDefault?: boolean;
  /** Resolved pi launch recipe (from resolve(kind,mode)). */
  launch?: LaunchSpec;
  /** Override the generated id (e.g. when a caller pre-allocates one). */
  nodeId?: string;
}

/** Create a node on the canvas and wire its spawn-time edges.
 *
 *  For a child (parent given): the parent auto-subscribes ACTIVE to the child
 *  (so it's woken when the child finishes), and a spawned_by audit edge is
 *  recorded. For a root (no parent): no edges, resident by default. */
export function spawnNode(opts: SpawnNodeOpts): NodeMeta {
  const parent = opts.parent ?? null;
  const isRoot = parent === null;
  const meta: NodeMeta = {
    node_id: opts.nodeId ?? newNodeId(),
    name: opts.name ?? opts.kind,
    created: new Date().toISOString(),
    cwd: opts.cwd,
    kind: opts.kind,
    mode: opts.mode ?? 'base',
    // A user-opened root is resident (a conversation you live in); a spawned
    // node is terminal until it must persist (promotion handles that later).
    lifecycle: opts.lifecycle ?? (isRoot ? 'resident' : 'terminal'),
    status: 'active',
    parent,
    passive_default: opts.passiveDefault ?? false,
    intent: null,
    pi_session_id: null,
    launch: opts.launch,
  };

  createNode(meta);

  if (parent !== null) {
    if (getNode(parent) === null) {
      throw new Error(`cannot spawn under unknown parent node: ${parent}`);
    }
    // The load-bearing seed: parent subscribes (active) to child so it learns
    // when the work finishes. This mirrors spawn structure into the spine.
    subscribe(parent, meta.node_id, true);
    // Audit-only provenance.
    recordSpawn(meta.node_id, parent);
  }

  return meta;
}
