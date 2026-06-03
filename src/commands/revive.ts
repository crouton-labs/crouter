// `crtr revive` — explicit node revival.
//
// Bypasses the daemon: directly opens a fresh tmux window for a node that is
// done, idle, or dead. Default behavior resumes the saved pi conversation
// (--resume); pass --fresh to start a clean pi session against the context dir.

import { defineLeaf, defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { reviveNode } from '../core/runtime/revive.js';
import { getNode } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// revive node
// ---------------------------------------------------------------------------

const reviveNodeLeaf = defineLeaf({
  name: 'node',
  help: {
    name: 'revive node',
    summary: 'open a fresh tmux window for a node, optionally resuming its saved pi conversation',
    params: [
      {
        kind: 'positional',
        name: 'node',
        required: true,
        constraint: 'Node id to revive.',
      },
      {
        kind: 'flag',
        name: 'fresh',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'When set, start a clean pi session (no --resume). Default: resume the saved conversation.',
      },
    ],
    output: [
      { name: 'window', type: 'string', required: false, constraint: 'New tmux window id.' },
      { name: 'session', type: 'string', required: true, constraint: 'Tmux session the node was placed in.' },
      { name: 'resumed', type: 'boolean', required: true, constraint: 'True when pi was told to --resume the saved conversation.' },
    ],
    outputKind: 'object',
    effects: [
      'Opens a background (non-focus-stealing) tmux window running pi.',
      'Updates the node\'s canvas record: status=active, intent=null, window=<new>.',
    ],
  },
  run: async (input) => {
    const nodeId = input['node'] as string;
    const fresh = (input['fresh'] as boolean | undefined) ?? false;

    // Validate the node exists before attempting revival.
    const meta = getNode(nodeId);
    if (meta === null) {
      throw new InputError({
        error: 'not_found',
        message: `no node: ${nodeId}`,
        next: 'List nodes with `crtr node list`.',
      });
    }

    const result = reviveNode(nodeId, { resume: !fresh });
    return {
      window: result.window ?? undefined,
      session: result.session,
      resumed: result.resumed,
    };
  },
});

// ---------------------------------------------------------------------------
// registerRevive
// ---------------------------------------------------------------------------

export function registerRevive(): BranchDef {
  return defineBranch({
    name: 'revive',
    rootEntry: {
      concept: 'explicit revive for a canvas node — opens a fresh window, optionally resuming its conversation',
      desc: 'bring a done/idle/dead node back as an active window',
      useWhen: 'waking a node that has finished or crashed',
    },
    help: {
      name: 'revive',
      summary: 'open a fresh tmux window for a canvas node',
      model:
        'Explicit revival: opens a new background window and runs pi for the named node. Default: resumes the saved pi conversation (--resume). Pass --fresh to start clean (node re-reads its roadmap/context dir). The daemon does this automatically for crashed or refresh-yield nodes; this command is for manual or test use.',
      children: [
        { name: 'node', desc: 'revive a specific node by id', useWhen: 'manually waking a done, idle, or dead node' },
      ],
    },
    children: [reviveNodeLeaf],
  });
}
