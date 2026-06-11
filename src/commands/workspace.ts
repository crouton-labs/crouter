// workspace.ts — `crtr workspace enter`: the agent-centric editor layout.
//
// Turns the current tmux window into an editor view for attached headless nodes:
// a narrow LEFT rail (the `workspace-sidebar` view — this graph + other live
// agents in this cwd, with ⚑ inbox flags) beside a CHAT pane (`crtr attach`).
// Selecting a node in the rail swaps it into the chat pane.
//
// Layout build (the only two driver acts, both through placement's seam):
//   1. splitWindow(here, before+size) → the rail pane, left of here, runs
//      `crtr view run workspace-sidebar`.
//   2. `crtr node focus <node> --pane <here>` → swaps the chat node's attach
//      viewer into here's slot (here's old content relocates to the backstage).
// The rail finds the chat pane by DISCOVERY (the `@crtr_node` tag attach sets),
// so it is robust to that swap — no launch-time pane id is threaded into it.
//
// Command shape: the path-walker forbids a flat top-level leaf (same constraint
// as attach), so this is a BRANCH wrapping one leaf: `crtr workspace enter`.

import { execFile } from 'node:child_process';
import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef, LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode, listNodes } from '../core/canvas/index.js';
import { inTmux, currentTmux, splitWindow, piCommand } from '../core/runtime/placement.js';

const RAIL_WIDTH = 32;

/** Newest LIVE (active|idle) forest root started in `cwd` — the default node the
 *  chat pane attaches to when `--node` is omitted. A root has no parent inside
 *  the cwd-scoped set. Returns null when this cwd has no live root. */
function defaultChatNode(cwd: string): string | null {
  const rows = listNodes({ status: ['active', 'idle'] }).filter((r) => r.cwd === cwd);
  if (rows.length === 0) return null;
  const ids = new Set(rows.map((r) => r.node_id));
  const roots = rows.filter((r) => r.parent === null || !ids.has(r.parent));
  const pool = roots.length > 0 ? roots : rows;
  pool.sort((a, b) => (a.created < b.created ? 1 : -1)); // newest first
  return pool[0]!.node_id;
}

const workspaceEnterLeaf: LeafDef = defineLeaf({
  name: 'enter',
  description: 'enter the editor view — a node rail beside a chat pane, in this window',
  whenToUse:
    'you want to work in the agent-centric editor layout: a left rail listing this graph + the other live agents in this working directory (with ⚑ inbox flags) beside a chat pane attached to a node. Selecting a node in the rail swaps it into the chat pane. Opens in the CURRENT tmux window. tmux-only.',
  help: {
    name: 'workspace enter',
    summary:
      'split the current window into a left node-rail (the workspace-sidebar view) + a chat pane (crtr attach); ↵ in the rail swaps a node into the chat. tmux-only.',
    params: [
      {
        kind: 'flag',
        name: 'node',
        type: 'string',
        required: false,
        constraint:
          'Node to attach in the chat pane. Default: the newest live root in this cwd (rail-only, empty chat, if none).',
      },
      {
        kind: 'flag',
        name: 'width',
        type: 'int',
        required: false,
        default: RAIL_WIDTH,
        constraint: `Rail width in columns (default ${RAIL_WIDTH}).`,
      },
    ],
    output: [
      { name: 'rail', type: 'string', required: false, constraint: 'tmux pane id of the rail.' },
      { name: 'chat', type: 'string', required: false, constraint: 'node id attached in the chat pane (absent if none).' },
      { name: 'note', type: 'string', required: false, constraint: 'Set only on the non-TTY/piped path.' },
    ],
    outputKind: 'object',
    effects: [
      'Splits a narrow LEFT pane in the current window running the workspace-sidebar view.',
      'Swaps the chosen (or default) node into the current pane as a chat (crtr node focus), relocating the current pane to the backstage.',
      'Outside a TTY/tmux: prints a notice and exits 0 (no layout change).',
    ],
  },
  run: async (input) => {
    const node = input['node'] as string | undefined;
    const width = (input['width'] as number | undefined) ?? RAIL_WIDTH;

    if (!process.stdout.isTTY) {
      return { note: 'crtr workspace enter builds a tmux layout — run it in a tmux pane (a TTY), not a pipe.' };
    }
    if (!inTmux()) {
      throw new InputError({
        error: 'not_in_tmux',
        message: 'crtr workspace is tmux-only — run it inside the crtr tmux session',
        next: 'Open it from inside tmux.',
      });
    }
    const here = currentTmux();
    if (here === null) {
      throw new InputError({
        error: 'no_tmux_location',
        message: 'could not resolve the current tmux pane',
        next: 'Run this inside a tmux pane.',
      });
    }

    // Resolve the chat node (explicit --node, else newest live root here).
    let chatNode: string | null = null;
    if (node !== undefined && node !== '') {
      if (getNode(node) === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node: ${node}`,
          received: node,
          next: 'List nodes with `crtr node inspect list`.',
        });
      }
      chatNode = node;
    } else {
      chatNode = defaultChatNode(process.cwd());
    }

    // 1. The rail — a narrow split to the LEFT of here. It discovers the chat
    //    pane itself (the @crtr_node tag), so no pane id is threaded in.
    const railCmd = piCommand(['view', 'run', 'workspace-sidebar', '--target', here.pane], 'crtr');
    const rail = splitWindow(here.pane, {
      cwd: process.cwd(),
      env: {},
      command: railCmd,
      before: true,
      size: Math.max(16, width),
    });
    if (rail === null) {
      throw new InputError({
        error: 'split_failed',
        message: 'tmux could not split the rail pane',
        next: 'Check the tmux server is reachable, then retry.',
      });
    }

    // 2. The chat — swap the node's attach viewer into here's slot. Best-effort:
    //    the rail is already up, so a focus failure degrades to a rail-only view
    //    the user can drive (↵ a node) rather than aborting the whole layout.
    if (chatNode !== null) {
      await new Promise<void>((resolve) => {
        execFile('crtr', ['node', 'focus', chatNode!, '--pane', here.pane], () => resolve());
      });
    }

    return chatNode !== null ? { rail, chat: chatNode } : { rail };
  },
  render: (result) => {
    if (result['note'] !== undefined) return String(result['note']);
    const chat = result['chat'];
    return chat !== undefined
      ? `Workspace ready — rail ${result['rail']}, chat attached to ${chat}.`
      : `Workspace ready — rail ${result['rail']}. No live agent here yet; press ↵ on a node in the rail to open one.`;
  },
});

export function registerWorkspace(): BranchDef {
  return defineBranch({
    name: 'workspace',
    rootEntry: {
      concept: 'the agent-centric editor view — a node rail beside a chat pane, in one tmux window',
      desc: 'enter the editor layout for attached headless nodes',
      useWhen:
        'you want an editor-style workspace in tmux: a left rail of this graph + other live agents in this cwd (with ⚑ inbox flags) next to a chat pane attached to a node, where selecting a node in the rail swaps it into the chat. tmux-only.',
    },
    help: {
      name: 'workspace',
      summary: 'enter the agent-centric editor view (node rail + chat pane) in the current tmux window',
      model:
        '`enter` splits the current window into a narrow left rail (the workspace-sidebar view — this graph + other live agents in this cwd, ⚑ inbox flags) and a chat pane (`crtr attach`) attached to a node (--node, or the newest live root here). ↵ in the rail swaps the selected node into the chat pane. tmux-only; piped it prints a notice and exits 0.',
    },
    children: [workspaceEnterLeaf],
  });
}
