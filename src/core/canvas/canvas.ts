// The canvas data-access layer. The one place that reads/writes the node+edge
// model. Later phases (spawn, push, lifecycle, daemon) call only this.
//
// Source-of-truth split: a node's meta.json is canonical for its own fields;
// the db row is a queryable index re-derivable from it. The subscribes_to edges
// are db-authoritative (mutable, many-writers — what WAL is for).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { isPidAlive } from './pid.js';
import {
  ensureHome,
  ensureNodeDirs,
  nodeMetaPath,
  nodeDir,
  nodesRoot,
} from './paths.js';
import type {
  NodeMeta,
  NodeIdentity,
  NodeRow,
  NodeStatus,
  ExitIntent,
  SubscriptionRef,
  EdgeType,
} from './types.js';

// ---------------------------------------------------------------------------
// meta.json (durable identity — the source of truth for what PERSISTS)
//
// One authoritative store per fact: meta.json holds NodeIdentity only; the six
// runtime fields (status, intent, pi_pid, window, tmux_session, pane) are
// authoritative in the WAL'd `nodes` row, each mutated by one atomic setter
// below. getNode() hydrates the two back into the historical NodeMeta view.
// ---------------------------------------------------------------------------

/** The identity keys meta.json persists. Listed explicitly so no runtime field
 *  can ever leak onto disk even when a fully-hydrated NodeMeta is handed in. */
const IDENTITY_KEYS: ReadonlyArray<keyof NodeIdentity> = [
  'node_id', 'name', 'description', 'cycles', 'created', 'cwd', 'host_kind', 'kind', 'mode',
  'lifecycle', 'persona_ack', 'parent', 'spawned_by', 'fork_from', 'passive_default',
  'home_session', 'pi_session_id', 'pi_session_file', 'model_override', 'launch',
];

/** Project any node object down to its durable-identity subset. */
function toIdentity(m: NodeIdentity): NodeIdentity {
  const out: Record<string, unknown> = {};
  for (const k of IDENTITY_KEYS) {
    if (m[k] !== undefined) out[k] = m[k];
  }
  return out as unknown as NodeIdentity;
}

function readMeta(nodeId: string): NodeIdentity | null {
  const p = nodeMetaPath(nodeId);
  if (!existsSync(p)) return null;
  // Legacy metas may still carry runtime fields on disk; toIdentity-on-read is
  // unnecessary (callers go through getNode, which overlays the row), but the
  // raw parse is typed as identity — extra props are ignored.
  return JSON.parse(readFileSync(p, 'utf8')) as NodeIdentity;
}

/** Serialize ONLY the identity subset → meta.json never holds runtime fields. */
function writeMeta(meta: NodeIdentity): void {
  const p = nodeMetaPath(meta.node_id);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(toIdentity(meta), null, 2));
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// row index — identity columns are a derived projection of meta; runtime
// columns are authoritative. The two have DIFFERENT writers: upsertRow only
// ever touches identity (so a re-index never clobbers live runtime), while
// createNode seeds runtime once and the atomic setters own it thereafter.
// ---------------------------------------------------------------------------

/** Upsert the IDENTITY columns of a node's row. ON CONFLICT updates identity
 *  ONLY — runtime columns (status/intent/pi_pid/window/tmux_session/pane) are left
 *  exactly as they are, so re-indexing or an identity edit never disturbs live
 *  state. A fresh insert takes the schema defaults for runtime. */
function upsertRow(meta: NodeIdentity): void {
  openDb()
    .prepare(
      `INSERT INTO nodes (node_id, name, kind, mode, lifecycle, cwd, host_kind, parent, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         name=excluded.name, kind=excluded.kind, mode=excluded.mode,
         lifecycle=excluded.lifecycle, cwd=excluded.cwd, host_kind=excluded.host_kind,
         parent=excluded.parent`,
    )
    .run(
      meta.node_id,
      meta.name,
      meta.kind,
      meta.mode,
      meta.lifecycle,
      meta.cwd,
      meta.host_kind ?? null,
      meta.parent ?? null,
      meta.created,
    );
}

/** Seed a node's row at BIRTH: identity columns + runtime columns taken from the
 *  incoming meta (defaults: status='active', the rest null). The only writer
 *  that sets runtime columns alongside identity in one statement — afterwards
 *  the atomic setters are the sole runtime writers. */
