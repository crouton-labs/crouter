// @ts-check
/**
 * Git / PR board — the WEB presenter for the `git-pr` view (React + Tailwind).
 * Browser-only: consumed solely by the web serve path (Vite owns JSX +
 * Tailwind); NEVER Node-imported. The default export is a pure function of
 * `state`; DOM events call `dispatch(intentName, payload?)`.
 *
 * Same logical model as the TUI presenter (`state.board` + `state.cursor`) read
 * from the SAME portable `core.mjs` — zero shared rendering code with `tui.mjs`
 * (the contract's accepted hard fork: `draw.*` has no web analog). The outer
 * chrome (title / status / banner / state chip) is rendered by `<ViewChrome>`,
 * which wraps this component — so do NOT render it here.
 *
 * @module git-pr/web
 */

import { relAge } from './core.mjs';
import { Loading, NotReady, ErrorState, Empty } from '@crouton-kit/crouter/web';

/** @typedef {import('./core.mjs').GitPrState} GitPrState */

// ── Status vocabulary (the web analog of tui.mjs's NUMERIC-SGR maps) ──────────

const FILE_GLYPH = {
  staged: { glyph: '●', cls: 'text-green-600' },
  modified: { glyph: '○', cls: 'text-amber-600' },
  untracked: { glyph: '?', cls: 'text-slate-400' },
  conflict: { glyph: '✗', cls: 'text-red-600' },
};
const REVIEW = {
  approved: { glyph: '✓', cls: 'text-green-600' },
  changes: { glyph: '✗', cls: 'text-red-600' },
  review: { glyph: '◌', cls: 'text-slate-400' },
};
const CI = {
  pass: { glyph: '✓', cls: 'text-green-600' },
  fail: { glyph: '✗', cls: 'text-red-600' },
  pending: { glyph: '⟳', cls: 'text-amber-600' },
  none: { glyph: '·', cls: 'text-slate-400' },
};

// ── Header gauges (the web analog of tui.mjs's drawHeader) ─────────────────────

/** @param {{ g: import('./core.mjs').GitState }} props */
function Header({ g }) {
  const now = Date.now();
  return (
    <div className="border-b border-slate-200 pb-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-cyan-700">⎇ {g.branch}</span>
        {g.upstream ? (
          <span className="text-slate-400">
            → {g.upstream}
            {g.ahead ? <span className="ml-1 text-green-600">↑{g.ahead}</span> : null}
            {g.behind ? <span className="ml-1 text-amber-600">↓{g.behind}</span> : null}
            {!g.ahead && !g.behind ? <span className="ml-1 text-green-600">✓ up to date</span> : null}
          </span>
        ) : (
          <span className="text-slate-400">· no upstream</span>
        )}
        <span className="ml-auto">{treeChip(g)}</span>
      </div>
      <div className="mt-0.5 text-slate-600">
        {g.lastCommit ? (
          <span className="flex items-baseline gap-2">
            <span className="text-slate-400">⊙</span>
            <span className="text-amber-600">{g.lastCommit.sha}</span>
            <span className="truncate">{g.lastCommit.subject}</span>
            <span className="ml-auto shrink-0 text-slate-400">{relAge(g.lastCommit.when, now)}</span>
          </span>
        ) : (
          <span className="text-slate-400">⊙ no commits yet</span>
        )}
      </div>
    </div>
  );
}

/** @param {import('./core.mjs').GitState} g */
function treeChip(g) {
  if (g.files.length === 0) return <span className="text-green-600">✓ clean</span>;
  const c = g.counts;
  /** @type {Array<{n:number, word:string, glyph:string, cls:string}>} */
  const segs = [
    { n: c.conflict, word: 'conflict', glyph: '✗', cls: 'text-red-600' },
    { n: c.staged, word: 'staged', glyph: '●', cls: 'text-green-600' },
    { n: c.modified, word: 'modified', glyph: '○', cls: 'text-amber-600' },
    { n: c.untracked, word: 'untracked', glyph: '?', cls: 'text-slate-400' },
  ].filter((s) => s.n);
  return (
    <span className="flex gap-3">
      {segs.map((s, i) => (
        <span key={i} className={s.cls}>{s.glyph} {s.n} {s.word}</span>
      ))}
    </span>
  );
}

// ── Board rows (the web analog of tui.mjs's rowToItem) ─────────────────────────

