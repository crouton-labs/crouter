// `crtr canvas prune` — bounded retention for the node graph.
//
// The canvas never deleted a node before this: dead/done/canceled rows + their
// `nodes/<id>/` dirs accumulated without limit. `prune` is the retention sweep —
// remove TERMINAL nodes (dead | done | canceled) older than a TTL; the edges→nodes
// FK (ON DELETE CASCADE) GCs their edges, and each node's dir is removed too.
// Live nodes (active | idle, the daemon's domain) are never touched.
//
// Exported as a leaf; `crtr canvas` (canvas.ts) mounts it.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { pruneNodes } from '../core/canvas/index.js';

const DEFAULT_TTL_DAYS = 14;

export const canvasPruneLeaf: LeafDef = defineLeaf({
  name: 'prune',
  description: 'remove terminal nodes (dead/done/canceled) older than a TTL',
  whenToUse: 'you want to bound the canvas\u2019s on-disk growth \u2014 sweep away nodes that are finished (done), crashed (dead), or closed (canceled) and older than a retention window, reclaiming their rows, edges (cascade-deleted by the schema), and `nodes/<id>/` dirs. Run it as an operator/cron chore; live nodes (active/idle) are never touched. Pass `--dry-run` first to see exactly what would go, `--ttl <days>` to widen or tighten the window',
  help: {
    name: 'canvas prune',
    summary: 'delete terminal nodes older than a TTL (edges cascade, dirs removed); --dry-run to preview',
    params: [
      {
        kind: 'flag',
        name: 'ttl',
        type: 'int',
        required: false,
        default: DEFAULT_TTL_DAYS,
        constraint: `Retention window in days: only dead/done/canceled nodes created more than this many days ago are pruned. Default: ${DEFAULT_TTL_DAYS}.`,
      },
      {
        kind: 'flag',
        name: 'include-stale',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'ALSO prune stale active/idle nodes past the TTL whose process is gone (pi_pid null or dead) — reaps abandoned roots the daemon never reconciled. A genuinely-running node (live pi_pid) and the caller are protected.',
      },
      {
        kind: 'flag',
        name: 'dry-run',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'Report what WOULD be pruned without deleting anything.',
      },
    ],
    output: [
      { name: 'pruned', type: 'integer', required: true, constraint: 'How many nodes were pruned (0 under --dry-run since nothing is deleted; the candidate count is in `nodes`).' },
      { name: 'dryRun', type: 'boolean', required: true, constraint: 'True when nothing was deleted (preview only).' },
      { name: 'ttlDays', type: 'integer', required: true, constraint: 'The retention window used.' },
      { name: 'nodes', type: 'object[]', required: true, constraint: 'One per pruned (or, under --dry-run, prunable) node: {node_id,status,created}.' },
    ],
    outputKind: 'object',
    effects: [
      'Deletes matching `nodes` rows; their edges cascade-delete via the FK; each node\u2019s `nodes/<id>/` dir is removed.',
      'No-op on live nodes (active/idle) and on terminal nodes newer than the TTL. With --include-stale: also deletes active/idle nodes past the TTL whose process is gone (pi_pid null/dead); genuinely-running nodes and the caller are kept.',
      'Under --dry-run: read-only, deletes nothing.',
    ],
  },
  run: async (input) => {
    const ttlDays = (input['ttl'] as number | undefined) ?? DEFAULT_TTL_DAYS;
    const dryRun = (input['dryRun'] as boolean | undefined) ?? false;
    const includeStale = (input['includeStale'] as boolean | undefined) ?? false;

    const result = pruneNodes({ ttlDays, dryRun, includeStale });
    return {
      pruned: dryRun ? 0 : result.pruned.length,
      dryRun,
      ttlDays,
      nodes: result.pruned.map((p) => ({
        node_id: p.node_id,
        status: p.status,
        created: p.created,
      })),
    };
  },
});
