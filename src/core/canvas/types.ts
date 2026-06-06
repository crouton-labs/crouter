// The canvas vocabulary — the node + edge model the whole runtime hangs on.
//
// One global canvas (`~/.crtr/canvas.db`) holds the topology (nodes + edges);
// each node's flesh lives on disk under `~/.crtr/nodes/<id>/`. A node's
// `meta.json` is the source of truth for its own row; the db is a queryable
// index over those metas, plus the authoritative store for the mutable
// `subscribes_to` edges (which no single meta owns).

/** What a node is doing right now. UI shows active+idle; `done` is hidden but
 *  revivable; `canceled` is a user-closed node (also hidden, also revivable —
 *  not a fault); only `dead` is a fault. */
export type NodeStatus = 'active' | 'idle' | 'done' | 'dead' | 'canceled';

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

/** A node's DURABLE IDENTITY — the subset that `meta.json` persists on disk.
 *  Written rarely (birth, polymorph, session-id capture, naming); never touched
 *  by a status flip, an intent change, a focus swap, or a pid stamp. The db row
 *  indexes the queryable identity columns; `rebuildIndex()` re-derives them from
 *  here. (Live runtime state lives in NodeRuntime, authoritative in the row.) */
export interface NodeIdentity {
  node_id: string;
  name: string;
  /** A 2-4 word kebab-case handle derived from the node's first prompt (named
   *  headlessly by pi; see runtime/naming.ts). Shown in the editor label. */
  description?: string;
  /** How many times this node has been (re)launched — born at 0, bumped on
   *  every revive. The trailing N in the editor label, so a refresh/crash cycle
   *  reads at a glance. */
  cycles?: number;
  created: string; // ISO 8601
  /** The dir this node is pinned to — its cwd (where pi runs, bash executes). */
  cwd: string;
  /** Role the node was born as: explore | developer | plan | review | general… */
  kind: string;
  mode: Mode;
  lifecycle: Lifecycle;
  /** The last persona state {mode,lifecycle} the node was GIVEN transition
   *  guidance for. Meta-only (not a db column). Born equal to the node's initial
   *  {mode,lifecycle} at spawn so a fresh node never gets spurious guidance. The
   *  persona injector (runtime/persona.ts) compares the live {mode,lifecycle}
   *  against this and, on drift, injects guidance for the new state then commits
   *  it here. */
  persona_ack?: { mode: Mode; lifecycle: Lifecycle };
  /** Spine parent — my manager (who subscribes to me); drives canvas nesting +
   *  orphaning. null for a root (top-level, no manager). */
  parent?: string | null;
  /** Provenance — who spawned me (the `spawned_by` edge). Decoupled from
   *  `parent` so an INDEPENDENT root (parent=null) still records its lineage.
   *  Audit only; null for a user-opened root. Defaults to `parent` for a child. */
  spawned_by?: string | null;
  /** New subscriptions this node opens default to passive when true. */
  passive_default?: boolean;
  /** REVIVE-HOME — the tmux session a node is (re)opened into when it must
   *  generate but is NOT focused (the durable revive target, distinct from the
   *  live LOCATION held by the runtime `tmux_session`). Set once at birth
   *  (managed child → the shared backstage `nodeSession()`; inline root → the
   *  adopted caller session; independent `--root` → the caller session), and
   *  rewritten only by demote-recycle. Durable identity (like `cwd`), never
   *  touched by a focus swap — this is what keeps a background revive off the
   *  user's session. Legacy metas omit it; readers default to
   *  `tmux_session ?? nodeSession()` (see `homeSessionOf`). */
  home_session?: string;
  /** The pi session id for `--session <id>` revival. */
  pi_session_id?: string | null;
  /** Absolute path to pi's session `.jsonl` file, captured at session_start via
   *  ctx.sessionManager.getSessionFile(). Preferred over pi_session_id when
   *  resuming: pi resolves a BARE `--session <id>` relative to the launch cwd
   *  first (and shows an interactive cross-project "Fork? [y/N]" prompt when the
   *  revive cwd differs from the session's creation cwd), whereas an absolute
   *  PATH is opened directly — immune to any cwd discrepancy. Null for older
   *  nodes booted before this field existed → revive falls back to the bare id. */
  pi_session_file?: string | null;
  /** Full pi launch recipe; rewritten on every polymorph. */
  launch?: LaunchSpec;
}

