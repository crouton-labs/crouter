// `crtr canvas revive` — explicit node revival.
//
// Bypasses the daemon: directly opens a fresh tmux window for a node that is
// done, idle, or dead. Default behavior resumes the saved pi conversation
// (--session <id>); pass --fresh to start a clean pi session against the context dir.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { reviveNode } from '../core/runtime/revive.js';
import { getNode } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// revive node
// ---------------------------------------------------------------------------

export const reviveLeaf: LeafDef = defineLeaf({
  name: 'revive',
  description: 'reopen a window for a done/idle/dead/canceled node',
  whenToUse: 'you want to bring a dormant node back yourself — reopen a window for one that is done, idle, dead, or canceled: resume a node you closed with `node close`, reopen a finished worker for a follow-up, or restart a crashed one now instead of waiting. It resumes the saved conversation by default, or can restart the node clean. You rarely need this for crashes — the daemon auto-revives those; reach for it to bring a node back on demand, or to revive a canceled node the daemon will never touch on its own',
  help: {
    name: 'canvas revive',
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
        constraint: 'When set, start a clean pi session (no --session). Default: resume the saved conversation.',
      },
    ],
    output: [
      { name: 'window', type: 'string', required: false, constraint: 'New tmux window id.' },
      { name: 'session', type: 'string', required: true, constraint: 'Tmux session the node was placed in.' },
      { name: 'resumed', type: 'boolean', required: true, constraint: 'True when pi was told to --session the saved conversation.' },
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
        next: 'List nodes with `crtr node inspect list`.',
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