function seedRow(meta: NodeMeta): void {
  openDb()
    .prepare(
      `INSERT INTO nodes
         (node_id, name, kind, mode, lifecycle, cwd, host_kind, parent, created,
          status, intent, pi_pid, "window", tmux_session, pane)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         name=excluded.name, kind=excluded.kind, mode=excluded.mode,
         lifecycle=excluded.lifecycle, cwd=excluded.cwd, host_kind=excluded.host_kind,
         parent=excluded.parent,
         status=excluded.status, intent=excluded.intent, pi_pid=excluded.pi_pid,
         "window"=excluded."window", tmux_session=excluded.tmux_session,
         pane=excluded.pane`,
    )
    .run(
      meta.node_id,
      meta.name,
      meta.kind,
      meta.mode,
      meta.lifecycle,
      meta.cwd,
      meta.host_kind ?? null,
      meta.parent ?? null,
      meta.created,
      meta.status ?? 'active',
      meta.intent ?? null,
      meta.pi_pid ?? null,
      meta.window ?? null,
      meta.tmux_session ?? null,
      meta.pane ?? null,
    );
}

function rowFrom(r: Record<string, unknown>): NodeRow {
  return {
    node_id: r['node_id'] as string,
    name: r['name'] as string,
    kind: r['kind'] as string,
    mode: r['mode'] as NodeRow['mode'],
    lifecycle: r['lifecycle'] as NodeRow['lifecycle'],
    status: r['status'] as NodeStatus,
    cwd: r['cwd'] as string,
    host_kind: (r['host_kind'] as 'tmux' | 'broker' | null) ?? null,
    parent: (r['parent'] as string | null) ?? null,
    created: r['created'] as string,
    intent: (r['intent'] as ExitIntent) ?? null,
    pi_pid: (r['pi_pid'] as number | null) ?? null,
    window: (r['window'] as string | null) ?? null,
    tmux_session: (r['tmux_session'] as string | null) ?? null,
    pane: (r['pane'] as string | null) ?? null,
  };
}

/** The authoritative runtime fields for `nodeId`, read from its row. Null when
 *  no row exists yet (the hydration then falls back to whatever the meta held). */
