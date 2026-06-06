// Runtime node operations — the behavior layer above the canvas store.
//
// canvas/ is the pure data-access layer (nodes + edges). This is where the
// design's *rules* live: how a node comes into being, the env contract its pi
// process inherits, and the spawn-time wiring of the subscription spine.
//
// Two ways a node is born:
//   • root  — a user-opened entry point (bare `crtr`).
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

/** The single, shared tmux session that ALL canvas node windows live in.
 *  Overridable with CRTR_NODE_SESSION (default `crtr`). Every root and every
 *  child opens a window here rather than cluttering the user's own working
 *  session — switch to it to browse the whole live graph, ignore it otherwise.
 *  Pure policy (env only, no tmux call), so it lives in the node layer, not the
 *  driver; the tmux driver imports it from here for installMenuBinding's use. */
export function nodeSession(): string {
  const v = process.env['CRTR_NODE_SESSION'];
  return v !== undefined && v !== '' ? v : 'crtr';
}

// ---------------------------------------------------------------------------
// REVIVE-HOME (home_session) — the durable session a node is (re)opened into
// ---------------------------------------------------------------------------

/** Resolve the tmux session a freshly-born node's window/pane opens into — and
 *  thus its durable REVIVE-HOME (`home_session`). Pure so the birth decision is
 *  unit-testable without a live tmux:
 *    - managed background child  (`adoptCaller=false`) → the shared backstage:
 *      the inherited `CRTR_ROOT_SESSION`, else `nodeSession()` (`crtr`).
 *    - independent `--root` / inline front door (`adoptCaller=true`) → the
 *      caller's CURRENT session when inside tmux (`here`), else the backstage.
 *  This is exactly the session each birth site already places the node into;
 *  centralizing it keeps `home_session` and the actual placement in lockstep. */
export function resolveBirthSession(opts: {
  /** True for an independent root or the inline front door (both adopt the
   *  caller's session); false for a managed background child. */
  adoptCaller: boolean;
  /** The caller's current tmux location, or null when not inside tmux. */
  here: { session: string } | null;
  /** The inherited CRTR_ROOT_SESSION (the backstage the subtree flows into). */
  rootSession?: string | null;
}): string {
  const backstage =
    opts.rootSession !== undefined && opts.rootSession !== null && opts.rootSession !== ''
      ? opts.rootSession
      : nodeSession();
  if (opts.adoptCaller && opts.here !== null) return opts.here.session;
  return backstage;
}

/** A node's durable REVIVE-HOME, with the legacy back-compat default. Nodes born
 *  before `home_session` existed have no such field in meta — they fall back to
 *  their last live LOCATION (`tmux_session`), then to the shared backstage
 *  (`nodeSession()`). The defaulted read for the placement layer; a present
 *  `home_session` is always returned verbatim. */
export function homeSessionOf(nodeId: string): string {
  const meta = getNode(nodeId);
  if (meta === null) return nodeSession();
  return meta.home_session ?? meta.tmux_session ?? nodeSession();
}

// ---------------------------------------------------------------------------
// The env contract — what a node's pi process inherits and its children read.
// ---------------------------------------------------------------------------

export interface NodeContext {
  nodeId: string | null;
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
  /** Editor-label handle (2-4 word kebab-case) for the node's first prompt. */
  description?: string;
  /** Parent node id. Omit for a user-opened root. */
  parent?: string | null;
  /** Who spawned me (the `spawned_by` provenance edge), when it differs from
   *  `parent` — e.g. an independent root (parent=null) still records its
   *  spawner. Defaults to `parent`. */
  spawnedBy?: string | null;
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
  // Provenance is independent of the spine: a root has no parent but still
  // records who spawned it. A child's spawner is its parent unless overridden.
  const spawnedBy = opts.spawnedBy ?? parent;
  const mode: Mode = opts.mode ?? 'base';
  // A user-opened root is resident (a conversation you live in); a spawned node
  // is terminal until it must persist (promotion handles that later).
  const lifecycle: Lifecycle = opts.lifecycle ?? (isRoot ? 'resident' : 'terminal');
  const meta: NodeMeta = {
    node_id: opts.nodeId ?? newNodeId(),
    name: opts.name ?? opts.kind,
    description: opts.description,
    cycles: 0,
    created: new Date().toISOString(),
    cwd: opts.cwd,
    kind: opts.kind,
    mode,
    lifecycle,
    // Born already acked to its initial persona: a fresh node has been "given
    // guidance" for the state it starts in (its bearings carry it), so the
    // persona injector sees no drift on its first turn boundary.
    persona_ack: { mode, lifecycle },
    status: 'active',
    parent,
    spawned_by: spawnedBy,
    passive_default: opts.passiveDefault ?? false,
    intent: null,
    pi_session_id: null,
    pi_session_file: null,
    launch: opts.launch,
  };

  // Validate BEFORE minting: a bad parent must leave no half-born orphan row or
  // dirs behind, so the parent's existence is checked before createNode
  // scaffolds anything on disk or in the db.
  if (parent !== null && getNode(parent) === null) {
    throw new Error(`cannot spawn under unknown parent node: ${parent}`);
  }

  createNode(meta);

  if (parent !== null) {
    // The load-bearing seed: parent subscribes (active) to child so it learns
    // when the work finishes. This mirrors spawn structure into the spine.
    // A root (parent=null) gets NO subscription — nobody is woken by it.
    subscribe(parent, meta.node_id, true);
  }

  // Audit-only provenance edge — recorded for a root too (from its spawner).
  if (spawnedBy !== null && spawnedBy !== undefined && getNode(spawnedBy) !== null) {
    recordSpawn(meta.node_id, spawnedBy);
  }

  return meta;
}