/** @param {{ row: import('./core.mjs').BoardRow, selected: boolean, onClick: () => void }} props */
function BoardRow({ row, selected, onClick }) {
  const now = Date.now();
  const base = `flex items-baseline gap-1.5 rounded px-2 py-0.5 ${selected ? 'bg-slate-200' : ''}`;

  if (row.kind === 'label') {
    return <li className="px-2 pt-2 pb-0.5 text-xs uppercase tracking-wide text-slate-400">{row.text}</li>;
  }
  if (row.kind === 'spacer') {
    return <li className="h-2" aria-hidden />;
  }
  if (row.kind === 'clean') {
    return (
      <li className={base} onClick={onClick}>
        <span className="text-green-600">✓</span>
        <span className="text-slate-400">nothing to commit, working tree clean</span>
      </li>
    );
  }
  if (row.kind === 'note') {
    return (
      <li className={base} onClick={onClick}>
        <span className="text-slate-400">·</span>
        <span className="text-slate-400">{row.text}</span>
      </li>
    );
  }
  if (row.kind === 'file') {
    const f = row.file;
    const g = FILE_GLYPH[f.cls] || FILE_GLYPH.modified;
    return (
      <li className={base} onClick={onClick}>
        <span className={g.cls}>{g.glyph}</span>
        <span className="text-slate-400">{f.xy.replace(/ /g, '·')}</span>
        <span className={f.cls === 'conflict' ? 'text-red-600' : ''}>{f.path}</span>
        {f.add || f.del ? (
          <span className="ml-auto shrink-0 text-slate-400">+{f.add} −{f.del}</span>
        ) : null}
      </li>
    );
  }
  // row.kind === 'pr'
  const pr = row.pr;
  const rv = REVIEW[pr.review] || REVIEW.review;
  const ci = CI[pr.ci] || CI.none;
  const age = relAge(pr.updatedAt, now);
  return (
    <li className={base} onClick={onClick}>
      <span className={`text-cyan-700 ${pr.current ? 'font-bold' : ''}`}>#{pr.number}</span>
      <span className={pr.isDraft ? 'text-slate-400' : ''}>{pr.title}</span>
      {pr.isDraft ? <span className="text-slate-400">(draft)</span> : null}
      <span className="ml-auto flex shrink-0 items-baseline gap-2">
        <span className={rv.cls}>{rv.glyph}</span>
        <span className={ci.cls}>{ci.glyph}</span>
        {age ? <span className="text-slate-400">{age}</span> : null}
      </span>
    </li>
  );
}

// ── The view ───────────────────────────────────────────────────────────────────

/**
 * @param {import('../../core/view/contract.js').ViewProps<GitPrState>} props
 */
export default function GitPr({ state, dispatch }) {
  // ── Whole-view takeovers (no git data to anchor a header). The copy comes
  //    from the typed SourceError's `display` VERBATIM (the contract display/kind
  //    split — we never branch on `kind`); only the four-state component is a
  //    presentation map off `display.level` so the hue matches the TUI (error →
  //    red ErrorState, action → amber NotReady). ──
  if (!state.git) {
    if (state.gitErr) {
      const d = state.gitErr.display;
      const Takeover = d.level === 'error' ? ErrorState : NotReady;
      return (
        <Takeover
          headline={d.headline}
          explanation={d.explanation}
          nextStep={d.nextStep}
          onRetry={() => dispatch('refresh')}
        />
      );
    }
    // No error yet → first-load loading state.
    return <Loading label="Reading git…" />;
  }

  const g = state.git;

  // ── Empty reward: clean tree + no open PRs + gh healthy → "All clear". ──
  const allClear = g.files.length === 0 && state.prs.length === 0 && !state.prNote;

  return (
    <div
      className="font-mono text-sm outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'j' || e.key === 'ArrowDown') { dispatch('cursorDown'); e.preventDefault(); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { dispatch('cursorUp'); e.preventDefault(); }
        else if (e.key === 'g') { dispatch('refresh'); }
      }}
    >
      <Header g={g} />
      {allClear ? (
        <Empty label={`${g.branch} — clean working tree, no open PRs.`} />
      ) : (
        <ul className="mt-1">
          {state.board.map((row, i) => (
            <BoardRow key={i} row={row} selected={i === state.cursor} onClick={() => dispatch('select', i)} />
          ))}
        </ul>
      )}
    </div>
  );
}
