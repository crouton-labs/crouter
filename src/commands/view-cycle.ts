// `crtr view cycle <dir>` — switch the view hosted in a monitor pane to the
// next/prev available view, in place. Backs the Alt+V then ] (next) / Alt+V
// then [ (prev) chord installed by installViewNavBindings, mirroring how
// `node cycle` backs Alt+] / Alt+[ for the node graph (view = the bracket
// grammar namespaced under the Alt+V view prefix).
//
// A view monitor pane is self-identifying: `view run` tags it with the tmux
// pane option @crtr_view=<id>. Cycle reads that tag, computes the next/prev id
// in `listViews()` order (the SAME set `view list` enumerates), and respawns
// the pane on `crtr view run <next-id>` — `respawn-pane -k` kills the current
// view process and re-execs in the SAME pane (cycle itself runs in tmux's
// run-shell context, NOT inside the pane, so the kill never targets the caller).
// The respawned run re-tags the pane, so a rapid re-cycle reads the right id.
//
// tmux-only; a pane with no @crtr_view tag (not a view monitor) is a no-op.
// Output is discarded by the keybinding, so this just acts.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { listViews, resolveView, loadView } from '../core/tui/loader.js';
// Commands reach the tmux driver through placement.ts (the sanctioned
// model-over-driver seam, §5.1) — never `./tmux.js` directly.
import {
  inTmux,
  currentTmux,
  getPaneOption,
  setPaneOption,
  paneCurrentPath,
  respawnPaneSync,
  piCommand,
} from '../core/runtime/placement.js';

export const viewCycleLeaf: LeafDef = defineLeaf({
  name: 'cycle',
  description: 'switch the monitor pane to the next/prev view in place',
  whenToUse: 'flipping a view monitor to the next/prev available view without re-running a command (bound to Alt+V then ] forward / Alt+V then [ back). The pane must already be hosting a view — opened with `crtr view run <name>` (or --window/--split). Use `crtr view run <name>` to open a specific view, or `crtr view list` to see the cycle order',
  help: {
    name: 'view cycle',
    summary:
      'switch the view hosted in a monitor pane to the next/previous available view, in place — the views walked one monitor at a time, in `view list` order (bound to Alt+V then ] forward / Alt+V then [ back)',
    params: [
      { kind: 'flag', name: 'dir', type: 'enum', choices: ['next', 'prev'], required: false, default: 'next', constraint: 'Direction along the view list: next (Alt+V then ]) or prev (Alt+V then [). Wraps at the ends.' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane to cycle. Defaults to $TMUX_PANE / your current pane. The Alt+V then ]/[ bindings pass this for you.' },
    ],
    output: [
      { name: 'cycled', type: 'boolean', required: true, constraint: 'True when the pane was switched to another view.' },
      { name: 'view', type: 'string', required: false, constraint: 'The view now hosted in the pane.' },
      { name: 'from', type: 'string', required: false, constraint: 'The view it switched away from (absent when the pane was not a view monitor).' },
    ],
    outputKind: 'object',
    effects: [
      'Respawns the target pane (respawn-pane -k) running `crtr view run <next-id>`; the prior view process is replaced in place.',
      'Re-tags the pane @crtr_view=<next-id>. No-op outside tmux or when the pane is not a view monitor.',
    ],
  },
  run: async (input) => {
    if (!inTmux()) return { cycled: false };
    const dir = ((input['dir'] as string | undefined) ?? 'next') as 'next' | 'prev';
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
    if (pane === undefined || pane === '') return { cycled: false };

    // Self-identification: only a pane `view run` tagged is a view monitor.
    const current = getPaneOption(pane, '@crtr_view');
    if (current === undefined || current === '') return { cycled: false };

    const ids = listViews().map((v) => v.id); // SAME set + order as `view list`
    if (ids.length < 2) return { cycled: false, from: current };

    // Build the candidate order: views after `current` in `dir`, wrapping. If
    // `current` was renamed/removed (i === -1) start at the head (next) / tail
    // (prev) so the cycle lands on the FIRST available view (m3). Then advance
    // past any view that fails to load, so a malformed view never closes the
    // monitor on respawn (m4) — bounded to one full lap.
    const n = ids.length;
    const mod = (x: number): number => ((x % n) + n) % n;
    const step = dir === 'next' ? 1 : -1;
    const i = ids.indexOf(current);
    const candidates: string[] = [];
    if (i === -1) {
      const startIdx = dir === 'next' ? 0 : n - 1;
      for (let k = 0; k < n; k++) candidates.push(ids[mod(startIdx + step * k)]!);
    } else {
      for (let k = 1; k < n; k++) candidates.push(ids[mod(i + step * k)]!);
    }

    let targetId: string | undefined;
    for (const cand of candidates) {
      if (cand === current) continue;
      const rv = resolveView(cand);
      if (rv === null) continue;
      try { await loadView(rv); targetId = cand; break; } catch { /* skip malformed */ }
    }
    if (targetId === undefined) return { cycled: false, from: current };

    // Replay the connection params the monitor was opened with (M2): a view
    // configured with --port/--target keeps them across a cycle, so a round-trip
    // doesn't silently drop e.g. the LinkedIn view's CDP port. Params stick to
    // the MONITOR (pane), not the view, and are harmless to views that ignore them.
    const keepPort = getPaneOption(pane, '@crtr_view_port');
    const keepTarget = getPaneOption(pane, '@crtr_view_target');
    const argv = ['view', 'run', targetId];
    if (keepPort !== undefined && keepPort !== '') argv.push('--port', keepPort);
    if (keepTarget !== undefined && keepTarget !== '') argv.push('--target', keepTarget);

    // Preserve the monitor's cwd so project-scoped views still resolve.
    const cwd = paneCurrentPath(pane) ?? process.cwd();
    const command = piCommand(argv, 'crtr');
    const ok = respawnPaneSync({ pane, cwd, env: {}, command });
    if (!ok) return { cycled: false, from: current };

    // The respawned `view run` re-tags @crtr_view (+ params), but set them now
    // too so a rapid re-cycle reads the right state before the new run boots.
    try {
      setPaneOption(pane, '@crtr_view', targetId);
      setPaneOption(pane, '@crtr_view_port', keepPort ?? '');
      setPaneOption(pane, '@crtr_view_target', keepTarget ?? '');
    } catch { /* best-effort */ }
    return { cycled: true, view: targetId, from: current };
  },
  render: (r) => {
    if (r['cycled'] === true) {
      return `Cycled the monitor to view "${r['view']}" (from "${r['from']}").`;
    }
    if (r['from'] !== undefined) {
      return `No other view to switch to — the pane is still on "${r['from']}".`;
    }
    return 'Nothing to cycle — this pane is not hosting a view.';
  },
});
