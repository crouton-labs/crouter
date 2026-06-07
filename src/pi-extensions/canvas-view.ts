// canvas-view.ts — pi extension registering the /view canvas command.
//
//   /view          — open the view picker (`crtr view pick`) as a tmux popup:
//     a raw-ANSI list of every available view; Enter hands off (one-way exec)
//     to `crtr view run <id>`, which paints the full-screen view inside the
//     same popup. Quitting the view closes the popup back to THIS pi pane.
//   /view <name>   — skip the picker and popup `crtr view run <name>` directly.
//
//   Views are stateless render surfaces with NO pi session. Unlike /resume-node
//   this command MUST NOT touch the node-focus / swap-pane / reviveNode path
//   (spec Decision 8) — there is no pane to return to and no session to revive.
//   The popup is fire-and-forget: it owns its own screen and closes itself when
//   the view exits, dropping back to the pi pane on its own.
//
// crtr ONLY runs inside tmux (see crouter/CLAUDE.md) — there is no non-tmux
// fallback picker. Outside tmux the command notifies and no-ops.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session, not a canvas node).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages (mirrors
// canvas-resume.ts / canvas-nav.ts / canvas-commands.ts).

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Minimal Pi interface (avoids a hard dep on @earendil-works/*). Signatures
// sourced from pi-coding-agent's dist/core/extensions/types.d.ts:
//   registerCommand(name, { description?, handler })
//   ctx.mode: "tui" | "rpc" | "json" | "print"  (guard "tui" before the popup)
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
}

/** Single-quote a string for safe interpolation into a `sh -c` command line —
 *  tmux runs the display-popup trailing string through the shell, so a view
 *  name with spaces or quotes must be escaped. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Register the /view command on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasView(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node
  if (typeof pi.registerCommand !== 'function') return;

  pi.registerCommand('view', {
    description: 'Open a view in a popup — bare for the picker, or /view <name> to open that view directly',
    handler: async (args: string, ctx: CommandCtx): Promise<void> => {
      // The popup is terminal-only — guard the run mode before opening it.
      if (ctx.mode !== 'tui') {
        try { ctx.ui.notify('/view needs the interactive TUI', 'warning'); } catch { /* best-effort */ }
        return;
      }

      // crtr only runs in tmux: open the view (picker, or a named view) as a
      // popup. It owns the screen and closes itself when the view exits,
      // dropping back to THIS pi pane — no node-focus, no return-pane.
      // Fire-and-forget: tmux runs the trailing string through sh -c.
      if (process.env['TMUX'] !== undefined) {
        const name = args.trim();
        // bare /view → the picker; /view <name> → that view directly.
        const cmd = name === '' ? 'crtr view pick' : `crtr view run ${shellQuote(name)}`;
        try {
          execFile(
            'tmux',
            ['display-popup', '-E', '-w', '90%', '-h', '85%', cmd],
            (): void => { /* best-effort: popup is self-contained */ },
          );
        } catch { /* best-effort */ }
        return;
      }

      // Not in tmux → crtr is tmux-only, so there is nothing to fall back to.
      try { ctx.ui.notify('/view needs tmux', 'warning'); } catch { /* best-effort */ }
    },
  });
}

export default registerCanvasView;