/** A node's LIVE RUNTIME state — authoritative in the WAL'd `nodes` row, each
 *  field mutated by exactly one atomic single-statement `UPDATE` (setStatus /
 *  setIntent / setPresence / recordPid+clearPid). NOT persisted to meta.json and
 *  NOT re-derivable by `rebuildIndex()` — it describes live process/presence
 *  state that is meaningless after the event that would lose the db; the daemon
 *  reconciles it from tmux reality, not from a stale file. */
export interface NodeRuntime {
  /** What the node is doing right now. */
  status: NodeStatus;
  /** Why the node last stopped (done | refresh | idle-release). Drives reap-vs-revive.
   *  Optional on the hydrated view (a fresh construction omits it); the row
   *  column is always present, defaulting null. */
  intent?: ExitIntent;
  /** OS pid of the live pi process, recorded on boot (stophook session_start).
   *  The daemon's authoritative liveness signal: an inline root runs pi as a
   *  child of a persistent login shell, so its tmux window outlives a dead pi —
   *  window-existence alone can't detect the death, but a dead pid can. Cleared
   *  to null by a window-backed relaunch (reviveNode) until the fresh pi
   *  re-records it; left intact by an in-place respawn (reviveInPlace) so a
   *  failed respawn surfaces as a dead pid. */
  pi_pid?: number | null;
  /** Presence: the tmux session (its root's home) and window this node renders
   *  in while active. Cleared when the node goes done/dead and its window closes.
   *  The row IS the presence registry (one atomic setPresence per move).
   *  v3: a DERIVED CACHE of `pane`'s current location — reconciled from the pane,
   *  never trusted when a user move could have desynced them. */
  tmux_session?: string | null;
  window?: string | null;
  /** LOCATION's authoritative handle — the durable tmux `%pane_id` this node's
   *  pane is anchored on. tmux preserves it across `move-pane`/`join-pane`/
   *  `break-pane` and window renumbering, so `window`/`tmux_session` above are a
   *  cache reconciled from it and pane-existence is the liveness probe. A
   *  not-focused + not-generating node has `pane = null` (no pane). Authoritative
   *  in the row exactly like `window`/`tmux_session` — a RUNTIME field, NOT meta
   *  identity — written by the one atomic `setPresence` UPDATE. */
  pane?: string | null;
}

/** The hydrated node view `getNode()` returns: durable identity (from meta.json)
 *  ∪ live runtime (from the row). Keeps the historical `NodeMeta` name and field
 *  set so every `meta.X` read across the codebase typechecks unchanged — but
 *  `writeMeta` serializes only the NodeIdentity subset and the runtime fields are
 *  hydrated from the authoritative row. */
export type NodeMeta = NodeIdentity & NodeRuntime;

/** The queryable projection of a node stored as a canvas.db row: the indexed
 *  identity columns PLUS the authoritative runtime columns. */
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
  /** Authoritative runtime columns (see NodeRuntime). */
  intent: ExitIntent;
  pi_pid: number | null;
  window: string | null;
  tmux_session: string | null;
  /** The durable LOCATION handle (the tmux `%pane_id`); see NodeRuntime.pane. */
  pane: string | null;
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

/** A FOCUS row as stored in the `focuses` table (canvas.db, migration v6): one
 *  durable on-screen viewport the user looks at, bound to one node. Plural —
 *  many focuses live at once across windows and sessions (the plural
 *  generalization of the old single `focus.ptr`). Anchored on the durable tmux
 *  `%pane_id`; `session` is a derived cache reconciled from the pane. `node_id`
 *  is UNIQUE — a node occupies at most one focus (Q5). */
export interface FocusRow {
  /** Stable internal id for the viewport (the table's primary key). */
  focus_id: string;
  /** The durable `%pane_id` realizing the focus, or null before it is placed. */
  pane: string | null;
  /** Derived cache of the user session the pane lives in (reconciled from pane). */
  session: string | null;
  /** The node this focus shows. UNIQUE → a node occupies ≤1 focus. */
  node_id: string;
}

/** A subscription as seen from one endpoint. */
export interface SubscriptionRef {
  /** The node id at the other end of the edge. */
  node_id: string;
  active: boolean;
  created: string;
}
