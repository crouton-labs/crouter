// `crtr canvas attention` — aggregate pending human asks across the canvas.
//
// Pending asks are stored per-cwd by humanloop. This subtree surfaces two
// views:
//   count  — a single integer (stdout.count is parsed by nav chrome)
//   list   — itemised entries with cwd, node id, and per-cwd ask count
//
// All three scope modes share the same underlying helpers in attention.ts:
//   --node <id>   → countAsks(id)             (one cwd)
//   --view <id>   → pendingAsksForView(id)     (sub-DAG from root)
//   (neither)     → asksAcrossCanvas()         (whole canvas)
//
// Exported as a branch; `crtr canvas` (canvas.ts) mounts it.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode, view } from '../core/canvas/index.js';
import {
  countAsks,
  pendingAsksForView,
  asksAcrossCanvas,
  asksForNodes,
} from '../core/canvas/attention.js';

// ---------------------------------------------------------------------------
// attention count
// ---------------------------------------------------------------------------

const attentionCount = defineLeaf({
  name: 'count',
  description: 'total pending ask count (machine-parseable stdout.count)',
  whenToUse: 'getting a single pending-ask count for a script or nav chrome to read (stdout.count is machine-parseable); scope with --node or --view, or default to canvas-wide',
  help: {
    name: 'canvas attention count',
    // stdout.count is parsed directly by the nav chrome — keep the contract.
    summary: 'return the number of pending human asks; stdout.count is machine-parseable',
    params: [
      {
        kind: 'flag',
        name: 'node',
        type: 'string',
        required: false,
        constraint: 'Count asks only for this node\'s cwd. Mutually exclusive with --view.',
      },
      {
        kind: 'flag',
        name: 'view',
        type: 'string',
        required: false,
        constraint: 'Sum asks for all nodes in the sub-DAG rooted at this id. Mutually exclusive with --node.',
      },
    ],
    output: [
      { name: 'count', type: 'integer', required: true, constraint: 'Total pending asks in the requested scope.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: scans humanloop interaction dirs.'],
  },
  run: async (input) => {
    const nodeId = input['node'] as string | undefined;
    const viewId = input['view'] as string | undefined;

    if (nodeId !== undefined && viewId !== undefined) {
      throw new InputError({
        error: 'ambiguous_scope',
        message: '--node and --view are mutually exclusive',
        next: 'Use one of --node <id>, --view <id>, or neither (canvas-wide).',
      });
    }

    if (nodeId !== undefined) {
      // Validate node exists.
      if (getNode(nodeId) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${nodeId}`,
          next: 'List nodes with `crtr node inspect list`.',
        });
      }
      return { count: countAsks(nodeId) };
    }

    if (viewId !== undefined) {
      if (getNode(viewId) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${viewId}`,
          next: 'List nodes with `crtr node inspect list`.',
        });
      }
      const items = pendingAsksForView(viewId);
      const total = items.reduce((s, e) => s + e.count, 0);
      return { count: total };
    }

    // Canvas-wide.
    const items = asksAcrossCanvas();
    const total = items.reduce((s, e) => s + e.count, 0);
    return { count: total };
  },
});

// ---------------------------------------------------------------------------
// attention list
// ---------------------------------------------------------------------------

