// @ts-check
/**
 * Model ladders settings — web presenter for the `settings` view.
 *
 * Mouse-first: enum fields (default provider, persona strength) are click-to-pick
 * chips that save immediately; free-text fields (matrix model ids, new persona)
 * open an inline editor prefilled with the current value, with Save/Cancel.
 *
 * @module settings/web
 */

import { Loading, NotReady, ErrorState } from '@crouton-kit/crouter/web';

/** @typedef {import('./core.mjs').SettingsState} SettingsState */

const STRENGTHS = ['ultra', 'strong', 'medium', 'light'];
const PROVIDERS = ['anthropic', 'openai'];

/** Inline editor for a free-text field (matrix model id, new persona pair). */
/** @param {{ state: SettingsState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function Editor({ state, dispatch }) {
  if (!state.edit) return null;
  return (
    <div className="rounded border border-cyan-300 bg-cyan-50 p-3">
      <div className="mb-2 text-sm text-slate-600">Editing <span className="font-semibold text-slate-900">{state.edit.label}</span></div>
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={state.edit.draft}
          placeholder={state.edit.kind === 'personaNew' ? 'kind strength' : 'model id'}
          onChange={(e) => dispatch('setDraft', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); dispatch('submitEdit'); }
            else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancelEdit'); }
          }}
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-cyan-500"
        />
        <button type="button" onClick={() => dispatch('submitEdit')} className="rounded bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700">Save</button>
        <button type="button" onClick={() => dispatch('cancelEdit')} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
      </div>
      {state.edit.kind === 'personaNew' ? <div className="mt-2 text-xs text-slate-500">Format: <code>kind strength</code> or <code>kind=strength</code> (strength = ultra·strong·medium·light).</div> : null}
    </div>
  );
}

/** A small segmented control of fixed choices that saves on click. */
/** @param {{ choices: string[], value: string, onPick: (c:string)=>void }} props */
function Segmented({ choices, value, onPick }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-slate-300">
      {choices.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className={`px-2.5 py-1 text-sm capitalize ${c === value ? 'bg-cyan-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'} ${c !== choices[0] ? 'border-l border-slate-300' : ''}`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

/** True when the editor is currently targeting this matrix cell. */
/** @param {SettingsState} state @param {string} strength @param {string} provider */
function isEditingCell(state, strength, provider) {
  return !!state.edit && state.edit.kind === 'matrixCell' && state.edit.strength === strength && state.edit.provider === provider;
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

  const ladders = state.modelLadders;
  const personas = Object.keys(state.personaStrengths).sort((a, b) => a.localeCompare(b));
  const editingPersonaNew = !!state.edit && state.edit.kind === 'personaNew';

  return (
    <div className="h-full overflow-auto text-sm">
      <div className="space-y-5 p-4">
        <div>
          <h1 className="text-base font-semibold">Model ladders</h1>
          <p className="text-xs text-slate-500">Click a model id to edit it; click a provider or strength to switch it. Changes save immediately.</p>
        </div>

        {/* Default provider — enum, click to pick. */}
        <div className="flex items-center gap-3">
          <span className="font-semibold">Default provider</span>
          <Segmented choices={PROVIDERS} value={ladders.defaultProvider ?? 'anthropic'} onPick={(p) => dispatch('applyValue', { kind: 'defaultProvider', value: p })} />
        </div>

        {/* Provider × strength matrix — each model id click-to-edit. */}
        <div className="space-y-3">
          {STRENGTHS.map((strength) => (
            <div key={strength}>
              <div className="mb-1 font-semibold capitalize">{strength}</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {PROVIDERS.map((provider) => {
                  const editing = isEditingCell(state, strength, provider);
                  if (editing) {
                    return (
                      <div key={provider} className="rounded border border-cyan-300 bg-cyan-50 p-2">
                        <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">{provider}</div>
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            value={state.edit.draft}
                            onChange={(e) => dispatch('setDraft', e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); dispatch('submitEdit'); }
                              else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancelEdit'); }
                            }}
                            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm outline-none focus:border-cyan-500"
                          />
                          <button type="button" onClick={() => dispatch('submitEdit')} className="rounded bg-cyan-600 px-2 py-1 text-xs font-semibold text-white hover:bg-cyan-700">Save</button>
                          <button type="button" onClick={() => dispatch('cancelEdit')} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">Cancel</button>
                        </div>
                      </div>
                    );
                  }
                  const v = ladders[provider]?.[strength] ?? '—';
                  return (
                    <button
                      key={provider}
                      type="button"
                      title="Click to edit"
                      onClick={() => dispatch('beginEditFor', { kind: 'matrix', strength, provider })}
                      className="rounded border border-slate-200 bg-white px-2 py-1 text-left hover:border-cyan-400 hover:bg-cyan-50"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">{provider}</div>
                      <div className="truncate font-mono text-sm text-slate-800">{v}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Persona strengths — enum per persona, click to pick. */}
        <div className="space-y-2">
          <div className="font-semibold">Persona strengths</div>
          {personas.length === 0 ? <div className="text-xs text-slate-400">None set yet.</div> : null}
          {personas.map((persona) => (
            <div key={persona} className="flex items-center gap-3">
              <span className="w-40 truncate font-mono text-slate-800">{persona}</span>
              <Segmented choices={STRENGTHS} value={state.personaStrengths[persona] ?? 'strong'} onPick={(s) => dispatch('applyValue', { kind: 'personaStrength', persona, value: s })} />
            </div>
          ))}
          {editingPersonaNew ? (
            <Editor state={state} dispatch={dispatch} />
          ) : (
            <button type="button" onClick={() => dispatch('beginEditFor', { kind: 'addPersona' })} className="rounded border border-dashed border-emerald-400 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">+ add persona strength</button>
          )}
        </div>
      </div>
    </div>
  );
}
