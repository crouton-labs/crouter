// @ts-check
/**
 * Combined `inbox` view — the text presenter (`dump`) for the non-TTY / piped
 * path (`crtr view run inbox | cat`). Node-only, no ANSI. A plain snapshot of
 * the merged list + each down source's banner + the host's current banner.
 *
 * The pure helpers `dump` shares with the TUI (badgeFor, unreadCount, labeled,
 * relTimestamp, …) are imported from `core.mjs`.
 *
 * @module inbox/text
 */

import { badgeFor, unreadCount, labeled, relTimestamp, truncate, padEnd, SOURCES_META } from './core.mjs';

/** @typedef {import('./core.mjs').InboxState} InboxState */

const SOURCE_BY_ID = {};
for (const m of SOURCES_META) SOURCE_BY_ID[m.id] = m;

/**
 * Plain-text snapshot for the non-TTY / piped path.
 * @param {InboxState} state
 * @param {import('../../core/view/contract.js').DumpContext} [ctx]
 * @returns {string}
 */
export function dump(state, ctx) {
  const banner = ctx && ctx.banner ? ctx.banner : null;
  const sigil = (lvl) => (lvl === 'error' ? '✗' : lvl === 'action' ? '▸' : 'ℹ');
  /** @type {string[]} */
  const lines = [];
  const n = unreadCount(state);
  let head = 'Inbox';
  if (n) head += ` · ${n} unread`;
  if (state.filter !== 'all') {
    const s = SOURCE_BY_ID[state.filter];
    head += ` · ${s ? s.label : state.filter} only`;
  }
  lines.push(head, '');

  let anyDown = false;
  for (const m of SOURCES_META) {
    const e = state.banners[m.id];
    if (e && e.display) {
      anyDown = true;
      lines.push(labeled(m.label, e.display.banner));
    }
  }
  if (anyDown) lines.push('');

  if (state.rows.length === 0) {
    if (state.lastFetch === 0) lines.push('(loading…)');
    else if (!anyDown) lines.push('✓ All caught up — no messages.');
  } else {
    for (const row of state.rows) {
      const badge = padEnd(badgeFor(row.sourceId).glyph, 2);
      const dot = row.unread ? '●' : ' ';
      const snip = truncate((row.snippet || '').replace(/\s+/g, ' ').trim(), 48);
      lines.push(`[${dot}] ${badge} ${padEnd(row.name || 'Unknown', 20)} ${padEnd(snip, 48)} ${relTimestamp(row.ts)}`);
    }
  }

  if (state.openKey && state.thread) {
    lines.push('', `— ${state.thread.title} —`);
    if (state.thread.subtitle) lines.push(state.thread.subtitle);
    for (const m of state.thread.messages || []) {
      const who = m.fromMe ? 'You' : m.sender || 'Them';
      lines.push(`${who}: ${(m.text || '').replace(/\s+/g, ' ').trim()}`);
    }
  }

  if (banner) lines.push('', sigil(banner.level) + ' ' + banner.msg);
  return lines.join('\n');
}