const attentionList = defineLeaf({
  name: 'list',
  description: 'itemised list of cwds with pending asks',
  whenToUse: 'finding which agents are blocked waiting on a human — an itemised list of the cwds with pending asks, oldest first, so you know where to go answer. Scope to a sub-DAG with --view or list canvas-wide. Use `canvas attention count` instead when a script just needs the number, or `canvas attention map` for per-node counts to label a UI',
  help: {
    name: 'canvas attention list',
    summary: 'list nodes with pending human asks, grouped by cwd, oldest first',
    params: [
      {
        kind: 'flag',
        name: 'view',
        type: 'string',
        required: false,
        constraint: 'Scope the list to the sub-DAG rooted at this node id. Omit for canvas-wide.',
      },
    ],
    output: [
      {
        name: 'items',
        type: 'object[]',
        required: true,
        constraint: 'Each: {node_id, name, cwd, count}. One entry per distinct cwd with count > 0.',
      },
      { name: 'total', type: 'integer', required: true, constraint: 'Sum of counts across all entries.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: scans humanloop interaction dirs.'],
  },
  run: async (input) => {
    const viewId = input['view'] as string | undefined;

    let items;
    if (viewId !== undefined) {
      if (getNode(viewId) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${viewId}`,
          next: 'List nodes with `crtr node inspect list`.',
        });
      }
      items = pendingAsksForView(viewId);
    } else {
      items = asksAcrossCanvas();
    }

    const total = items.reduce((s, e) => s + e.count, 0);
    return { items, total };
  },
});

// ---------------------------------------------------------------------------
// attention map
// ---------------------------------------------------------------------------

const attentionMap = defineLeaf({
  name: 'map',
  description: 'per-node ask counts for a visible set, batched in one pass',
  whenToUse: 'labelling every node in a UI with its pending-ask count in one batched pass — the form nav chrome polls (one process, one JSON blob) instead of N count shell-outs',
  help: {
    name: 'canvas attention map',
    summary:
      'per-node pending-ask counts for a visible set of nodes in ONE pass — the batched form the nav chrome polls (one process, one JSON blob) instead of N count shell-outs',
    params: [
      {
        kind: 'flag',
        name: 'view',
        type: 'string',
        required: false,
        constraint:
          'Include this node and its whole sub-DAG (root + reports recursively). Union with --nodes. At least one of --view/--nodes is required.',
      },
      {
        kind: 'flag',
        name: 'nodes',
        type: 'string',
        required: false,
        constraint:
          'Comma-separated explicit node ids to include (e.g. ancestry + peers). Union with --view.',
      },
    ],
    output: [
      {
        name: 'counts',
        type: 'object',
        required: true,
        constraint: 'Map of node_id → pending ask count. Every requested id is present (0 when none).',
      },
    ],
    outputKind: 'object',
    effects: ['Read-only: scans each distinct cwd\'s humanloop interaction dir once.'],
  },
  run: async (input) => {
    const viewId = input['view'] as string | undefined;
    const nodesRaw = input['nodes'] as string | undefined;

    if (viewId === undefined && (nodesRaw === undefined || nodesRaw.trim() === '')) {
      throw new InputError({
        error: 'missing_scope',
        message: 'at least one of --view <id> or --nodes <a,b,c> is required',
        next: 'Pass --view <root> to cover a sub-DAG, --nodes <a,b,c> for an explicit set, or both.',
      });
    }

    const ids = new Set<string>();
    if (viewId !== undefined) {
      if (getNode(viewId) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${viewId}`,
          next: 'List nodes with `crtr node inspect list`.',
        });
      }
      ids.add(viewId);
      for (const id of view(viewId)) ids.add(id);
    }
    if (nodesRaw !== undefined) {
      for (const id of nodesRaw.split(',').map((s) => s.trim()).filter((s) => s !== '')) ids.add(id);
    }

    return { counts: asksForNodes([...ids]) };
  },
});

// ---------------------------------------------------------------------------
// Export — mounted under `crtr canvas`
// ---------------------------------------------------------------------------

export const attentionBranch: BranchDef = defineBranch({
    name: 'attention',
    description: 'count/list pending human asks across the graph',
    whenToUse: 'checking whether any agent on the canvas is blocked waiting on a human, and where: count the pending asks, list the cwds that have them, or map per-node counts. Scope with --node or --view, or go canvas-wide. Use `canvas dashboard` instead for the graph SHAPE, or `node inspect list` for a plain node roster',
    help: {
      name: 'canvas attention',
      summary: 'aggregate pending human asks across the canvas',
      model:
        'Human asks are stored per-cwd by humanloop. `count` returns a single integer (stdout.count is parsed by nav chrome); `list` returns itemised entries. Scope with --node (one node) or --view (sub-DAG) — default is canvas-wide.',
    },
    children: [attentionCount, attentionList, attentionMap],
});
