// @ts-check
/**
 * Model ladders settings — text presenter for the `settings` view.
 *
 * @module settings/text
 */

import { buildRows } from './core.mjs';

/** @typedef {import('./core.mjs').SettingsState} SettingsState */

/** @param {SettingsState} state @param {import('../../core/view/contract.js').DumpContext} [ctx] @returns {string} */
export function dump(state, ctx) {
  const lines = ['Model ladders'];
  if (ctx && ctx.banner) lines.push('', `[${ctx.banner.level}] ${ctx.banner.msg}`);
  else if (state.sourceError) lines.push('', `[${state.sourceError.display.level}] ${state.sourceError.display.explanation}`);
  lines.push('', 'Provider × strength matrix', '');
  if (state.sourceError && state.modelLadders === null) {
    const d = state.sourceError.display;
    return ['Model ladders', '', `[${d.level}] ${d.headline}`, d.explanation, d.nextStep].filter(Boolean).join('\n');
  }
  if (state.modelLadders === null) return lines.concat(['(loading…)']).join('\n');
  for (const row of buildRows(state)) {
    if (row.kind === 'defaultProvider') {
      lines.push(`default provider: ${state.modelLadders.defaultProvider ?? 'anthropic'}`);
      continue;
    }
    if (row.kind === 'matrix') {
      const provider = state.matrixSelection[row.strength] ?? 'anthropic';
      lines.push(`${row.strength}: anthropic=${state.modelLadders.anthropic?.[row.strength] ?? '—'} | openai=${state.modelLadders.openai?.[row.strength] ?? '—'}${provider ? ` [selected ${provider}]` : ''}`);
      continue;
    }
    if (row.kind === 'persona') {
      lines.push(`${row.persona}: ${state.personaStrengths[row.persona] ?? 'strong'}`);
      continue;
    }
    lines.push('+ add persona strength');
  }
  return lines.join('\n');
}
