// `crtr view run <name>` — resolve, load, and host a view.
//
// Resolves the view across scopes (project→user→builtin), dynamically imports
// it, then hands it to the core/tui host. The host owns the screen and the
// non-TTY path: when stdin is NOT a TTY it prints view.dump(state) and exits 0,
// so `crtr view run <name> | cat` works anywhere. The interactive path is
// tmux-only (crtr is tmux-only) — outside tmux with a TTY we notify + no-op,
// never a non-tmux fallback. --port / --target forward verbatim onto
// host.options (camelCased, stringified); crtr does not interpret them.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
// crtr is tmux-only; check the env directly (the tmux.ts driver is reserved for
// placement.ts / tmux-chrome.ts per the architecture lint).
const inTmux = (): boolean =>
  process.env['TMUX'] !== undefined && process.env['TMUX'] !== '';
import { runView } from '../core/tui/host.js';
import { resolveView, loadView, listViews } from '../core/tui/loader.js';

export const viewRunLeaf: LeafDef = defineLeaf({
  name: 'run',
  description: 'resolve, load, and host a view (interactive; pipes to a static dump)',
  whenToUse: 'you want to OPEN a view by name — a full-screen raw-ANSI surface hosted in the current pane. Inside tmux it takes over the terminal until you quit (q); piped (`crtr view run <name> | cat`) it prints a static snapshot and exits. Pass --port/--target to forward connection details to the view (e.g. the LinkedIn view\'s capture CDP port + tab). Use `crtr view list` first to see what is available, or `crtr view new` to scaffold one',
  help: {
    name: 'view run',
    summary: 'host a view in the current pane; outside a TTY it prints the view\'s static dump and exits 0',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'View id to run (its directory name). Resolves project→user→builtin.' },
      { kind: 'flag', name: 'port', type: 'int', required: false, constraint: 'Forwarded verbatim to the view as options.port (e.g. a CDP debugging port).' },
      { kind: 'flag', name: 'target', type: 'string', required: false, constraint: 'Forwarded verbatim to the view as options.target (e.g. a browser tab id).' },
    ],
    output: [],
    outputKind: 'object',
    effects: [
      'Inside a TTY+tmux: takes over the terminal in raw mode (alt-screen) until you quit (q/Ctrl-C).',
      'Outside a TTY: writes the view\'s static dump to stdout and exits 0 (no raw mode).',
      'Forwards --port/--target onto host.options for the view; mutates nothing on the canvas.',
    ],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const port = input['port'] as number | undefined;
    const target = input['target'] as string | undefined;

    const r = resolveView(name);
    if (r === null) {
      const avail = listViews().map((v) => v.id);
      throw new InputError({
        error: 'view_not_found',
        message: `no view: ${name}`,
        received: name,
        next: avail.length > 0
          ? `Available views: ${avail.join(', ')}. Or scaffold one with \`crtr view new ${name}\`.`
          : `No views found. Scaffold one with \`crtr view new ${name}\`.`,
      });
    }

    const v = await loadView(r);

    // The interactive path is tmux-only; the piped/non-TTY dump path works
    // anywhere (runView handles it internally), so only guard when stdin is a
    // TTY. Outside tmux with a TTY: notify + no-op — never a non-tmux fallback.
    if (process.stdin.isTTY && !inTmux()) {
      throw new InputError({
        error: 'not_in_tmux',
        message: 'crtr view is tmux-only — run it inside the crtr tmux session',
        next: `Open it from inside tmux (e.g. the /view popup), or pipe for a static snapshot: \`crtr view run ${name} | cat\`.`,
      });
    }

    const options: Record<string, string> = {};
    if (port !== undefined) options.port = String(port);
    if (target !== undefined) options.target = target;

    await runView(v, { options });
  },
});
