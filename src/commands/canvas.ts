// `crtr canvas` — observe and supervise the whole graph.
//
// Where `node` operates on one node and `push`/`feed` are a node's own spine
// I/O, `canvas` is the bird's-eye / supervisor surface over the entire canvas:
// render the subscription forest (`dashboard`), see who is blocked on a human
// (`attention`), bring a node back (`revive`), and manage the supervisor
// process (`daemon`). It assembles leaves/branches the sibling command files
// own, so each piece declares its own help one level down.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { dashboardLeaf } from './dashboard.js';
import { reviveLeaf } from './revive.js';
import { attentionBranch } from './attention.js';
import { daemonBranch } from './daemon.js';

export function registerCanvas(): BranchDef {
  return defineBranch({
    name: 'canvas',
    rootEntry: {
      concept: 'the whole agent graph at a glance — render it, see who is blocked, revive a node, supervise the daemon',
      desc: 'bird\'s-eye view and supervision of the entire canvas',
      useWhen: 'surveying the full graph, finding blocked agents, or managing revival/the daemon',
    },
    help: {
      name: 'canvas',
      summary: 'observe and supervise the whole agent graph',
      model:
        'Canvas-wide operations, distinct from per-node work (`node`) and a node\'s own spine I/O (`push`/`feed`). `dashboard` renders the subscription forest as a tree; `attention` aggregates pending human asks across the graph; `revive` reopens a window for a done/idle/dead node; `daemon` manages the thin crtrd supervisor that auto-revives nodes on window exit.',
      children: [
        { name: 'dashboard', desc: 'render the canvas as a subscription tree', useWhen: 'inspecting the whole graph at a glance' },
        { name: 'attention', desc: 'count/list pending human asks across the graph', useWhen: 'checking whether any agent is blocked on a human' },
        { name: 'revive', desc: 'reopen a window for a done/idle/dead node', useWhen: 'manually waking a node (the daemon does this automatically)' },
        { name: 'daemon', desc: 'manage the crtrd supervisor process', useWhen: 'starting, checking, or stopping background supervision' },
      ],
    },
    children: [dashboardLeaf, attentionBranch, reviveLeaf, daemonBranch],
  });
}
