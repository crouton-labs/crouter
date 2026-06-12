// @ts-check
/**
 * Canvas Dashboard — the WEB presenter for the `canvas` view (React + Tailwind).
 * Browser-only: consumed solely by the web serve path (Vite owns JSX +
 * Tailwind); NEVER Node-imported. The default export is a pure function of
 * `state`; DOM events call `dispatch(intentName, payload?)`.
 *
 * Same logical model as the TUI presenter (`state.rows` + `state.cursor`) read
 * from the SAME portable `core.mjs` — zero shared rendering code with `tui.mjs`
 * (the contract's accepted hard fork: `draw.*` has no web analog). The ASCII
 * forest becomes a DOM tree, but the branch-prefix art is preserved verbatim in
 * a monospace column so the hierarchy reads identically. The outer chrome (title
 * / status / banner / state chip) is rendered by `<ViewChrome>`, which wraps this
 * component — so do NOT render it here.
 *
 * VISUAL LANGUAGE (the web analog of tui.mjs's NUMERIC-SGR maps): the status hue
 * matches `canvas browse`'s palette (active=green, idle=amber, done=cyan,
 * dead=red, canceled=slate); live work LEADS in bold, terminal nodes recede;
 * the ⚑N attention flag is bright yellow.
 *
 * @module canvas/web
 */

import { relAge } from './core.mjs';
import { Loading, Empty, ErrorState, NotReady } from '@crouton-kit/crouter/web';

/** @typedef {import('./core.mjs').CanvasState} CanvasState */
/** @typedef {import('./core.mjs').TreeRow} TreeRow */

// ── Status vocabulary (the web analog of tui.mjs's STATUS_FG / nameStyle) ──────

/** @type {Record<string,string>} */
const STATUS_CLS = {
  active: 'text-green-600',
  idle: 'text-amber-600',
  done: 'text-cyan-700',
  dead: 'text-red-600',
  canceled: 'text-slate-400',
};

/** @param {string} status @returns {string} */
function nameCls(status) {
  if (status === 'active') return 'font-bold';
  if (status === 'done' || status === 'dead' || status === 'canceled') return 'text-slate-400';
  return '';
}

// ── Tree rows (the web analog of tui.mjs's rowToItem) ──────────────────────────

/** @param {{ row: TreeRow, selected: boolean, onClick: () => void }} props */
function TreeRowItem({ row, selected, onClick }) {
  const now = Date.now();
  const age = relAge(row.created, now);
  return (
    <li
      className={`flex items-baseline gap-1.5 rounded px-2 py-0.5 ${selected ? 'bg-slate-200' : ''}`}
      onClick={onClick}
    >
      {row.prefix ? <span className="whitespace-pre text-slate-400">{row.prefix}</span> : null}
      <span className={STATUS_CLS[row.status] || 'text-slate-400'}>{row.glyph}</span>
      <span className={nameCls(row.status)}>{row.name}</span>
      <span className="text-slate-400">[{row.kind}/{row.mode}]</span>
      {row.blocked ? <span className="font-bold text-yellow-500">⚑{row.askCount}</span> : null}
      {age ? <span className="ml-auto shrink-0 text-slate-400">{age}</span> : null}
    </li>
  );
}

// ── The view ───────────────────────────────────────────────────────────────────

/**
 * @param {import('../../core/view/contract.js').ViewProps<CanvasState>} props
 */
export default function Canvas({ state, dispatch }) {
  // ── Whole-view takeovers (no forest to render). When the data source is down
  //    and there is nothing to keep, the copy comes from the typed SourceError's
  //    `display` VERBATIM (the contract display/kind split — we never branch on
  //    `kind`); only the four-state component is a presentation map off
  //    `display.level` so the hue matches the TUI (error → red ErrorState,
  //    action → amber NotReady). ──
  if (state.rows.length === 0) {
    if (state.sourceError) {
      const d = state.sourceError.display;
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
    if (state.lastFetch === 0) {
      return <Loading label="Loading the canvas…" />;
    }
    if (state.totalNodes === 0) {
      return <Empty label="No nodes on the canvas — spawn one with `crtr node new`." />;
    }
    return <Empty label={`All caught up — ${state.totalNodes} node${state.totalNodes === 1 ? '' : 's'} finished, none active.`} />;
  }

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
      <ul>
        {state.rows.map((row, i) => (
          <TreeRowItem key={row.nodeId || i} row={row} selected={i === state.cursor} onClick={() => dispatch('activate', { nodeId: row.nodeId })} />
        ))}
      </ul>
    </div>
  );
}
