// `crtr canvas browse` — the interactive full-screen canvas navigator.
//
// A raw-mode TUI over the WHOLE canvas: tabs (All/Live/Dormant/Flagged), an
// auto-collapsed tree, and `/` fuzzy search. Enter resumes the chosen node via
// `crtr node focus` (the ONLY sanctioned open — reviveNode, never `pi --session`).
// Owns the screen, so it returns void and writes nothing to stdout itself.
// Outside a TTY it prints the static forest and exits 0 (see runBrowse).

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { runBrowse } from '../core/canvas/browse/app.js';

export const browseLeaf: LeafDef = defineLeaf({
  name: 'browse',
  description: 'open the interactive canvas navigator (tabs/tree/search)',
  whenToUse: 'you want to VIEW and NAVIGATE the whole canvas interactively — a full-screen TUI with tabs (All/Live/Dormant/Flagged), an expandable tree (children auto-collapsed; → to expand), and `/` fuzzy search that auto-expands ancestors of matches; Enter resumes the chosen node. Use this to find your way around a large canvas. Use `canvas dashboard` instead for a one-shot ASCII tree you can pipe, and `node inspect list` for a flat machine-readable roster',
  help: {
    name: 'canvas browse',
    summary: 'interactive full-screen canvas navigator — tabs, an auto-collapsed tree, and `/` fuzzy search; Enter resumes the chosen node via `crtr node focus`. Outside a TTY it prints the static forest and exits',
    params: [
      {
        kind: 'flag',
        name: 'return-pane',
        type: 'string',
        required: false,
        constraint: 'tmux pane id to focus the chosen node INTO (set by the /resume-node popup so the node lands back in your pi pane). Default: this pane.',
      },
    ],
    output: [],
    outputKind: 'object',
    effects: [
      'Takes over the terminal in raw mode (alt-screen) until you quit (q/Esc) or pick a node.',
      'On Enter: resumes the selected node via `crtr node focus` (reviveNode — the only sanctioned open).',
      'Read-only on the canvas db; mutates nothing but the chosen node\'s placement on resume.',
    ],
  },
  run: async (input) => {
    await runBrowse({ returnPane: input['returnPane'] as string | undefined });
  },
});
