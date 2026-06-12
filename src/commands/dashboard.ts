// `crtr canvas dashboard` — canvas-wide visibility surface.
//
// Renders the subscription sub-DAG as an ASCII tree, optionally scoped to a
// single root.  A human operator pastes the output into a terminal or pipes it
// to a renderer; a machine consumer reads the structured `rows` array.
//
// Exported as a leaf; `crtr canvas` (canvas.ts) mounts it.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode, listNodes } from '../core/canvas/index.js';
import { renderTree, renderForest, dashboardRows, dashboardRowsAll, enrichRows } from '../core/canvas/render.js';

// ---------------------------------------------------------------------------
// dashboard show — the main leaf
// ---------------------------------------------------------------------------

export const dashboardLeaf: LeafDef = defineLeaf({
  name: 'dashboard',
  description: 'render the canvas as a subscription tree',
  whenToUse: 'you want the whole graph at a glance as a rendered tree — the subscription forest drawn in ASCII so you can read its SHAPE: who reports to whom, how deep each branch runs, plus each node\'s status and context size. Scope to one root or show the full forest. Use `node inspect list` instead for a flat roster without the tree, `node inspect show` to drill into one node\'s neighbors, and `canvas attention` to find which nodes are blocked on a human',
  help: {
    name: 'canvas dashboard',
    summary: 'render the canvas as an ASCII subscription tree — scoped to a root or the full forest',
    params: [
      {
        kind: 'flag',
        name: 'root',
        type: 'string',
        required: false,
        constraint: 'Node id to use as the tree root. Omit for the full forest (all canvas roots).',
      },
    ],
    output: [
      { name: 'tree', type: 'string', required: true, constraint: 'Multi-line ASCII tree.' },
      { name: 'nodes', type: 'integer', required: true, constraint: 'Total node count in this view.' },
      { name: 'rows', type: 'object[]', required: true, constraint: 'One per node: {node_id,name,status,kind,mode,ctx_tokens,asks}.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: queries canvas.db and node telemetry files.'],
  },
  run: async (input) => {
    const rootId = input['root'] as string | undefined;

    if (rootId !== undefined) {
      // Scoped to a single root — validate the node exists.
      const node = getNode(rootId);
      if (node === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${rootId}`,
          next: 'List nodes with `crtr node inspect list` to find a valid id.',
        });
      }
      const rows = dashboardRows(rootId);
      return {
        tree: renderTree(rootId),
        nodes: rows.length,
        rows,
      };
    }

    // Full forest: all nodes on the canvas.
    const allNodes = listNodes();
    // dashboardRowsAll is the cheap-boot builder: ctx_tokens/asks are 0 and `name`
    // is the handle only until enriched. The JSON consumer wants the real values,
    // so fold the deferred fields in before emitting (the rendered TREE is unaffected).
    const rows = dashboardRowsAll();
    enrichRows(rows);
    return {
      tree: renderForest(),
      nodes: allNodes.length,
      rows,
    };
  },
});


