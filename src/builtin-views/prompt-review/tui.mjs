// @ts-check
/**
 * Prompt Studio — TUI presenter for the `prompt-review` view.
 * Read-only fallback: layered list / raw toggle / inspector / diff navigation.
 *
 * @module prompt-review/tui
 */

import { loadingState, notReadyState, emptyState } from '../_lib/states.mjs';
import { configHeadline, diffReviews, selectedLayer, compareSelectedLayer, layerLabel } from './core.mjs';

/** @typedef {import('./core.mjs').ReviewState} ReviewState */

/** @param {number} n @returns {string} */
function fmt(n) { return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0))); }

/** @param {string} text @returns {string[]} */
function lines(text) { return String(text || '').replace(/\r\n/g, '\n').split('\n'); }

/** @param {string} text @param {number} width @returns {string} */
function clip(text, width) {
  const s = String(text || '');
  if (width <= 0) return '';
  return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

/** @param {string} scope @returns {string} */
function scopeTag(scope) { return `[${scope}]`; }

/** @param {string} group @returns {string} */
function groupTag(group) { return `{${group}}`; }

/** @param {ReviewState} state @returns {import('../../core/tui/draw.js').ListItemRow[]} */
function layerRows(state) {
  const out = [];
  for (const layer of state.review || []) {
    const included = layer.included ? '●' : '○';
    out.push({
      spans: [
        { text: `${included} `, style: { fg: layer.included ? '32' : '90', bold: layer.included } },
        { text: layer.label, style: layer.included ? { bold: true } : { dim: true } },
        { text: ` ${groupTag(layer.group)}`, style: { fg: '90', dim: true } },
      ],
      right: [
        { text: `≈${fmt(layer.tokens)}`, style: { fg: '90', dim: true } },
      ],
    });
    if (!layer.included && layer.condition) {
      out.push({ spans: [{ text: `  ✕ ${layer.condition}`, style: { fg: '31', dim: true } }] });
    }
  }
  return out;
}

/** @param {ReviewState} state @returns {import('../../core/tui/draw.js').ListItemRow[]} */
function rawRows(state) {
  return lines(state.assembled || '').map((line) => ({ spans: [{ text: line, style: { fg: '90' } }] }));
}

/** @param {ReviewState} state @param {number} width @returns {import('../../core/tui/draw.js').ListItemRow[]} */
function inspectorRows(state, width) {
  const layer = selectedLayer(state) || state.review?.[0] || null;
  const compare = compareSelectedLayer(state) || state.compareReview?.[0] || null;
  const diffs = diffReviews(state.review || [], state.compareReview || []);
  /** @type {import('../../core/tui/draw.js').ListItemRow[]} */
  const rows = [];
  rows.push({ spans: [{ text: 'Selected layer', style: { bold: true } }] });
  if (!layer) {
    rows.push({ spans: [{ text: 'No layer selected.', style: { dim: true } }] });
  } else {
    rows.push({ spans: [{ text: layer.label, style: { bold: true } }] });
    rows.push({ spans: [{ text: layer.source, style: { fg: '90', dim: true } }] });
    if (layer.sourcePath) rows.push({ spans: [{ text: layer.sourcePath, style: { fg: '90' } }] });
    rows.push({ spans: [{ text: `${layer.scope} · ${layer.group} · ${layer.included ? 'included' : 'excluded'} · ≈${fmt(layer.tokens)} tok · ${fmt(layer.chars)} chars`, style: { fg: '90', dim: true } }] });
    if (layer.condition) rows.push({ spans: [{ text: `condition: ${layer.condition}`, style: { fg: '31' } }] });
    rows.push({ spans: [{ text: clip(layer.text, Math.max(0, width - 2)), style: { fg: '90' } }] });
  }
  rows.push({ spans: [{ text: '', style: undefined }] });
  rows.push({ spans: [{ text: 'Compare layer', style: { bold: true } }] });
  if (!compare) rows.push({ spans: [{ text: 'No comparison config.', style: { dim: true } }] });
  else {
    rows.push({ spans: [{ text: compare.label, style: { bold: true } }] });
    rows.push({ spans: [{ text: `${compare.scope} · ${compare.group} · ${compare.included ? 'included' : 'excluded'} · ≈${fmt(compare.tokens)} tok`, style: { fg: '90', dim: true } }] });
  }
  rows.push({ spans: [{ text: '', style: undefined }] });
  rows.push({ spans: [{ text: 'Diff', style: { bold: true } }] });
  if (diffs.length === 0) rows.push({ spans: [{ text: 'No differences.', style: { dim: true } }] });
  else {
    for (const diff of diffs.slice(0, 8)) {
      rows.push({ spans: [{ text: `${diff.kind} · ${diff.label}`, style: { bold: true } }, { text: ` · ${clip(diff.diffText || diff.summary, Math.max(0, width - 14))}`, style: { dim: true } }] });
    }
  }
  return rows;
}

/** @param {ReviewState} state @param {import('../../core/tui/draw.js').Draw} draw @param {import('../../core/tui/draw.js').Rect} content */
export function render(state, draw, content) {
  if (content.width <= 0 || content.height <= 0) return;

  if (state.sourceError && !state.review) {
    const d = state.sourceError.display;
    notReadyState(draw, content, { glyph: d.level === 'action' ? '⊙' : '⚠', glyphFg: d.level === 'action' ? '33' : '31', headline: d.headline, explanation: d.explanation, nextStep: d.nextStep });
    return;
  }
  if (!state.review) {
    loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading Prompt Studio…' });
    return;
  }
  if (state.review.length === 0) {
    emptyState(draw, content, { headline: 'No prompt layers', secondary: ['Press g to refresh.'] });
    return;
  }

  const headerRows = 3;
  draw.text(content.row, content.col, 'Prompt Studio', { bold: true });
  draw.text(content.row + 1, content.col, configHeadline(state.config), { dim: true });
  draw.text(content.row + 2, content.col, `j/k layer · h/l compare · tab raw/layered · e export · g refresh${state.lastExportPath ? ` · ${state.lastExportPath}` : ''}`, { dim: true });

  const body = { row: content.row + headerRows + 1, col: content.col, width: content.width, height: Math.max(0, content.height - headerRows - 1) };
  const cols = draw.columns(body, [3, 5, 4]);
  const configRect = cols[0];
  const assembledRect = cols[1];
  const inspectorRect = cols[2];

  // Left column — config summary.
  draw.box(configRect, 'CONFIG');
  let row = configRect.row + 1;
  const configLines = [
    `kind: ${state.config.kind}`,
    `mode: ${state.config.mode}`,
    `lifecycle: ${state.config.lifecycle}`,
    `has manager: ${state.config.hasManager ? 'yes' : 'no'}`,
    `node: ${state.config.node || 'none'}`,
  ];
  for (const line of configLines) {
    if (row >= configRect.row + configRect.height - 1) break;
    draw.text(row++, configRect.col + 1, clip(line, configRect.width - 2), { fg: '90' });
  }
  row++;
  draw.text(row++, configRect.col + 1, 'compare:', { bold: true });
  const compare = state.compareConfig || state.config;
  for (const line of [
    `kind: ${compare.kind}`,
    `mode: ${compare.mode}`,
    `lifecycle: ${compare.lifecycle}`,
    `has manager: ${compare.hasManager ? 'yes' : 'no'}`,
    `node: ${compare.node || 'none'}`,
  ]) {
    if (row >= configRect.row + configRect.height - 1) break;
    draw.text(row++, configRect.col + 1, clip(line, configRect.width - 2), { fg: '90' });
  }

  // Center column — assembled.
  draw.box(assembledRect, state.viewMode === 'raw' ? 'ASSEMBLED · RAW' : 'ASSEMBLED · LAYERED');
  const inner = { row: assembledRect.row + 1, col: assembledRect.col + 1, width: Math.max(0, assembledRect.width - 2), height: Math.max(0, assembledRect.height - 2) };
  if (state.viewMode === 'raw') {
    const linesOut = lines(state.assembled || '');
    for (let i = 0; i < inner.height && i < linesOut.length; i++) draw.text(inner.row + i, inner.col, clip(linesOut[i], inner.width), { fg: '90' });
  } else {
    const items = layerRows(state);
    const res = draw.list(inner, items, state.cursor, state.scroll);
    state.scroll = res.scroll;
  }
  const budget = state.totalTokens / 200000;
  const barRow = assembledRect.row + assembledRect.height - 1;
  if (barRow >= assembledRect.row) {
    draw.text(barRow, assembledRect.col + 1, `≈${fmt(state.totalTokens)} tokens / ${fmt(200000)} budget`, { dim: true });
    const w = Math.max(0, assembledRect.width - 2);
    const filled = Math.min(w, Math.max(0, Math.floor(w * budget)));
    if (w > 0) {
      draw.hline(barRow, assembledRect.col + 1, assembledRect.col + 1 + w, ' ');
      if (filled > 0) draw.hline(barRow, assembledRect.col + 1, assembledRect.col + 1 + filled, '▉');
    }
  }

  // Right column — inspector.
  draw.box(inspectorRect, 'INSPECTOR');
  const inspector = inspectorRows(state, inspectorRect.width - 2);
  const start = inspectorRect.row + 1;
  for (let i = 0; i < inspector.length && i < inspectorRect.height - 2; i++) {
    const rowItem = inspector[i];
    draw.list({ row: start + i, col: inspectorRect.col + 1, width: inspectorRect.width - 2, height: 1 }, [rowItem], 0, 0);
  }
}

export const keymap = [
  { keys: ['j', 'down'], intent: 'cursorDown', hint: { keys: 'j/k', label: 'layer' } },
  { keys: ['k', 'up'], intent: 'cursorUp' },
  { keys: ['h', 'left'], intent: 'compareCursorUp', hint: { keys: 'h/l', label: 'compare' } },
  { keys: ['l', 'right'], intent: 'compareCursorDown' },
  { keys: ['tab'], intent: 'setViewMode', payload: (s) => (s.viewMode === 'raw' ? 'layered' : 'raw'), hint: { keys: 'tab', label: 'raw/layered' } },
  { keys: ['enter', 'return'], intent: 'toggleLayerExpanded', payload: (s) => s.selectedLayerId || (s.review && s.review[s.cursor] && s.review[s.cursor].id) || '', hint: { keys: 'enter', label: 'expand' } },
  { keys: ['e'], intent: 'exportComments', hint: { keys: 'e', label: 'export' } },
  { keys: ['g'], intent: 'refresh', hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
];
