// @ts-check
/**
 * Workspace Sidebar — the WEB presenter for the `workspace-sidebar` view (React
 * + Tailwind). Browser-only: consumed solely by the web serve path (Vite owns
 * JSX + Tailwind); NEVER Node-imported. The default export is a pure function of
 * `state`; DOM events call `dispatch(intentName, payload?)`.
 *
 * Same logical model as the TUI presenter (`state.rows` + `state.cursor`) read
 * from the SAME portable `core.mjs` — zero shared rendering code with `tui.mjs`.
 * On the web there is no chat pane to drive, so the rail renders as a plain
 * styled node list (this becomes the sidebar of the future crouter web UI): a
 * click selects a row, ↵ no-ops via the core's `open` banner. The outer chrome
 * (title / status / banner / chip) is rendered by `<ViewChrome>`, which wraps
 * this component — do NOT render it here.
 *
 * @module workspace-sidebar/web
 */

import { Loading, Empty, ErrorState, NotReady } from '@crouton-kit/crouter/web';

/** @typedef {import('./core.mjs').SidebarState} SidebarState */
/** @typedef {import('./core.mjs').RailRow} RailRow */

// ── Status vocabulary (the web analog of tui.mjs's NUMERIC-SGR maps) ──────────

const STATUS = {
  active: { glyph: '●', cls: 'text-green-600' },
  idle: { glyph: '○', cls: 'text-amber-600' },
  done: { glyph: '✓', cls: 'text-cyan-600' },
  dead: { glyph: '✗', cls: 'text-red-600' },
  canceled: { glyph: '⊘', cls: 'text-slate-400' },
};

/** @param {string} status @param {boolean} attached @returns {string} */
function nameCls(status, attached) {
  if (attached) return 'font-bold text-cyan-700';
  if (status === 'active') return 'font-semibold';
  if (status === 'done' || status === 'dead' || status === 'canceled') return 'text-slate-400';
  return '';
}

// ── Rows (the web analog of tui.mjs's rowToItem) ───────────────────────────────

/** @param {{ row: RailRow, index: number, selected: boolean, onClick: () => void }} props */
function Row({ row, selected, onClick }) {
  if (row.kind === 'header') {
    return <li className="px-2 pt-3 pb-0.5 font-semibold text-cyan-700">{row.text}</li>;
  }
  if (row.kind === 'chrome') {
    return <li className="px-2 text-slate-400">{row.text || '\u00a0'}</li>;
  }
  // row.kind === 'node'
  const st = STATUS[row.status] || { glyph: '?', cls: 'text-slate-400' };
  const base = `flex items-baseline gap-1 rounded px-2 py-0.5 cursor-pointer ${selected ? 'bg-slate-200' : 'hover:bg-slate-100'}`;
  return (
    <li className={base} onClick={onClick}>
      <span className={`w-3 shrink-0 ${row.attached ? 'font-bold text-cyan-700' : ''}`}>{row.attached ? '▸' : '\u00a0'}</span>
      {row.prefix ? <span className="whitespace-pre text-slate-400">{row.prefix}</span> : null}
      <span className={st.cls}>{st.glyph}</span>
      <span className={nameCls(row.status, row.attached)}>{row.name}</span>
      {row.asks > 0 ? <span className="ml-auto shrink-0 font-bold text-amber-500">⚑{row.asks}</span> : null}
    </li>
  );
}

// ── The view ───────────────────────────────────────────────────────────────────

/**
 * @param {import('../../core/view/contract.js').ViewProps<SidebarState>} props
 */
export default function WorkspaceSidebar({ state, dispatch }) {
  if (state.rows.length === 0) {
    // The copy comes from the typed SourceError's `display` VERBATIM (the
    // contract display/kind split — never branch on `kind`); only the four-state
    // component is a presentation map off `display.level` so the hue matches the
    // TUI (error → red ErrorState, action → amber NotReady).
    if (state.srcError) {
      const d = state.srcError.display;
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
    if (state.lastFetch === 0) return <Loading label="Loading…" />;
    return <Empty label="No agents in this cwd." />;
  }

  return (
    <ul
      className="font-mono text-sm outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'j' || e.key === 'ArrowDown') { dispatch('cursorDown'); e.preventDefault(); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { dispatch('cursorUp'); e.preventDefault(); }
        else if (e.key === 'Enter') { dispatch('open'); e.preventDefault(); }
        else if (e.key === 'g') { dispatch('refresh'); }
      }}
    >
      {state.rows.map((row, i) => (
        <Row key={i} row={row} index={i} selected={i === state.cursor} onClick={() => dispatch('select', i)} />
      ))}
    </ul>
  );
}
