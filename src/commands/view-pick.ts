// `crtr view pick` — hidden raw-ANSI picker over the available views.
//
// Backs the /view popup: a minimal full-screen list of listViews(); j/k move,
// Enter hands off to `crtr view run <id>` (execFileSync, stdio inherit — a
// one-way handoff, the picker exits as the view takes over, same pattern as
// browse's selectAndFocus), q/Esc/Ctrl-C quit. Outside a TTY it prints the
// plain list and exits 0. Reuses the core/tui terminal + draw primitives.

import { execFileSync } from 'node:child_process';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { listViews } from '../core/view/loader.js';
import {
  setupTerminal,
  restoreTerminal,
  getTerminalSize,
  parseKeypress,
} from '../core/tui/terminal.js';
import { createDraw, detectColorCaps, type ListItemRow } from '../core/tui/draw.js';

export const viewPickLeaf: LeafDef = defineLeaf({
  name: 'pick',
  tier: 'hidden',
  description: 'raw-ANSI view picker (used by the /view popup)',
  whenToUse: 'internal — the /view popup shells this to choose a view, then it execs `crtr view run <id>`. You normally run `crtr view run <name>` or `crtr view list` directly',
  help: {
    name: 'view pick',
    summary: 'interactive picker over available views; Enter runs the chosen view. Outside a TTY it prints the list and exits',
    inputNote: 'No input parameters.',
    output: [],
    outputKind: 'object',
    effects: [
      'Inside a TTY: takes over the terminal in raw mode until you pick (Enter) or quit (q/Esc/Ctrl-C).',
      'On Enter: execs `crtr view run <id>` (stdio inherited) — a one-way handoff; the picker exits.',
      'Outside a TTY: prints the plain view list and exits 0.',
    ],
  },
  run: async () => {
    const views = listViews();

    // Non-TTY: print the plain list and exit 0.
    if (!process.stdin.isTTY) {
      const text = views.length > 0
        ? views.map((v) => `${v.id}\t${v.scope}`).join('\n')
        : '(no views)';
      process.stdout.write(text + '\n');
      return;
    }

    if (views.length === 0) {
      process.stdout.write('No views found. Scaffold one with `crtr view new <name>`.\n');
      return;
    }

    const caps = detectColorCaps();
    let cursor = 0;
    let scroll = 0;

    let restored = false;
    const cleanup = (): void => {
      if (restored) return;
      restored = true;
      try { restoreTerminal(); } catch { /* best-effort */ }
    };
    process.once('exit', cleanup);

    const render = (): void => {
      const size = getTerminalSize();
      const { draw, frame } = createDraw(size, caps);
      draw.text(0, 0, 'crtr views — j/k move · Enter run · q quit', { bold: true });
      draw.hline(1, 0, size.cols);
      const rect = { row: 2, col: 0, width: size.cols, height: Math.max(1, size.rows - 3) };
      const items: ListItemRow[] = views.map((v) => ({
        spans: [
          { text: v.id, style: { bold: true } },
          { text: `  [${v.scope}]`, style: { dim: true } },
        ],
      }));
      const res = draw.list(rect, items, cursor, scroll);
      scroll = res.scroll;
      process.stdout.write(frame());
    };

    setupTerminal();
    render();

    await new Promise<void>((resolve) => {
      const finish = (): never => {
        cleanup();
        process.exit(0);
      };
      const launch = (id: string): never => {
        cleanup();
        try {
          execFileSync('crtr', ['view', 'run', id], { stdio: 'inherit' });
        } catch {
          // The view takes the terminal over; a sync handoff may be interrupted.
        }
        process.exit(0);
      };

      process.stdin.on('data', (d: Buffer) => {
        let parsed: { input: string; key: ReturnType<typeof parseKeypress>['key'] };
        try { parsed = parseKeypress(d); } catch { return; }
        const { input, key } = parsed;

        if (key.ctrl && input === 'c') finish();
        if (input === 'q' || key.escape) finish();
        if (input === 'j' || key.downArrow) { cursor = Math.min(views.length - 1, cursor + 1); render(); return; }
        if (input === 'k' || key.upArrow) { cursor = Math.max(0, cursor - 1); render(); return; }
        if (key.return) launch(views[cursor]!.id);
      });
    });
  },
});
