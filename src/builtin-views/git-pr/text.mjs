// @ts-check
/**
 * Git / PR board — the text presenter (`dump`) for the non-TTY / piped path of
 * the `git-pr` view (`crtr view run git-pr | cat`). Node-only, no ANSI. A plain
 * snapshot of the current state; the host threads its current banner via `ctx`.
 *
 * `dump` is unchanged from the pre-migration view. The pure helpers it shares
 * with the TUI (relAge, treePhrase) are imported from `core.mjs`.
 *
 * @module git-pr/text
 */

import { relAge, treePhrase } from './core.mjs';

/** @typedef {import('./core.mjs').GitPrState} GitPrState */

/**
 * Plain-text snapshot for the non-TTY / piped path.
 * @param {GitPrState} state
 * @param {import('../../core/view/contract.js').DumpContext} [ctx]
 * @returns {string}
 */
export function dump(state, ctx) {
  /** @type {string[]} */
  const lines = ['Git / PR board'];
  const banner = ctx && ctx.banner ? ctx.banner : null;
  if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
  else if (state.gitErr) lines.push('', `[${state.gitErr.display.level}] ${state.gitErr.display.explanation}`);

  const g = state.git;
  if (!g) {
    lines.push('', state.lastFetch === 0 ? '(reading git…)' : '(git unavailable)');
    return lines.join('\n');
  }

  const now = Date.now();

  // Header.
  let head = `⎇ ${g.branch}`;
  if (g.upstream) {
    head += ` → ${g.upstream}`;
    if (g.ahead) head += ` ↑${g.ahead}`;
    if (g.behind) head += ` ↓${g.behind}`;
    if (!g.ahead && !g.behind) head += ' (up to date)';
  } else {
    head += ' (no upstream)';
  }
  head += `  ·  ${treePhrase(g)}`;
  lines.push('', head);
  if (g.lastCommit) {
    lines.push(`⊙ ${g.lastCommit.sha} ${g.lastCommit.subject}  (${relAge(g.lastCommit.when, now)})`);
  } else {
    lines.push('⊙ no commits yet');
  }

  // Working tree.
  lines.push('', 'Working tree');
  if (g.files.length === 0) {
    lines.push('  ✓ nothing to commit, working tree clean');
  } else {
    for (const f of g.files) {
      const churn = f.add || f.del ? `  +${f.add} −${f.del}` : '';
      lines.push(`  ${f.xy.replace(/ /g, '·')}  ${f.path}${churn}  [${f.cls}]`);
    }
  }

  // Pull requests.
  lines.push('', 'Pull requests');
  if (state.prNote) {
    lines.push(`  · ${state.prNote}`);
  } else if (state.prs.length === 0) {
    lines.push('  · No open pull requests.');
  } else {
    for (const pr of state.prs) {
      const mark = pr.current ? '*' : ' ';
      const draft = pr.isDraft ? ' (draft)' : '';
      lines.push(
        `  ${mark}#${pr.number} ${pr.title}${draft}  [review:${pr.review} ci:${pr.ci}]  (${relAge(pr.updatedAt, now)})`
      );
    }
  }

  return lines.join('\n');
}
