// subject.ts — the node-config SUBJECT a document's `gate` predicate is
// evaluated against. Assembled per node from its canvas-db `NodeMeta` plus two
// DERIVED fields: `scope` (the scope.ts resolution for the node's cwd) and
// `orchestration.depth` (the node's spine distance to its root orchestrator).
// See design-substrate.md §4 + plan-substrate.md §2. Reads canvas-db; otherwise
// a thin, pure assembler.

import { getNode, getRow, type Mode, type Lifecycle } from '../canvas/index.js';
import { projectScopeRoot } from '../scope.js';

/** The gate input: a node's configuration as a structured object. Field names
 *  and shape are the predicate vocabulary's dotted paths (`orchestration.depth`,
 *  `hasManager`, …). There is intentionally NO `tags` field — NodeMeta has none. */
export interface NodeConfigSubject {
  /** The node's role, free-form (developer | explore | design | …). NodeMeta.kind. */
  kind: string;
  /** base (hands-on worker) | orchestrator (delegating manager). NodeMeta.mode. */
  mode: Mode;
  /** terminal (worker) | resident (manager). NodeMeta.lifecycle. */
  lifecycle: Lifecycle;
  /** Spine position: does this node have a manager? (= parent !== null). */
  hasManager: boolean;
  /** The node's working directory on disk. NodeMeta.cwd. */
  cwd: string;
  /** DERIVED: the scope scope.ts resolves for `cwd` — `project` when a
   *  nearest-ancestor `.crouter/` exists at/above cwd, else `user`. */
  scope: 'user' | 'project';
  /** DERIVED orchestration metrics. */
  orchestration: {
    /** Spine distance (hops) from this node up to its root orchestrator. The
     *  root itself is 0; a direct child of the root is 1; etc. */
    depth: number;
  };
}

/** The scope a cwd resolves into: `project` when scope.ts finds a
 *  nearest-ancestor `.crouter/` at/above it, else `user`. Reuses the existing
 *  resolver (`projectScopeRoot`). NOTE: `findProjectScopeRoot` is process-cached
 *  on first call, so for a node assembling its OWN subject (cwd === process.cwd)
 *  this is exact; resolving an arbitrary unrelated cwd in the same process would
 *  return the cached root — fine for per-node subject assembly. */
export function scopeForCwd(cwd: string): 'user' | 'project' {
  return projectScopeRoot(cwd) !== null ? 'project' : 'user';
}

/** Spine distance from `nodeId` up to its root orchestrator: count the hops
 *  walking the `parent` chain (canvas-db rows) until a row with no parent (the
 *  root). The root is depth 0. Cycle-guarded (parents must not cycle, but never
 *  loop forever) — mirrors `rootOfSpine` in runtime/placement.ts. */
export function spineDepth(nodeId: string): number {
  let cur = nodeId;
  const seen = new Set<string>();
  let hops = 0;
  for (;;) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = getRow(cur);
    if (row === null || row.parent == null) break;
    cur = row.parent;
    hops++;
  }
  return hops;
}

/** Assemble the node-config subject for `nodeId` from its `NodeMeta` + the two
 *  derived fields. Returns `null` when the node has no canvas-db row (an
 *  unknown id). Pure aside from the canvas-db reads. */
export function assembleNodeSubject(nodeId: string): NodeConfigSubject | null {
  const meta = getNode(nodeId);
  if (meta === null) return null;
  return {
    kind: meta.kind,
    mode: meta.mode,
    lifecycle: meta.lifecycle,
    hasManager: (meta.parent ?? null) !== null,
    cwd: meta.cwd,
    scope: scopeForCwd(meta.cwd),
    orchestration: { depth: spineDepth(nodeId) },
  };
}
