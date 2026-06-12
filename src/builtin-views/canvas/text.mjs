// @ts-check
/**
 * Canvas Dashboard — the text presenter (`dump`) for the non-TTY / piped path of
 * the `canvas` view (`crtr view run canvas | cat`). Node-only, no ANSI. A plain
 * snapshot of the current state; the host threads its current banner via `ctx`.
 *
 * A data-source failure is a typed `SourceError` (we render its
 * `display.explanation` VERBATIM, never branching on `kind`). The pure helpers
 * `dump` shares with the TUI (relAge, lifeAbbr, dumpSummary) are imported from
 * `core.mjs`.
 *
 * @module canvas/text
 */

import { relAge, lifeAbbr, dumpSummary } from './core.mjs';

/** @typedef {import('./core.mjs').CanvasState} CanvasState */

/**
 * Plain-text snapshot for the non-TTY / piped path. No ANSI. The host threads
 * its current banner via `ctx` so guidance (a source error / a pending-ask
 * action) surfaces without the view mirroring it into state.
 * @param {CanvasState} state
 * @param {import('../../core/view/contract.js').DumpContext} [ctx]
 * @returns {string}
 */
export function dump(state, ctx) {
  /** @type {string[]} */
  const lines = ['Canvas — live agent graph'];
  const banner = ctx && ctx.banner ? ctx.banner : null;
  if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
  else if (state.sourceError) lines.push('', `[${state.sourceError.display.level}] ${state.sourceError.display.explanation}`);

  lines.push('', dumpSummary(state), '');

  if (state.rows.length === 0) {
    lines.push(
      state.sourceError
        ? '(canvas unavailable)'
        : state.lastFetch === 0
          ? '(loading…)'
          : state.totalNodes === 0
            ? '(no nodes on the canvas)'
            : '(no active trees)',
    );
    return lines.join('\n');
  }

  const now = Date.now();
  for (const r of state.rows) {
    const blk = r.blocked ? ` ⚑${r.askCount}` : '';
    const age = relAge(r.created, now);
    lines.push(
      `${r.prefix}${r.glyph} ${r.name} [${r.kind}/${r.mode}] ${lifeAbbr(r.lifecycle)} ${r.shortId} ${age}${blk}`,
    );
  }
  return lines.join('\n');
}
