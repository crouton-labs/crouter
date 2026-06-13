// @ts-check
/**
 * Model ladders settings — TUI presenter for the `settings` view.
 *
 * @module settings/tui
 */

import { loadingState, notReadyState } from '../_lib/states.mjs';
import { buildRows, settingsRowLabel, settingsTargetForRow } from './core.mjs';

/** @typedef {import('./core.mjs').SettingsState} SettingsState */

/** @param {SettingsState} state @returns {import('../../core/tui/draw.js').ListItemRow[]} */
function rows(state) {
  const out = [];
  const dataRows = buildRows(state);
  for (const row of dataRows) {
    if (row.kind === 'defaultProvider') {
      const value = state.modelLadders?.defaultProvider ?? 'anthropic';
      out.push({ spans: [{ text: 'Default provider', style: { bold: true } }, { text: '  ' }, { text: value, style: { fg: '36' } }] });
      continue;
    }
    if (row.kind === 'matrix') {
      const selected = state.matrixSelection[row.strength] ?? 'anthropic';
      const a = state.modelLadders?.anthropic?.[row.strength] ?? '—';
      const o = state.modelLadders?.openai?.[row.strength] ?? '—';
      out.push({
        spans: [
          { text: row.strength, style: { bold: true } },
          { text: '  ' },
          { text: 'anthropic: ', style: { dim: true } },
          { text: a, style: selected === 'anthropic' ? { reverse: true, bold: true } : undefined },
          { text: '   ' },
          { text: 'openai: ', style: { dim: true } },
          { text: o, style: selected === 'openai' ? { reverse: true, bold: true } : undefined },
        ],
      });
      continue;
    }
    if (row.kind === 'persona') {
      out.push({ spans: [{ text: row.persona, style: { bold: true } }, { text: '  →  ' }, { text: state.personaStrengths[row.persona] ?? 'strong', style: { fg: '33' } }] });
      continue;
    }
    out.push({ spans: [{ text: '+ add persona strength', style: { fg: '32', bold: true } }] });
  }
  return out;
}

/** @param {SettingsState} state @param {import('../../core/tui/draw.js').Draw} draw @param {import('../../core/tui/draw.js').Rect} content */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;
  if (state.sourceError && state.modelLadders === null) {
    const d = state.sourceError.display;
    notReadyState(draw, content, {
      glyph: d.level === 'action' ? '⊙' : '⚠',
      glyphFg: d.level === 'action' ? '33' : '31',
      headline: d.headline,
      explanation: d.explanation,
      nextStep: d.nextStep,
    });
    return;
  }
  if (state.modelLadders === null) {
    loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading model ladders…' });
    return;
  }

  const header = state.edit
    ? `Replacing ${state.edit.label} — Enter saves, Esc cancels`
    : 'j/k move · h/l switch matrix cell · enter edit · n add persona · g refresh';
  draw.text(content.row, content.col, 'Model ladders', { bold: true });
  draw.text(content.row + 1, content.col, header, { dim: true });
  if (state.edit) {
    draw.text(content.row + 2, content.col, `Current: ${state.edit.value || '(empty)'}`, { dim: true });
    draw.text(content.row + 3, content.col, `Replacement: ${state.edit.draft}`, { fg: '33' });
  }
  const listRect = { row: content.row + (state.edit ? 4 : 3), col: content.col, width: content.width, height: Math.max(0, content.height - (state.edit ? 4 : 3)) };
  const items = rows(state);
  const res = draw.list(listRect, items, state.cursor, state.scroll);
  state.scroll = res.scroll;
}

export const keymap = [
  { keys: ['j', 'down'], intent: 'cursorDown', when: (s) => !s.edit, hint: { keys: 'j/k', label: 'move' } },
  { keys: ['k', 'up'], intent: 'cursorUp', when: (s) => !s.edit },
  { keys: ['h', 'left'], intent: 'matrixLeft', when: (s) => !s.edit, hint: { keys: 'h/l', label: 'switch cell' } },
  { keys: ['l', 'right'], intent: 'matrixRight', when: (s) => !s.edit },
  { keys: ['n'], intent: 'jumpAddPersona', when: (s) => !s.edit, hint: { keys: 'n', label: 'add persona' } },
  { keys: ['g'], intent: 'refresh', when: (s) => !s.edit, hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
  { capture: 'setDraft', when: (s) => !!s.edit },
  { keys: ['enter', 'return'], intent: 'submitEdit', when: (s) => !!s.edit },
  { keys: ['enter', 'return'], intent: 'beginEdit', when: (s) => !s.edit, hint: { keys: 'enter', label: 'edit' } },
  { keys: ['escape', 'esc'], intent: 'cancelEdit', when: (s) => !!s.edit },
];
