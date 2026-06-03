// `crtr dashboard` — canvas-wide visibility surface.
//
// Renders the subscription sub-DAG as an ASCII tree, optionally scoped to a
// single root.  A human operator pastes the output into a terminal or pipes it
// to a renderer; a machine consumer reads the structured `rows` array.
//
// Shape mirrors registerNode(): export registerDashboard(): BranchDef.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode, listNodes } from '../core/canvas/index.js';
import { renderTree, renderForest, dashboardRows, dashboardRowsAll } from '../core/canvas/render.js';

// ---------------------------------------------------------------------------
// dashboard show — the main leaf
// ---------------------------------------------------------------------------

const dashboardShow = defineLeaf({
  name: 'show',
  help: {
    name: 'dashboard show',
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
          next: 'List nodes with `crtr node list` to find a valid id.',
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerDashboard(): BranchDef {
  return defineBranch({
    name: 'dashboard',
    rootEntry: {
      concept: 'a rendered view of the canvas subscription sub-DAG rooted at a node',
      desc: 'render the live canvas as an ASCII tree with status, context size, and pending asks',
      useWhen: 'surveying the canvas at a glance or feeding structured node state to a renderer',
    },
    help: {
      name: 'dashboard',
      summary: 'render the canvas subscription tree',
      model:
        'The dashboard walks the `subscribes_to` edges downward from a root (or from all roots) and renders each node as one line: status glyph, name, kind/mode, context token count, and a pending-asks flag (⚑N) when there are unresolved human asks. The `rows` array carries the same data in machine-readable form.',
      children: [
        { name: 'show', desc: 'render the canvas tree (full forest or scoped to --root)', useWhen: 'inspecting the canvas at a glance' },
      ],
    },
    children: [dashboardShow],
  });
}
