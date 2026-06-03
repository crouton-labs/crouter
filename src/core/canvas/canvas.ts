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
} from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import {
  ensureHome,
  ensureNodeDirs,
  nodeMetaPath,
  nodeDir,
  nodesRoot,
} from './paths.js';
import type {
  NodeMeta,
  NodeRow,
  NodeStatus,
  SubscriptionRef,
  EdgeType,
} from './types.js';

// ---------------------------------------------------------------------------
// meta.json (source of truth)
// ---------------------------------------------------------------------------

function readMeta(nodeId: string): NodeMeta | null {
  const p = nodeMetaPath(nodeId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as NodeMeta;
}

function writeMeta(meta: NodeMeta): void {
  const p = nodeMetaPath(meta.node_id);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// row index (derived from meta)
// ---------------------------------------------------------------------------

function upsertRow(meta: NodeMeta): void {
  openDb()
    .prepare(
      `INSERT INTO nodes (node_id, name, kind, mode, lifecycle, status, cwd, parent, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         name=excluded.name, kind=excluded.kind, mode=excluded.mode,
         lifecycle=excluded.lifecycle, status=excluded.status, cwd=excluded.cwd,
         parent=excluded.parent`,
    )
    .run(
      meta.node_id,
      meta.name,
      meta.kind,
      meta.mode,
      meta.lifecycle,
      meta.status,
      meta.cwd,
      meta.parent ?? null,
      meta.created,
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
    parent: (r['parent'] as string | null) ?? null,
    created: r['created'] as string,
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Create a node: scaffold its dirs, write meta.json, index the row. */
export function createNode(meta: NodeMeta): NodeMeta {
  ensureHome();
  ensureNodeDirs(meta.node_id);
  writeMeta(meta);
  upsertRow(meta);
  return meta;
}

/** The canonical node record (from meta.json), or null if unknown. */
export function getNode(nodeId: string): NodeMeta | null {
  return readMeta(nodeId);
}

/** The indexed row (from the db) — cheap for queries that don't need full meta. */
export function getRow(nodeId: string): NodeRow | null {
  const r = openDb()
    .prepare('SELECT * FROM nodes WHERE node_id = ?')
    .get(nodeId) as Record<string, unknown> | undefined;
  return r ? rowFrom(r) : null;
}

/** Merge a patch into a node's meta.json and re-index its row. */
export function updateNode(nodeId: string, patch: Partial<NodeMeta>): NodeMeta {
  const cur = readMeta(nodeId);
  if (!cur) throw new Error(`unknown node: ${nodeId}`);
  const next: NodeMeta = { ...cur, ...patch, node_id: cur.node_id };
  writeMeta(next);
  upsertRow(next);
  return next;
}

/** Convenience for the most common mutation. */
export function setStatus(nodeId: string, status: NodeStatus): void {
  updateNode(nodeId, { status });
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
 *  Edges are left intact — subscribes_to is db-authoritative; spawned_by is
 *  re-derived from each meta's `parent`. */
export function rebuildIndex(): void {
  if (!existsSync(nodesRoot())) return;
  for (const id of readdirSync(nodesRoot())) {
    if (!existsSync(join(nodeDir(id), 'meta.json'))) continue;
    const meta = readMeta(id);
    if (!meta) continue;
    upsertRow(meta);
    if (meta.parent) recordSpawn(meta.node_id, meta.parent);
  }
}
