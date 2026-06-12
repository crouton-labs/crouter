// @ts-check
/**
 * Workspace Sidebar — the text presenter (`dump`) for the non-TTY / piped path
 * (`crtr view run workspace-sidebar | cat`). Node-only, no ANSI. A plain
 * snapshot of the current state; the host threads its current banner via `ctx`.
 *
 * `dump` reads the SAME logical `RailRow[]` the TUI/web presenters do. The pure
 * `plural` helper is imported from `core.mjs`.
 *
 * @module workspace-sidebar/text
 */

import { plural } from './core.mjs';

/** @typedef {import('./core.mjs').SidebarState} SidebarState */
/** @typedef {import('./core.mjs').RailRow} RailRow */

const STATUS_GLYPH = { active: '●', idle: '○', done: '✓', dead: '✗', canceled: '⊘' };

/**
 * Plain-text snapshot for the non-TTY / piped path.
 * @param {SidebarState} state
 * @param {import('../../core/view/contract.js').DumpContext} [ctx]
 * @returns {string}
 */
export function dump(state, ctx) {
  /** @type {string[]} */
  const lines = ['Workspace sidebar'];
  const banner = ctx && ctx.banner ? ctx.banner : null;
  if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
  else if (state.srcError) lines.push('', `[${state.srcError.display.level}] ${state.srcError.display.explanation}`);

  lines.push('', `${plural(state.graphsHere, 'graph')} · ${state.nodesHere} nodes · ${plural(state.asksHere, 'ask')}`, '');

  if (state.rows.length === 0) {
    lines.push(state.srcError ? '(canvas unavailable)' : state.lastFetch === 0 ? '(loading…)' : '(no agents in this cwd)');
    return lines.join('\n');
  }

  for (const r of state.rows) {
    if (r.kind === 'header') {
      lines.push(r.text);
    } else if (r.kind === 'chrome') {
      lines.push(r.text);
    } else {
      const mark = r.attached ? '▸ ' : '  ';
      const glyph = STATUS_GLYPH[r.status] || '?';
      const flag = r.asks > 0 ? ` ⚑${r.asks}` : '';
      lines.push(`${mark}${r.prefix}${glyph} ${r.name}${flag}`);
    }
  }
  return lines.join('\n');
}