function runtimeFromRow(nodeId: string): Partial<NodeMeta> | null {
  const r = openDb()
    .prepare(
      'SELECT status, intent, pi_pid, "window", tmux_session, pane FROM nodes WHERE node_id = ?',
    )
    .get(nodeId) as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    status: (r['status'] as NodeStatus) ?? 'active',
    intent: (r['intent'] as ExitIntent) ?? null,
    pi_pid: (r['pi_pid'] as number | null) ?? null,
    window: (r['window'] as string | null) ?? null,
    tmux_session: (r['tmux_session'] as string | null) ?? null,
    pane: (r['pane'] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Create a node: scaffold its dirs, persist identity to meta.json, and seed the
 *  row (identity + runtime from the incoming meta). Returns the hydrated view. */
export function createNode(meta: NodeMeta): NodeMeta {
  ensureHome();
  ensureNodeDirs(meta.node_id);
  writeMeta(meta);
  seedRow(meta);
  return getNode(meta.node_id) as NodeMeta;
}

/** The canonical node record: durable identity (meta.json) ∪ authoritative
 *  runtime (the row). Null if unknown. */
export function getNode(nodeId: string): NodeMeta | null {
  const ident = readMeta(nodeId);
  if (ident === null) return null;
  const rt = runtimeFromRow(nodeId);
  // The row is authoritative for runtime; overlay it over identity. When no row
  // exists yet (rare — pre-rebuild), keep whatever the meta carried.
  return { ...ident, ...(rt ?? {}) } as NodeMeta;
}

/** The indexed row (from the db) — cheap for queries that don't need full meta. */
export function getRow(nodeId: string): NodeRow | null {
  const r = openDb()
    .prepare('SELECT * FROM nodes WHERE node_id = ?')
    .get(nodeId) as Record<string, unknown> | undefined;
  return r ? rowFrom(r) : null;
}

/** The node row whose durable LOCATION pane is `pane`, or null. Lets placement
 *  resolve "who sits in this pane" by the first-class `%pane_id` handle (e.g.
 *  to adopt a caller's pane as a focus). pane is not UNIQUE in the schema, but a
 *  live pane backs at most one node, so this returns the single match. */
export function getRowByPane(pane: string): NodeRow | null {
  const r = openDb()
    .prepare('SELECT * FROM nodes WHERE pane = ?')
    .get(pane) as Record<string, unknown> | undefined;
  return r ? rowFrom(r) : null;
}

/** Merge an IDENTITY patch into a node's meta.json and re-index its identity
 *  columns. Identity has a single writer per node, so this read-modify-write is
 *  safe (the contended runtime fields were moved out — see the atomic setters
 *  below). Returns the hydrated view (runtime included). */
export function updateNode(nodeId: string, patch: Partial<NodeIdentity>): NodeMeta {
  const cur = readMeta(nodeId);
  if (!cur) throw new Error(`unknown node: ${nodeId}`);
  const next: NodeIdentity = { ...cur, ...patch, node_id: cur.node_id };
  writeMeta(next);
  upsertRow(next);
  return getNode(nodeId) as NodeMeta;
}

// ---------------------------------------------------------------------------
// Atomic runtime setters — each one a single-statement UPDATE on the WAL'd row,
// the authoritative store for live state. No read-modify-write, so concurrent
// writers of DIFFERENT fields (the daemon stamping pi_pid while a node flips
// status) can never clobber each other: WAL serializes the two statements.
// `"window"` is quoted defensively — it is a SQLite keyword.
// ---------------------------------------------------------------------------

/** Set a node's status. Atomic single-column write. */
export function setStatus(nodeId: string, status: NodeStatus): void {
  openDb().prepare('UPDATE nodes SET status = ? WHERE node_id = ?').run(status, nodeId);
}

/** Set a node's exit intent. Atomic single-column write. */
export function setIntent(nodeId: string, intent: ExitIntent): void {
  openDb().prepare('UPDATE nodes SET intent = ? WHERE node_id = ?').run(intent ?? null, nodeId);
}

/** Set a node's tmux presence in one atomic write: the durable LOCATION anchor
 *  `pane` (the `%pane_id`) plus its derived cache (`tmux_session` + `window`).
 *  All three move together — `pane` joins the others inside the single UPDATE so
 *  a move never half-writes the location. `pane` is optional: a caller that does
 *  not yet track it (every caller, until the placement layer lands) writes null,
 *  which is harmless because nothing reads `pane` yet. */
export function setPresence(
  nodeId: string,
  presence: { tmux_session?: string | null; window?: string | null; pane?: string | null },
): void {
  openDb()
    .prepare('UPDATE nodes SET tmux_session = ?, "window" = ?, pane = ? WHERE node_id = ?')
    .run(presence.tmux_session ?? null, presence.window ?? null, presence.pane ?? null, nodeId);
}

/** Record the live pi pid (daemon liveness signal). Atomic single-column write. */
export function recordPid(nodeId: string, pid: number): void {
  openDb().prepare('UPDATE nodes SET pi_pid = ? WHERE node_id = ?').run(pid, nodeId);
}

/** Clear the pi pid (window-backed relaunch, before the fresh pi re-records it). */
export function clearPid(nodeId: string): void {
  openDb().prepare('UPDATE nodes SET pi_pid = NULL WHERE node_id = ?').run(nodeId);
}

/** All rows, optionally filtered by status. */
export function listNodes(filter?: { status?: NodeStatus | NodeStatus[] }): NodeRow[] {
  const db = openDb();
  let rows: Record<string, unknown>[];
  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const placeholders = statuses.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT * FROM nodes WHERE status IN (${placeholders}) ORDER BY created`)
      .all(...statuses) as Record<string, unknown>[];
  } else {
    rows = db.prepare('SELECT * FROM nodes ORDER BY created').all() as Record<string, unknown>[];
  }
  return rows.map(rowFrom);
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function addEdge(type: EdgeType, from: string, to: string, active: boolean): void {
  openDb()
    .prepare(
      `INSERT INTO edges (type, from_id, to_id, active, created)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(type, from_id, to_id) DO UPDATE SET active=excluded.active`,
    )
    .run(type, from, to, active ? 1 : 0, new Date().toISOString());
}

/** Record `A subscribes_to B` — A receives B's output. active=true wakes A on
 *  emit; passive accumulates pointers without a wake. Mutable; callable by anyone. */
export function subscribe(subscriber: string, publisher: string, active = true): void {
  addEdge('subscribes_to', subscriber, publisher, active);
}

/** Drop a subscription edge. */
export function unsubscribe(subscriber: string, publisher: string): void {
  openDb()
    .prepare('DELETE FROM edges WHERE type = ? AND from_id = ? AND to_id = ?')
    .run('subscribes_to', subscriber, publisher);
}

/** Flip an existing subscription's wake behavior. */
export function setSubscriptionActive(subscriber: string, publisher: string, active: boolean): void {
  openDb()
    .prepare('UPDATE edges SET active = ? WHERE type = ? AND from_id = ? AND to_id = ?')
    .run(active ? 1 : 0, 'subscribes_to', subscriber, publisher);
}

/** Record the audit-only `child spawned_by parent` edge. */
export function recordSpawn(child: string, parent: string): void {
  addEdge('spawned_by', child, parent, true);
}

/** Who subscribes to `publisher` — the targets a push fans out to. */
export function subscribersOf(publisher: string): SubscriptionRef[] {
  return (
    openDb()
      .prepare(
        `SELECT from_id AS node_id, active, created FROM edges
         WHERE type = 'subscribes_to' AND to_id = ? ORDER BY created`,
      )
      .all(publisher) as Record<string, unknown>[]
  ).map((r) => ({
    node_id: r['node_id'] as string,
    active: (r['active'] as number) === 1,
    created: r['created'] as string,
  }));
}

/** Who `subscriber` subscribes to — its reports / the nodes feeding it. */
export function subscriptionsOf(subscriber: string): SubscriptionRef[] {
  return (
    openDb()
      .prepare(
        `SELECT to_id AS node_id, active, created FROM edges
         WHERE type = 'subscribes_to' AND from_id = ? ORDER BY created`,
      )
      .all(subscriber) as Record<string, unknown>[]
  ).map((r) => ({
    node_id: r['node_id'] as string,
    active: (r['active'] as number) === 1,
    created: r['created'] as string,
  }));
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

/** A "view": every node whose output cascades up to `root` via subscriptions —
 *  the subscription sub-DAG reachable downward (root → its reports → theirs …).
 *  Returns ids excluding root, in BFS order. Cycle-safe. */
export function view(root: string): string[] {
  const seen = new Set<string>([root]);
  const out: string[] = [];
  const queue = subscriptionsOf(root).map((s) => s.node_id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const s of subscriptionsOf(id)) {
      if (!seen.has(s.node_id)) queue.push(s.node_id);
    }
  }
  return out;
}

/** Stop-guard primitive: does this node hold an *active* subscription to a node
 *  that's still live (active|idle) — i.e. something that can actually wake it?
 *  If so, stopping is a legitimate await; if not, it must finish or escalate. */
export function hasActiveLiveSubscription(nodeId: string): boolean {
  const r = openDb()
    .prepare(
      `SELECT 1 FROM edges e JOIN nodes n ON n.node_id = e.to_id
       WHERE e.type = 'subscribes_to' AND e.from_id = ? AND e.active = 1
         AND n.status IN ('active', 'idle') LIMIT 1`,
    )
    .get(nodeId);
  return r !== undefined;
}

// ---------------------------------------------------------------------------
// Index rebuild
// ---------------------------------------------------------------------------

/** Rebuild node rows from on-disk metas (the db node table is a derived index).
 *  Only the IDENTITY columns are rebuilt — they are a projection of meta. The
 *  runtime columns (status/intent/pi_pid/window/tmux_session/pane) are NOT in meta
 *  and NOT re-derivable from it: they describe live process/presence state, so
 *  an existing row keeps them and a freshly re-created row takes the schema's
 *  quiescent defaults (status='active', the rest null). The daemon reconciles
 *  liveness from tmux reality, not from a stale file.
 *  Edges are left intact — subscribes_to is db-authoritative; spawned_by is
 *  re-derived from each meta's `spawned_by` (fallback: `parent` for legacy metas). */
export function rebuildIndex(): void {
  if (!existsSync(nodesRoot())) return;
  // Collect every on-disk meta first, then index in TWO passes. Under the
  // edges→nodes FK (migration v4), a `spawned_by` edge insert whose endpoint
  // row isn't present yet violates the constraint — so ALL node rows must exist
  // before ANY edge is added.
  const metas: NodeIdentity[] = [];
  for (const id of readdirSync(nodesRoot())) {
    if (!existsSync(join(nodeDir(id), 'meta.json'))) continue;
    const meta = readMeta(id);
    if (!meta) continue;
    metas.push(meta);
  }
  // Pass 1 — upsert every node row (the edge endpoints).
  for (const meta of metas) upsertRow(meta);
  // Pass 2 — add the audit-only `spawned_by` provenance edges. Skip any whose
  // provenance node has no on-disk meta (a deleted/pruned ancestor): the FK
  // would reject it, and an orphan provenance edge is exactly what v4 makes
  // unrepresentable.
  const known = new Set(metas.map((m) => m.node_id));
  for (const meta of metas) {
    const prov = meta.spawned_by ?? meta.parent;
    if (prov && known.has(prov)) recordSpawn(meta.node_id, prov);
  }
}

// ---------------------------------------------------------------------------
// Retention / GC
// ---------------------------------------------------------------------------

/** A node selected for pruning (or that would be, under --dry-run). */
export interface PrunedNode {
  node_id: string;
  status: NodeStatus;
  created: string;
}

export interface PruneResult {
  /** The nodes pruned (or, under dryRun, the nodes that WOULD be pruned). */
  pruned: PrunedNode[];
  dryRun: boolean;
}

/** Retention sweep: remove TERMINAL nodes (status dead | done | canceled) whose
 *  `created` is older than `ttlDays`, bounding the otherwise-unbounded growth of
 *  node rows + dirs. The edges→nodes FK (`ON DELETE CASCADE`, migration v4) GCs
 *  each pruned node's edges automatically; the on-disk `nodes/<id>/` dir is
 *  removed too.
 *
 *  With `includeStale`, ALSO prunes nominally-live (active | idle) nodes past the
 *  TTL whose process is provably gone — `pi_pid` is NULL or no longer alive. This
 *  reaps stale roots (a bare `crtr` whose pi died without the row transitioning),
 *  which the daemon's supervision never reconciled. A genuinely-running node keeps
 *  a live `pi_pid`, so it is protected, as is the CALLER ($CRTR_NODE_ID). Without
 *  the flag, active | idle are NEVER touched (the daemon's domain).
 *
 *  The row deletes run in ONE transaction (so the sweep is all-or-nothing); the
 *  dir removals follow after COMMIT — the fs isn't transactional, and by then the
 *  rows are gone, so a re-run never re-finds a half-deleted node. `dryRun`
 *  reports the candidate set and deletes NOTHING. */
export function pruneNodes(opts: { ttlDays: number; dryRun?: boolean; includeStale?: boolean }): PruneResult {
  const dryRun = opts.dryRun ?? false;
  const includeStale = opts.includeStale ?? false;
  const cutoff = new Date(Date.now() - opts.ttlDays * 86_400_000).toISOString();
  const selfId = process.env['CRTR_NODE_ID'] ?? '';
  const db = openDb();
  const terminal = (
    db
      .prepare(
        `SELECT node_id, status, created FROM nodes
         WHERE status IN ('dead', 'done', 'canceled') AND created < ?
         ORDER BY created`,
      )
      .all(cutoff) as Array<Record<string, unknown>>
  ).map((r): PrunedNode => ({
    node_id: r['node_id'] as string,
    status: r['status'] as NodeStatus,
    created: r['created'] as string,
  }));

  // Stale non-terminal sweep (opt-in): active | idle past the TTL whose process
  // is provably gone (pi_pid NULL or not alive). Never the caller itself.
  const stale: PrunedNode[] = !includeStale ? [] : (
    db
      .prepare(
        `SELECT node_id, status, created, pi_pid FROM nodes
         WHERE status IN ('active', 'idle') AND created < ?
         ORDER BY created`,
      )
      .all(cutoff) as Array<Record<string, unknown>>
  )
    .filter((r) => {
      if ((r['node_id'] as string) === selfId) return false;
      const pid = r['pi_pid'] as number | null;
      return !isPidAlive(pid);
    })
    .map((r): PrunedNode => ({
      node_id: r['node_id'] as string,
      status: r['status'] as NodeStatus,
      created: r['created'] as string,
    }));

  const candidates = [...terminal, ...stale];

  if (dryRun || candidates.length === 0) return { pruned: candidates, dryRun };

  // One transactioned sweep — delete the rows; the FK cascades their edges.
  db.exec('BEGIN');
  try {
    const del = db.prepare('DELETE FROM nodes WHERE node_id = ?');
    for (const c of candidates) del.run(c.node_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Remove each pruned node's on-disk dir (best-effort, after COMMIT).
  for (const c of candidates) {
    rmSync(nodeDir(c.node_id), { recursive: true, force: true });
  }

  return { pruned: candidates, dryRun };
}
