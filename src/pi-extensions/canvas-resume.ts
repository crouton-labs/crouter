// canvas-resume.ts — pi extension registering the /resume-node canvas command.
//
//   /resume-node  — open the full-screen canvas navigator (`crtr canvas browse`)
//     as a tmux popup. The navigator owns the screen (tabs / auto-collapsed tree
//     / `/` super-search / cwd scope / sort / preview) and, on Enter, focuses the
//     chosen node back INTO this pane via `crtr node focus --pane`. The popup is
//     scoped to THIS node's cwd by default (pass --cwd) so you see the nodes from
//     the dir you're working in first; toggle to All dirs inside with `c`.
//
//   The name is literally `resume-node`, NOT `resume`, to avoid clashing with
//   pi's built-in /resume.
//
// crtr ONLY runs inside tmux (see crouter/CLAUDE.md) — there is no non-tmux
// fallback picker. Outside tmux the command notifies and no-ops.
//
// ⚠ DESYNC — why `crtr node focus` is the ONLY sanctioned open
//   `crtr node focus <id>` (which `canvas browse` shells on Enter) routes through
//   reviveNode() (src/core/runtime/revive.ts), the ONLY sanctioned launcher of
//   `pi --session <file>`: it sets CRTR_NODE_ID + the `-e` canvas extensions and
//   runs transition('revive'). A RAW `pi --session <file>` has NEITHER → every
//   canvas hook is inert and the daemon can DOUBLE-SPAWN onto the same .jsonl.
//   A UI must therefore NEVER spawn `pi --session` directly.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session, not a canvas node).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages (mirrors
// canvas-nav.ts / canvas-commands.ts).

import { execFile } from 'node:child_process';
import { surfaceTmuxStyleArgs } from '../core/runtime/surface-bg.js';
import { readConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Minimal Pi interface (avoids a hard dep on @earendil-works/*). Signatures
// sourced from pi-coding-agent's dist/core/extensions/types.d.ts:
//   registerCommand(name, { description?, handler })
//   registerShortcut(spec, { description?, handler })
//   ctx.mode: "tui" | "rpc" | "json" | "print"  (guard "tui" before the popup)
// The shortcut handler's ctx is pi's ExtensionContext, a superset of the
// command ctx — it carries the same { mode, ui }, so CommandCtx fits both.
// ---------------------------------------------------------------------------

interface CommandUI {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

interface CommandCtx {
  mode: string;
  ui: CommandUI;
}

interface PiLike {
  registerCommand?(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
  ): void;
  registerShortcut?(
    shortcut: string,
    options: { description?: string; handler: (ctx: CommandCtx) => void | Promise<void> },
  ): void;
}

/** Single-quote a string for safe interpolation into a `sh -c` command line —
 *  tmux runs the display-popup trailing string through the shell, so a cwd with
 *  spaces or quotes must be escaped. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Register the /resume-node command on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasResume(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  /** Open the full-screen canvas navigator as a tmux popup. Shared by the
   *  /resume-node command and the resumeKey shortcut so both behave identically.
   *  The popup is terminal-only and crtr is tmux-only — both are guarded here. */
  const openResumePicker = (ctx: CommandCtx): void => {
    // The popup is terminal-only — guard the run mode before opening it.
    if (ctx.mode !== 'tui') {
      try { ctx.ui.notify('resume-node needs the interactive TUI', 'warning'); } catch { /* best-effort */ }
      return;
    }

    const origPane = process.env['TMUX_PANE'];

    // crtr only runs in tmux: open the full-screen canvas navigator as a popup.
    // It owns the screen and, on Enter, focuses the chosen node back INTO this
    // pane via `crtr node focus --pane`. Fire-and-forget: tmux runs the trailing
    // string through sh -c, and the popup closes itself when browse exits.
    if (process.env['TMUX'] !== undefined && origPane !== undefined && origPane !== '') {
      // Scope the navigator to this node's cwd by default (the dir pi runs in).
      const cwd = shellQuote(process.cwd());
      const cmd = `crtr canvas browse --return-pane ${origPane} --cwd ${cwd}`;
      try {
        execFile(
          'tmux',
          ['display-popup', '-E', '-w', '90%', '-h', '85%', ...surfaceTmuxStyleArgs(), cmd],
          (): void => { /* best-effort: popup is self-contained */ },
        );
      } catch { /* best-effort */ }
      return;
    }

    // Not in tmux → crtr is tmux-only, so there is nothing to fall back to.
    try { ctx.ui.notify('resume-node needs tmux', 'warning'); } catch { /* best-effort */ }
  };

  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand('resume-node', {
      description: 'Open the canvas navigator (search/scope/sort/tree) and resume the chosen node',
      handler: async (_args: string, ctx: CommandCtx): Promise<void> => { openResumePicker(ctx); },
    });
  }

  // A pi shortcut that opens the picker DIRECTLY (no keystroke simulation),
  // mirroring canvas-nav's prefixKey. Default 'alt+shift+g', configurable via
  // canvasNav.resumeKey. Registered once per load (pi dedupes on /reload); wrap
  // in try/catch since pi rejects some specs. A headless ('print') broker has no
  // keyboard, so this only ever fires in the interactive TUI.
  let resumeKey: string | undefined;
  try { resumeKey = readConfig('user').canvasNav.resumeKey; } catch { resumeKey = 'alt+shift+g'; }
  if (typeof pi.registerShortcut === 'function' && resumeKey !== undefined && resumeKey !== '') {
    try {
      pi.registerShortcut(resumeKey, {
        description: 'Open the canvas navigator (resume a node)',
        handler: async (ctx: CommandCtx): Promise<void> => { openResumePicker(ctx); },
      });
    } catch {
      /* shortcut spec rejected by pi — /resume-node still works */
    }
  }
}

export default registerCanvasResume;
