// `crtr attention` — aggregate pending human asks across the canvas.
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
// Shape mirrors registerNode(): export registerAttention(): BranchDef.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode } from '../core/canvas/index.js';
import {
  countAsks,
  pendingAsksForView,
  asksAcrossCanvas,
} from '../core/canvas/attention.js';

// ---------------------------------------------------------------------------
// attention count
// ---------------------------------------------------------------------------

const attentionCount = defineLeaf({
  name: 'count',
  help: {
    name: 'attention count',
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
          next: 'List nodes with `crtr node list`.',
        });
      }
      return { count: countAsks(nodeId) };
    }

    if (viewId !== undefined) {
      if (getNode(viewId) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${viewId}`,
          next: 'List nodes with `crtr node list`.',
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
  help: {
    name: 'attention list',
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
          next: 'List nodes with `crtr node list`.',
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
// Export
// ---------------------------------------------------------------------------

export function registerAttention(): BranchDef {
  return defineBranch({
    name: 'attention',
    rootEntry: {
      concept: 'pending human "asks" aggregated across the nodes in a view',
      desc: 'count and list pending human asks across the canvas or a node sub-DAG',
      useWhen: 'checking whether any agent is blocked waiting for a human decision',
    },
    help: {
      name: 'attention',
      summary: 'aggregate pending human asks across the canvas',
      model:
        'Human asks are stored per-cwd by humanloop. `count` returns a single integer (stdout.count is parsed by nav chrome); `list` returns itemised entries. Scope with --node (one node) or --view (sub-DAG) — default is canvas-wide.',
      children: [
        { name: 'count', desc: 'total pending ask count (machine-parseable stdout.count)', useWhen: 'polling from a script or nav chrome' },
        { name: 'list', desc: 'itemised list of cwds with pending asks', useWhen: 'finding which agents need a human response' },
      ],
    },
    children: [attentionCount, attentionList],
  });
}
