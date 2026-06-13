// @ts-check
/**
 * Model ladders settings — web presenter for the `settings` view.
 *
 * @module settings/web
 */

import { Loading, NotReady, ErrorState } from '@crouton-kit/crouter/web';
import { buildRows } from './core.mjs';

/** @typedef {import('./core.mjs').SettingsState} SettingsState */

/** @param {{ state: SettingsState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function Editor({ state, dispatch }) {
  if (!state.edit) return null;
  return (
    <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-sm text-slate-600">Replacing <span className="font-semibold text-slate-900">{state.edit.label}</span> — Enter saves, Esc cancels</div>
      <div className="mb-2 text-xs text-slate-500">Current value: <span className="font-mono text-slate-700">{state.edit.value || '(empty)'}</span></div>
      <input
        autoFocus
        value={state.edit.draft}
        placeholder="Type replacement value"
        onChange={(e) => dispatch('setDraft', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); dispatch('submitEdit'); }
          else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancelEdit'); }
        }}
        className="w-full rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-cyan-500"
      />
      {state.edit.kind === 'personaNew' ? <div className="mt-2 text-xs text-slate-500">Format: <code>kind strength</code> or <code>kind=strength</code>.</div> : null}
    </div>
  );
}

/** @param {{ state: SettingsState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function MatrixRows({ state, dispatch }) {
  const rows = buildRows(state);
  return (
    <div className="space-y-2">
      {rows.map((row, idx) => {
        const selected = idx === state.cursor;
        if (row.kind === 'defaultProvider') {
          const value = state.modelLadders?.defaultProvider ?? 'anthropic';
          return (
            <button
              key="defaultProvider"
              type="button"
              onClick={() => dispatch('selectRow', { kind: 'defaultProvider' })}
              className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left ${selected ? 'bg-slate-200' : 'hover:bg-slate-100'}`}
            >
              <span className="font-semibold">Default provider</span>
              <span className="ml-auto font-mono text-cyan-700">{value}</span>
            </button>
          );
        }
        if (row.kind === 'matrix') {
          const selectedProvider = state.matrixSelection[row.strength] ?? 'anthropic';
          const a = state.modelLadders?.anthropic?.[row.strength] ?? '—';
          const o = state.modelLadders?.openai?.[row.strength] ?? '—';
          return (
            <div key={row.strength} className={`rounded px-3 py-2 ${selected ? 'bg-slate-200' : 'hover:bg-slate-50'}`}>
              <div className="mb-1 font-semibold capitalize">{row.strength}</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => dispatch('selectRow', { kind: 'matrix', strength: row.strength, provider: 'anthropic' })}
                  className={`rounded border px-2 py-1 text-left font-mono text-sm ${selectedProvider === 'anthropic' ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200 bg-white'}`}
                >
                  <div className="text-xs uppercase tracking-wide text-slate-400">anthropic</div>
                  <div className="truncate">{a}</div>
                </button>
                <button
                  type="button"
                  onClick={() => dispatch('selectRow', { kind: 'matrix', strength: row.strength, provider: 'openai' })}
                  className={`rounded border px-2 py-1 text-left font-mono text-sm ${selectedProvider === 'openai' ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200 bg-white'}`}
                >
                  <div className="text-xs uppercase tracking-wide text-slate-400">openai</div>
                  <div className="truncate">{o}</div>
                </button>
              </div>
            </div>
          );
        }
        if (row.kind === 'persona') {
          return (
            <button
              key={row.persona}
              type="button"
              onClick={() => dispatch('selectRow', { kind: 'persona', persona: row.persona })}
              className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left ${selected ? 'bg-slate-200' : 'hover:bg-slate-100'}`}
            >
              <span className="font-semibold">{row.persona}</span>
              <span className="ml-auto font-mono text-amber-600">{state.personaStrengths[row.persona] ?? 'strong'}</span>
            </button>
          );
        }
        return (
          <button
            key="addPersona"
            type="button"
            onClick={() => dispatch('selectRow', { kind: 'addPersona' })}
            className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left ${selected ? 'bg-slate-200' : 'hover:bg-slate-100'}`}
          >
            <span className="font-semibold text-emerald-700">+ add persona strength</span>
            <span className="ml-auto text-xs text-slate-400">kind strength</span>
          </button>
        );
      })}
    </div>
  );
}

/** @param {import('../../core/view/contract.js').ViewProps<SettingsState>} props */
export default function Settings({ state, dispatch }) {
  if (state.sourceError && state.modelLadders === null) {
    const d = state.sourceError.display;
    const Comp = d.level === 'error' ? ErrorState : NotReady;
    return <Comp headline={d.headline} explanation={d.explanation} nextStep={d.nextStep || undefined} onRetry={() => dispatch('refresh')} />;
  }
  if (state.modelLadders === null) {
    return <Loading label="Loading model ladders…" />;
  }

  return (
    <div className="h-full overflow-auto font-mono text-sm outline-none" tabIndex={0} onKeyDown={(e) => {
      if (state.edit) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); dispatch('cursorDown'); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); dispatch('cursorUp'); }
      else if (e.key === 'h' || e.key === 'ArrowLeft') { e.preventDefault(); dispatch('matrixLeft'); }
      else if (e.key === 'l' || e.key === 'ArrowRight') { e.preventDefault(); dispatch('matrixRight'); }
      else if (e.key === 'Enter') { e.preventDefault(); dispatch('beginEdit'); }
      else if (e.key === 'n') { e.preventDefault(); dispatch('jumpAddPersona'); }
      else if (e.key === 'g') { dispatch('refresh'); }
    }}>
      <div className="space-y-4 p-4">
        <div>
          <h1 className="text-base font-semibold">Model ladders</h1>
          <p className="text-xs text-slate-500">Provider × strength matrix plus personaStrengths.</p>
        </div>
        <Editor state={state} dispatch={dispatch} />
        <MatrixRows state={state} dispatch={dispatch} />
        <div className="pt-2 text-xs text-slate-500">Enter edits the selected row; the matrix cells and persona strengths are written with crtr commands.</div>
      </div>
    </div>
  );
}
