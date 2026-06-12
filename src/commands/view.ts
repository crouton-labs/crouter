// `crtr view` — the TUI view library.
//
// Views are switchable surfaces with two targets from one portable core.mjs:
// the tmux TUI (`run`) and a React+Tailwind web page. This branch assembles the
// TUI-side leaves: `list` enumerates what's available, `run` hosts the TUI
// target (interactive in tmux, static dump when piped), `new` scaffolds a fresh
// view directory, and the hidden `pick` backs the /view popup. Each leaf owns
// its own help one level down. The web target is no longer served per-view here:
// it is hosted by the unified `crtr web serve` (the shell's /view/<id> route).

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { viewListLeaf } from './view-list.js';
import { viewRunLeaf } from './view-run.js';
import { viewCycleLeaf } from './view-cycle.js';
import { viewNewLeaf } from './view-new.js';
import { viewPickLeaf } from './view-pick.js';

export function registerView(): BranchDef {
  return defineBranch({
    name: 'view',
    rootEntry: {
      concept: 'switchable raw-ANSI terminal views — full-screen surfaces hosted in a pane, each a self-contained module',
      desc: 'list, run, and author TUI views',
      useWhen: 'you want a live full-screen surface (a monitor, an inbox, a dashboard) rather than one-shot command output — run a view by name, list what exists, or scaffold a new one. Views have no pi session; they render + take keystrokes until you quit.',
    },
    help: {
      name: 'view',
      summary: 'host and author switchable raw-ANSI terminal views',
      model:
        '`list` when you do not know which views exist — a flat roster (id/title/description/scope) across project→user→builtin. `run <name>` opens the TUI target full-screen in the current pane (tmux-only interactive; piped it prints the view\'s static dump and exits 0), forwarding --port/--target onto the view; pass --window/--split to open it as a persistent monitor (new window / split) you flip between with Alt+V then ]/[. The web target (React+Tailwind) is served by the unified `crtr web serve` (the shell\'s /view/<id> route), not per-view here. `cycle` switches a monitor pane to the next/prev view in place (what those keys drive). `new <name>` scaffolds a runnable view directory (core.mjs + tui.mjs + web.jsx + text.mjs) you edit. `pick` is a hidden raw-ANSI picker the /view popup shells. Append `-h` at any leaf for its schema.',
    },
    children: [viewListLeaf, viewRunLeaf, viewCycleLeaf, viewNewLeaf, viewPickLeaf],
  });
}
