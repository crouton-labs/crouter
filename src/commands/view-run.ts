// `crtr view run <name>` — resolve, load, and host a view.
//
// Resolves the view across scopes (project→user→builtin), dynamically imports
// it, then hands it to the core/tui host. The host owns the screen and the
// non-TTY path: when stdin is NOT a TTY it prints view.dump(state) and exits 0,
// so `crtr view run <name> | cat` works anywhere. The interactive path is
// tmux-only (crtr is tmux-only) — outside tmux with a TTY we notify + no-op,
// never a non-tmux fallback. --port / --target forward verbatim onto
// host.options (camelCased, stringified); crtr does not interpret them.
//
// --window / --split open the view as a PERSISTENT MONITOR instead of taking
// over the current pane: --window in a new background (non-focus-stealing)
// tmux window, --split in a right-hand split of the current pane. Both shell a
// plain inner `crtr view run <name>` into the new pane, which hosts the view
// there and self-tags the pane with @crtr_view so the Alt+V then ]/[ view-cycle
// can flip it to the next/prev view in place. Both are tmux-only by nature; in
// a pipe (non-TTY) placement is meaningless, so they degrade to the static dump.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { runView, runCoreView } from '../core/tui/host.js';
import { resolveView as resolveLegacyView, loadView, listViews as listLegacyViews } from '../core/tui/loader.js';
import {
  resolveView as resolveCoreView,
  loadCore,
  loadTui,
  loadText,
  requireTui,
  listViews as listCoreViews,
} from '../core/view/loader.js';
// Commands reach the tmux driver through placement.ts (the sanctioned
// model-over-driver seam, §5.1) — never `./tmux.js` directly.
import {
  inTmux,
  currentTmux,
  openNodeWindow,
  splitWindow,
  piCommand,
  setPaneOption,
} from '../core/runtime/placement.js';

