// The canvas vocabulary — the node + edge model the whole runtime hangs on.
//
// One global canvas (`~/.crtr/canvas.db`) holds the topology (nodes + edges);
// each node's flesh lives on disk under `~/.crtr/nodes/<id>/`. A node's
// `meta.json` is the source of truth for its own row; the db is a queryable
// index over those metas, plus the authoritative store for the mutable
// `subscribes_to` edges (which no single meta owns).

/** What a node is doing right now. UI shows active+idle; `done` is hidden but
 *  revivable; only `dead` is a fault. */
export type NodeStatus = 'active' | 'idle' | 'done' | 'dead';

/** Does stopping finalize the node? terminal = worker (finalizes on push --final);
 *  resident = manager/orchestrator (stays dormant, woken by inbox). */
export type Lifecycle = 'terminal' | 'resident';

/** base = hands-on worker; orchestrator = delegating manager. Bespoke per kind. */
export type Mode = 'base' | 'orchestrator';

/** Why a node last stopped — drives the daemon's reap-vs-revive decision. */
export type ExitIntent = 'done' | 'refresh' | 'idle-release' | null;

/** The two structural edges. `subscribes_to` is the load-bearing spine (flow,
 *  org chart, views, completion routing). `spawned_by` is audit only. */
export type EdgeType = 'subscribes_to' | 'spawned_by';

/** The pi launch recipe, persisted so the daemon can faithfully revive a node
 *  as its *current* self. Rewritten on every polymorph (base→orchestrator). */
export interface LaunchSpec {
  /** Model id/pattern passed to pi `--model`. */
  model?: string;
  /** pi `--tools` allow-list. */
  tools?: string[];
  /** pi `-e` extension paths, loaded once; they self-gate on live {kind,mode}. */
  extensions: string[];
  /** Resolved system prompt text (passed via --append-system-prompt / --system-prompt). */
  systemPrompt?: string;
  /** Extra env injected into the pi process. */
  env: Record<string, string>;
}

/** A node's `meta.json` — source of truth for its canvas row. Files for flesh,
 *  sqlite for skeleton: the db indexes the queryable subset of these fields. */
export interface NodeMeta {
  node_id: string;
  name: string;
  created: string; // ISO 8601
  /** The dir this node is pinned to — its cwd (where pi runs, bash executes). */
  cwd: string;
  /** Role the node was born as: explore | developer | plan | review | general… */
  kind: string;
  mode: Mode;
  lifecycle: Lifecycle;
  status: NodeStatus;
  /** spawned_by target — who created me. Audit only; null for user-opened roots. */
  parent?: string | null;
  /** New subscriptions this node opens default to passive when true. */
  passive_default?: boolean;
  /** Why the node last stopped (done | refresh). Drives reap-vs-revive. */
  intent?: ExitIntent;
  /** The pi session id for `--resume`. */
  pi_session_id?: string | null;
  /** Full pi launch recipe; rewritten on every polymorph. */
  launch?: LaunchSpec;
  /** Presence: the tmux session (its root's home) and window this node renders
   *  in while active. Cleared when the node goes done/dead and its window closes.
   *  (Phase 5 promotes this to a dedicated presence registry.) */
  tmux_session?: string | null;
  window?: string | null;
}

/** The queryable projection of a NodeMeta stored as a canvas.db row. */
export interface NodeRow {
  node_id: string;
  name: string;
  kind: string;
  mode: Mode;
  lifecycle: Lifecycle;
  status: NodeStatus;
  cwd: string;
  parent: string | null;
  created: string;
}

/** An edge as stored. For `subscribes_to`, `from` is the subscriber and `to`
 *  is the publisher (A subscribes_to B ⇒ A receives B's output). For
 *  `spawned_by`, `from` is the child and `to` is the parent. */
export interface Edge {
  type: EdgeType;
  from: string;
  to: string;
  /** Only meaningful for subscribes_to: active = wake the subscriber on emit;
   *  passive = accumulate pointers, no wake. */
  active: boolean;
  created: string;
}

/** A subscription as seen from one endpoint. */
export interface SubscriptionRef {
  /** The node id at the other end of the edge. */
  node_id: string;
  active: boolean;
  created: string;
}
