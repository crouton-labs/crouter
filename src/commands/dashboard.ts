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
import { renderTree, renderForest, dashboardRows, dashboardRowsAll } from '../core/canvas/render.js';

// ---------------------------------------------------------------------------
// dashboard show — the main leaf
// ---------------------------------------------------------------------------

export const dashboardLeaf: LeafDef = defineLeaf({
  name: 'dashboard',
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
    const rows = dashboardRowsAll();
    return {
      tree: renderForest(),
      nodes: allNodes.length,
      rows,
    };
  },
});


