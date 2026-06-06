// `crtr canvas tmux-spread <id>` — expand a node + its live children into one
// tiled tmux window: the target wide in the LEFT (main) pane, its live children
// stacked as panes on the RIGHT, then grab focus.
//
// Reuses the presence/tmux machinery: revive a dormant target/child so it has a
// live pane, `join-pane` each child's existing pane into the target's window
// (preserving its running pi), `select-layout main-vertical`, then focus.
//
// CRITICAL fix-up: a joined child physically changes windows, so its
// meta.{tmux_session,window} goes stale — `windowAlive` would then report it
// dormant and the daemon would spuriously revive it. After each join we
// re-derive the child's location from its (stable) pane id and updateNode it,
// mirroring the swap fix-up in placement.ts.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { readConfig } from '../core/config.js';
import { reviveNode } from '../core/runtime/revive.js';
import { isNodePaneAlive, spreadNode, inTmux } from '../core/runtime/placement.js';
import { nodeInPane } from './node.js';
import { getNode, subscriptionsOf } from '../core/canvas/index.js';

export const tmuxSpreadLeaf: LeafDef = defineLeaf({
  name: 'tmux-spread',
  description: 'tile a node + its live children into one window and focus it',
  whenToUse: 'tiling a node and its live children into one window — the node wide on the left, its workers stacked on the right — to watch an orchestrator and its team together (alt+c → e / GRAPH e)',
  help: {
    name: 'canvas tmux-spread',
    summary:
      'tile a node and its live children into one window — target wide on the left, children stacked on the right — and focus it. Revives dormant nodes first; caps children by max_panes_per_window.',
    params: [
      {
        kind: 'positional',
        name: 'node',
        required: false,
        constraint: 'Node id to spread. Defaults to the node occupying --pane (or your current pane).',
      },
      {
        kind: 'flag',
        name: 'pane',
        type: 'string',
        required: false,
        constraint: 'tmux pane id to resolve the node from when no positional is given. The alt+c menu passes this for you.',
      },
    ],
    output: [
      { name: 'window', type: 'string', required: false, constraint: 'The window all panes were tiled into.' },
      { name: 'session', type: 'string', required: false, constraint: 'The tmux session that window lives in.' },
      { name: 'children_joined', type: 'string[]', required: true, constraint: 'Child node ids whose panes were joined into the window.' },
      { name: 'overflow', type: 'string[]', required: true, constraint: 'Live children left out because max_panes_per_window was reached.' },
      { name: 'focused', type: 'boolean', required: true, constraint: 'True when the window was brought forefront.' },
    ],
    outputKind: 'object',
    effects: [
      'Revives the target (and joined children) if dormant — opens tmux windows running pi.',
      'Moves each joined child\'s pane into the target window (join-pane) and re-points its canvas record to the new window.',
      'Applies a main-vertical layout and focuses the window.',
    ],
  },
  run: async (input) => {
    if (!inTmux()) {
      throw new InputError({
        error: 'not_in_tmux',
        message: 'tmux-spread needs a tmux server (no $TMUX)',
        next: 'Run from inside the shared crtr tmux session.',
      });
    }

    const pane = input['pane'] as string | undefined;
    let id = input['node'] as string | undefined;
    if (id === undefined || id === '') id = nodeInPane(pane);
    if (id === undefined || id === '') {
      throw new InputError({
        error: 'no_node',
        message: 'no node to spread (pass a node id, or run from inside its pane)',
        next: 'Pass `crtr canvas tmux-spread <id>` or --pane <pane-id>.',
      });
    }
    if (getNode(id) === null) {
      throw new InputError({
        error: 'not_found',
        message: `no node: ${id}`,
        next: 'List nodes with `crtr node inspect list`.',
      });
    }

    // 1. Revive the target if it has no live pane (placement is pane-keyed).
    if (!isNodePaneAlive(id)) {
      try { reviveNode(id, { resume: true }); } catch { /* fall through */ }
    }
    if (!isNodePaneAlive(id)) {
      throw new InputError({
        error: 'no_window',
        message: `could not open a live window for ${id}`,
        next: 'Try `crtr canvas revive <id>` then retry.',
      });
    }

    // 2. Live children, capped: the target owns one pane, so up to max-1 join.
    const max = readConfig('user').max_panes_per_window;
    const budget = Math.max(0, max - 1);
    const liveChildren = subscriptionsOf(id)
      .map((r) => r.node_id)
      .filter((cid) => {
        const s = getNode(cid)?.status;
        return s === 'active' || s === 'idle';
      });
    const selected = liveChildren.slice(0, budget);
    const overflow = liveChildren.slice(budget);

    // 3. Revive any dormant selected child so it has a live pane, then hand the
    //    join + pane-fix-up (reconcile FOLLOWS each joined pane) + layout + focus
    //    to placement.
    for (const cid of selected) {
      if (!isNodePaneAlive(cid)) {
        try { reviveNode(cid, { resume: true }); } catch { /* skip on failure */ }
      }
    }
    const spread = spreadNode(id, selected);

    return {
      window: spread.window,
      session: spread.session,
      children_joined: spread.joined,
      overflow,
      focused: spread.focused,
    };
  },
  render: (r) =>
    `<spread node window="${r['window'] ?? ''}" joined="${(r['children_joined'] as string[]).length}" overflow="${(r['overflow'] as string[]).length}" focused="${r['focused']}"/>`,
});
