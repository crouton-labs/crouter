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
import { browseLeaf } from './canvas-browse.js';
import { reviveLeaf } from './revive.js';
import { attentionBranch } from './attention.js';
import { daemonBranch } from './daemon.js';
import { chordLeaf } from './chord.js';
import { canvasPruneLeaf } from './canvas-prune.js';
import { historyBranch } from './canvas-history.js';

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
        'Canvas-wide operations, distinct from per-node work (`node`) and a node\'s own spine I/O (`push`/`feed`). `dashboard` renders the subscription forest as a tree; `browse` opens an interactive full-screen navigator (tabs/tree/search) over the whole canvas and resumes the chosen node; `attention` aggregates pending human asks across the graph; `revive` reopens a window for a done/idle/dead/canceled node; `history` searches and recalls the content record (reports + context docs) of past work in a cwd; `daemon` manages the thin crtrd supervisor that auto-revives nodes on window exit; `prune` bounds growth by deleting terminal nodes past a TTL.',
    },
    children: [dashboardLeaf, browseLeaf, attentionBranch, reviveLeaf, historyBranch, daemonBranch, chordLeaf, canvasPruneLeaf],
  });
}
