// @ts-check
/**
 * LinkedIn Messages — the text presenter (`dump`) for the non-TTY / piped path
 * (`crtr view run linkedin | cat`). Node-only, no ANSI. A plain snapshot of the
 * current state; the host threads its current banner via `ctx`. Surfaces the
 * guided recovery panel (its typed `display`) + the banner so the static path
 * shows guidance, not a blank screen.
 *
 * @module linkedin/text
 */

import { relTimestamp, truncate, padEnd, sortConvos } from './core.mjs';

/** @typedef {import('./core.mjs').LiState} LiState */

/** @param {string|string[]|null|undefined} v @returns {string[]} */
function toLinesArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s));
  return [String(v)];
}

/**
 * Plain-text snapshot for the non-TTY / piped path.
 * @param {LiState} state
 * @param {import('../../core/view/contract.js').DumpContext} [ctx]
 * @returns {string}
 */
export function dump(state, ctx) {
  const banner = ctx && ctx.banner ? ctx.banner : null;
  const sigil = (lvl) => (lvl === 'error' ? '✗' : lvl === 'action' ? '▸' : 'ℹ');
  /** @type {string[]} */
  const lines = [];
  let n = 0;
  for (const c of state.convos) if (c.unread) n++;
  lines.push('LinkedIn Messages' + (n ? ` · ${n} unread` : ''), '');

  if (state.recovery) {
    const d = state.recovery.display;
    lines.push(d.headline);
    for (const e of toLinesArr(d.explanation)) if (e) lines.push('  ' + e);
    if (d.nextStep) lines.push('  → ' + d.nextStep);
    if (banner) lines.push('  ' + sigil(banner.level) + ' ' + banner.msg);
    return lines.join('\n');
  }

  if (state.convos.length === 0) {
    if (banner) lines.push(sigil(banner.level) + ' ' + banner.msg);
    else lines.push(state.lastFetch === 0 ? '(loading…)' : '✓ All caught up — no conversations.');
  } else {
    for (const c of sortConvos(state.convos)) {
      const badge = c.unread ? '●' : ' ';
      const snip = truncate((c.lastMessage || '').replace(/\s+/g, ' ').trim(), 56);
      lines.push(`[${badge}] ${padEnd(c.name || 'Unknown', 20)} ${padEnd(snip, 56)} ${relTimestamp(c.ts)}`);
    }
  }

  if (state.openUrn && state.thread.length) {
    const convo = state.convos.find((c) => c.urn === state.openUrn);
    lines.push('', `— ${convo ? convo.name : state.openUrn} —`);
    for (const m of state.thread) {
      const who = m.fromMe ? 'You' : m.sender || 'Them';
      lines.push(`${who}: ${(m.text || '').replace(/\s+/g, ' ').trim()}`);
    }
  }

  if (banner && state.convos.length) lines.push('', sigil(banner.level) + ' ' + banner.msg);
  return lines.join('\n');
}