export const viewRunLeaf: LeafDef = defineLeaf({
  name: 'run',
  description: 'resolve, load, and host a view (in this pane, a new window, or a split)',
  whenToUse: 'you want to OPEN a view by name — a full-screen raw-ANSI surface. By default it hosts in the current pane (tmux-only interactive; piped it prints a static snapshot). Pass --window to open it as a background monitor window, or --split to open it beside the current pane — both leave you where you are so a view becomes a live monitor you flip between with Alt+V then ]/[. Pass --port/--target to forward connection details. Use `crtr view list` first to see what is available, or `crtr view new` to scaffold one',
  help: {
    name: 'view run',
    summary: 'host a view in the current pane, a new window (--window), or a split (--split); outside a TTY it prints the view\'s static dump and exits 0',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'View id to run (its directory name). Resolves project→user→builtin.' },
      { kind: 'flag', name: 'window', type: 'bool', required: false, constraint: 'Open the view in a NEW background tmux window (non-focus-stealing) instead of the current pane — a persistent monitor. tmux-only; ignored (static dump) in a pipe. Mutually exclusive with --split.' },
      { kind: 'flag', name: 'split', type: 'bool', required: false, constraint: 'Open the view in a right-hand SPLIT of the current pane instead of taking it over — a side-by-side monitor. tmux-only; ignored (static dump) in a pipe. Mutually exclusive with --window.' },
      { kind: 'flag', name: 'port', type: 'int', required: false, constraint: 'Forwarded verbatim to the view as options.port (e.g. a CDP debugging port).' },
      { kind: 'flag', name: 'target', type: 'string', required: false, constraint: 'Forwarded verbatim to the view as options.target (e.g. a browser tab id).' },
    ],
    output: [
      { name: 'hosted', type: 'string', required: false, constraint: 'For --window/--split: "window" or "split" — where the monitor opened. Absent for an in-pane host (which holds the terminal until you quit).' },
      { name: 'view', type: 'string', required: false, constraint: 'The view id opened (only on the --window/--split path).' },
      { name: 'window', type: 'string', required: false, constraint: 'The new tmux window id (--window only).' },
      { name: 'pane', type: 'string', required: false, constraint: 'The new tmux pane id (--window/--split).' },
    ],
    outputKind: 'object',
    effects: [
      'Default (no flag) inside a TTY+tmux: takes over the current pane in raw mode (alt-screen) until you quit (q/Ctrl-C), and tags the pane @crtr_view=<name> so Alt+V then ]/[ can cycle it.',
      '--window: opens a new background tmux window running the view (does not steal focus); returns immediately.',
      '--split: opens a right-hand split of the current pane running the view; you stay in your pane.',
      'Outside a TTY: writes the view\'s static dump to stdout and exits 0 (no raw mode); --window/--split degrade to this.',
      'Forwards --port/--target onto host.options for the view; mutates nothing on the canvas.',
    ],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const port = input['port'] as number | undefined;
    const target = input['target'] as string | undefined;
    const asWindow = input['window'] === true;
    const asSplit = input['split'] === true;

    if (asWindow && asSplit) {
      throw new InputError({
        error: 'conflicting_flags',
        message: '--window and --split are mutually exclusive',
        next: 'Pass at most one: --window (new background window) or --split (split the current pane).',
      });
    }

    // Dual-load: prefer a NEW dual-target `core.mjs` view; fall back to the
    // legacy single-file `view.mjs` so today's builtins keep working untouched.
    const coreR = resolveCoreView(name);
    const legacyR = coreR ? null : resolveLegacyView(name);
    if (coreR === null && legacyR === null) {
      const avail = Array.from(new Set([
        ...listCoreViews().map((v) => v.id),
        ...listLegacyViews().map((v) => v.id),
      ])).sort();
      throw new InputError({
        error: 'view_not_found',
        message: `no view: ${name}`,
        received: name,
        next: avail.length > 0
          ? `Available views: ${avail.join(', ')}. Or scaffold one with \`crtr view new ${name}\`.`
          : `No views found. Scaffold one with \`crtr view new ${name}\`.`,
      });
    }

    const options: Record<string, string> = {};
    if (port !== undefined) options.port = String(port);
    if (target !== undefined) options.target = target;

    // Load + host the resolved view via the matching path (works for both the
    // non-TTY dump and the interactive alt-screen — each host handles the TTY
    // gate internally).
    const hostView = async (): Promise<void> => {
      if (coreR) {
        requireTui(coreR);
        const core = await loadCore(coreR);
        const tui = await loadTui(coreR);
        const txt = await loadText(coreR);
        await runCoreView(core, tui, txt, { options });
      } else {
        const v = await loadView(legacyR!);
        await runView(v, { options });
      }
    };

    // --window / --split: open the view as a persistent monitor in a new pane.
    if (asWindow || asSplit) {
      // Placement is tmux-only. In a pipe (non-TTY) it is meaningless — degrade
      // to the static dump (runView handles the non-TTY path internally).
      if (!process.stdin.isTTY) {
        await hostView();
        return;
      }
      if (!inTmux()) {
        throw new InputError({
          error: 'not_in_tmux',
          message: '--window/--split are tmux-only — run crtr inside its tmux session',
          next: `Open it from inside tmux, or drop the flag to host in the current pane (or pipe for a snapshot: \`crtr view run ${name} | cat\`).`,
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

      // The inner command re-enters this leaf with NO placement flag, so it
      // hosts the view in its own (new) pane and self-tags it via @crtr_view.
      const argv = ['view', 'run', name];
      if (port !== undefined) argv.push('--port', String(port));
      if (target !== undefined) argv.push('--target', target);
      const command = piCommand(argv, 'crtr');
      const cwd = process.cwd();

      if (asWindow) {
        const win = openNodeWindow({ session: here.session, name: `view:${name}`, cwd, env: {}, command });
        if (win === null) {
          throw new InputError({
            error: 'window_open_failed',
            message: `tmux could not open a window for view ${name}`,
            next: 'Check the tmux server is reachable, then retry.',
          });
        }
        return { hosted: 'window', view: name, window: win.window, pane: win.pane };
      }
      // --split: a right-hand split (-h, the splitWindow default); -d keeps you put.
      const pane = splitWindow(here.pane, { cwd, env: {}, command });
      if (pane === null) {
        throw new InputError({
          error: 'split_failed',
          message: `tmux could not split the pane for view ${name}`,
          next: 'Check the tmux server is reachable, then retry.',
        });
      }
      return { hosted: 'split', view: name, pane };
    }

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

    // Self-tag this pane with the view id (+ any forwarded --port/--target) so
    // the Alt+V then ]/[ view-cycle can switch it to the next/prev view in place
    // AND replay the connection params it was opened with. Best-effort; tmux-only.
    const tagPane = (process.stdin.isTTY && inTmux())
      ? (process.env['TMUX_PANE'] ?? currentTmux()?.pane)
      : undefined;
    if (tagPane !== undefined && tagPane !== '') {
      try {
        setPaneOption(tagPane, '@crtr_view', name);
        setPaneOption(tagPane, '@crtr_view_port', port !== undefined ? String(port) : '');
        setPaneOption(tagPane, '@crtr_view_target', target ?? '');
      } catch { /* best-effort */ }
    }

    try {
      await hostView();
    } finally {
      // On a clean quit (q) runView returns to the shell/pi that launched this
      // pane — clear the monitor tag so a stray Alt+V ]/[ can't respawn-pane -k
      // (and kill) whatever now owns the pane. When the cycle itself replaces
      // this view it SIGKILLs us mid-await (this finally never runs); cycle + the
      // new view-run re-tag, so that path stays correct.
      if (tagPane !== undefined && tagPane !== '') {
        try { setPaneOption(tagPane, '@crtr_view', ''); } catch { /* best-effort */ }
      }
    }
  },
  render: (result) => {
    const hosted = result['hosted'];
    if (hosted === 'window') {
      return `Opened view "${result['view']}" as a window monitor — window ${result['window']}, pane ${result['pane']}.`;
    }
    if (hosted === 'split') {
      return `Opened view "${result['view']}" as a split monitor — pane ${result['pane']}.`;
    }
    // In-pane host: the terminal was held until quit; nothing to report.
    return '';
  },
});
