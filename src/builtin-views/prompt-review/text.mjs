// @ts-check
/**
 * Prompt Studio — text presenter for the `prompt-review` view.
 * Dumps the assembled prompt for piped / non-TTY use.
 *
 * @module prompt-review/text
 */

/** @typedef {import('./core.mjs').ReviewState} ReviewState */

/** @param {ReviewState} state @param {import('../../core/view/contract.js').DumpContext} [ctx] @returns {string} */
export function dump(state, ctx) {
  if (ctx && ctx.banner) return `[${ctx.banner.level}] ${ctx.banner.msg}\n\n${state.assembled || ''}`.trim();
  return state.assembled || '';
}
