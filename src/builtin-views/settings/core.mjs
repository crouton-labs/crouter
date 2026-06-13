// @ts-check
/**
 * Model ladders settings — portable core for the `settings` view.
 *
 * Reads/writes go through crtr commands (`sys config get` / `sys config set`)
 * so both targets use the existing /__crtr/source bridge.
 *
 * @module settings/core
 */

/** @typedef {import('../../core/view/contract.js').SourceError} SourceError */
/** @typedef {import('../../core/view/contract.js').IntentCtx<SettingsState>} Ctx */
/** @typedef {import('../../types.js').ModelLaddersConfig} ModelLaddersConfig */
/** @typedef {import('../../types.js').ModelStrength} ModelStrength */
/** @typedef {import('../../types.js').ModelProvider} ModelProvider */

const USER_SCOPE = 'user';
const STRENGTHS = ['ultra', 'strong', 'medium', 'light'];
/** @type {Record<ModelStrength, ModelProvider>} */
const DEFAULT_MATRIX_SELECTION = { ultra: 'anthropic', strong: 'anthropic', medium: 'anthropic', light: 'anthropic' };

/** @template T @param {T} data @returns {{ok:true, data:T}} */
function ok(data) { return { ok: true, data }; }
/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) { return { ok: false, error }; }

/** @param {unknown} v @returns {string} */
function str(v) { return v == null ? '' : String(v); }

/** @param {string} msg @param {SourceError['display']['level']} [level='error'] @returns {SourceError} */
function settingsError(msg, level = 'error') {
  return {
    kind: 'settings-config',
    display: {
      headline: 'Settings unavailable',
      explanation: msg,
      nextStep: 'Press g to retry.',
      level,
      blocking: level === 'error',
    },
  };
}

/** @param {string} key @returns {import('../../core/view/contract.js').Source<unknown>} */
function makeConfigGetSource(key) {
  return {
    id: `config-get-${key}`,
    request: () => ({ kind: 'exec', bin: 'crtr', args: ['sys', 'config', 'get', key, '--scope', USER_SCOPE, '--json'] }),
    parse: (raw) => {
      if (!raw.ok || raw.exitCode !== 0) return fail(settingsError(str(raw.stderr || raw.stdout || `crtr sys config get ${key} failed`)));
      let data;
      try {
        data = JSON.parse(String(raw.stdout || '').trim() || '{}');
      } catch {
        return fail(settingsError(`could not parse crtr sys config get ${key} output as JSON`));
      }
      if (!data || typeof data !== 'object' || !('value' in data)) {
        return fail(settingsError(`unexpected response from crtr sys config get ${key}`));
      }
      return ok(/** @type {unknown} */ (data).value);
    },
  };
}

/** @param {string} key @param {string} value @returns {import('../../core/view/contract.js').Command<unknown>} */
function makeConfigSetCommand(key, value) {
  return {
    id: `config-set-${key}`,
    request: () => ({ kind: 'exec', bin: 'crtr', args: ['sys', 'config', 'set', key, '--value', value, '--scope', USER_SCOPE, '--json'] }),
    parse: (raw) => {
      if (!raw.ok || raw.exitCode !== 0) return fail(settingsError(str(raw.stderr || raw.stdout || `crtr sys config set ${key} failed`), 'error'));
      let data;
      try {
        data = JSON.parse(String(raw.stdout || '').trim() || '{}');
      } catch {
        return fail(settingsError(`could not parse crtr sys config set ${key} output as JSON`));
      }
      if (!data || typeof data !== 'object' || !('value' in data)) {
        return fail(settingsError(`unexpected response from crtr sys config set ${key}`));
      }
      return ok(/** @type {unknown} */ (data).value);
    },
  };
}

/** @typedef {{ kind:'defaultProvider' } | { kind:'matrix'; strength:ModelStrength } | { kind:'persona'; persona:string } | { kind:'addPersona' }} Row */

/** @typedef {Object} EditState
 * @property {'defaultProvider'|'matrixCell'|'personaStrength'|'personaNew'} kind
 * @property {string} draft
 * @property {string} value
 * @property {string} label
 * @property {ModelStrength} [strength]
 * @property {ModelProvider} [provider]
 * @property {string} [persona]
 */

/** @typedef {Object} SettingsState
 * @property {ModelLaddersConfig|null} modelLadders
 * @property {Record<string, ModelStrength>} personaStrengths
 * @property {Record<ModelStrength, ModelProvider>} matrixSelection
 * @property {number} cursor
 * @property {number} scroll
 * @property {number} lastFetch
 * @property {SourceError|null} sourceError
 * @property {EditState|null} edit
 */

/** @param {SettingsState} state @returns {Row[]} */
export function buildRows(state) {
  if (!state.modelLadders) return [];
  const rows = [{ kind: 'defaultProvider' }];
  for (const strength of STRENGTHS) rows.push({ kind: 'matrix', strength });
  for (const persona of Object.keys(state.personaStrengths).sort((a, b) => a.localeCompare(b))) rows.push({ kind: 'persona', persona });
  rows.push({ kind: 'addPersona' });
  return rows;
}

/** @param {SettingsState} state @returns {number} */
function cursorClamp(state) {
  const rows = buildRows(state);
  return rows.length === 0 ? 0 : Math.min(state.cursor, rows.length - 1);
}

/** @param {SettingsState} state @returns {Row|undefined} */
function currentRow(state) {
  return buildRows(state)[cursorClamp(state)];
}

/** @param {SettingsState} state @param {Row|undefined} row @returns {string} */
export function settingsRowLabel(state, row) {
  if (!row) return '';
  if (row.kind === 'defaultProvider') return 'Default provider';
  if (row.kind === 'matrix') return `${row.strength} strength`;
  if (row.kind === 'persona') return row.persona;
  return 'Add persona strength';
}

/** @param {string} draft @returns {ModelStrength | null} */
function parseStrength(draft) {
  const s = draft.trim();
  return s === 'ultra' || s === 'strong' || s === 'medium' || s === 'light' ? s : null;
}

/** @param {string} draft @returns {{persona:string, strength:ModelStrength}|null} */
function parsePersonaPair(draft) {
  const s = draft.trim();
  if (!s) return null;
  const eq = s.indexOf('=');
  if (eq > 0) {
    const persona = s.slice(0, eq).trim();
    const strength = parseStrength(s.slice(eq + 1));
    return persona && strength ? { persona, strength } : null;
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const strength = parseStrength(parts[parts.length - 1] || '');
    const persona = parts.slice(0, -1).join(' ').trim();
    return persona && strength ? { persona, strength } : null;
  }
  return null;
}

/** @param {SettingsState} state @param {Row} row @returns {{ kind:'defaultProvider'|'matrixCell'|'personaStrength'|'personaNew', draft:string, value:string, label:string, strength?:ModelStrength, provider?:ModelProvider, persona?:string }} */
export function settingsTargetForRow(state, row) {
  if (row.kind === 'defaultProvider') {
    return { kind: 'defaultProvider', draft: '', value: state.modelLadders?.defaultProvider ?? 'anthropic', label: 'default provider' };
  }
  if (row.kind === 'matrix') {
    const provider = state.matrixSelection[row.strength] ?? DEFAULT_MATRIX_SELECTION[row.strength];
    return {
      kind: 'matrixCell',
      strength: row.strength,
      provider,
      draft: '',
      value: state.modelLadders?.[provider]?.[row.strength] ?? '',
      label: `${provider} / ${row.strength}`,
    };
  }
  if (row.kind === 'persona') {
    return { kind: 'personaStrength', persona: row.persona, draft: '', value: state.personaStrengths[row.persona] ?? 'strong', label: row.persona };
  }
  return { kind: 'personaNew', draft: '', value: '', label: 'new persona strength' };
}

/** @param {Ctx} ctx @returns {Promise<{ok:true, data:{ladders: ModelLaddersConfig, personaStrengths: Record<string, ModelStrength>}} | {ok:false, error:SourceError}>} */
async function loadConfig(ctx) {
  const [ladders, personaStrengths] = await Promise.all([
    ctx.resolve(makeConfigGetSource('modelLadders')),
    ctx.resolve(makeConfigGetSource('personaStrengths')),
  ]);
  if (!ladders.ok) return ladders;
  if (!personaStrengths.ok) return personaStrengths;
  return ok({ ladders: /** @type {ModelLaddersConfig} */ (ladders.data), personaStrengths: /** @type {Record<string, ModelStrength>} */ (personaStrengths.data) });
}

/** @param {Ctx} ctx @param {string} msg @param {SourceError['display']['level']} [level='error'] */
function setBanner(ctx, msg, level = 'error') {
  if (level === 'info') ctx.signal.setStatus(msg);
  else ctx.signal.setBanner(msg, level);
}

/** @type {import('../../core/view/contract.js').ViewCore<SettingsState>} */
const core = {
  manifest: {
    id: 'settings',
    title: 'Model Ladders',
    subtitle: 'provider × strength matrix and persona strengths',
    description: 'edit model ladders and personaStrengths through crtr commands',
  },

  init() {
    return {
      modelLadders: null,
      personaStrengths: {},
      matrixSelection: { ...DEFAULT_MATRIX_SELECTION },
      cursor: 0,
      scroll: 0,
      lastFetch: 0,
      sourceError: null,
      edit: null,
    };
  },

  sources: {
    modelLadders: makeConfigGetSource('modelLadders'),
    personaStrengths: makeConfigGetSource('personaStrengths'),
  },

  intents: {
    async refresh(ctx) {
      ctx.signal.setStatus('Loading settings…');
      const r = await loadConfig(ctx);
      if (!r.ok) {
        if (ctx.state.lastFetch === 0 || ctx.state.modelLadders === null) {
          ctx.set((s) => ({ ...s, sourceError: r.error, lastFetch: Date.now() }));
        } else {
          setBanner(ctx, r.error.display.explanation || r.error.display.headline, r.error.display.level);
        }
        ctx.signal.setStatus(null);
        return;
      }
      ctx.set((s) => {
        const next = {
          ...s,
          modelLadders: r.data.ladders,
          personaStrengths: r.data.personaStrengths,
          sourceError: null,
          lastFetch: Date.now(),
        };
        return { ...next, cursor: Math.min(next.cursor, Math.max(0, buildRows(next).length - 1)) };
      });
      ctx.signal.clearBanner();
      ctx.signal.setStatus(null);
    },

    cursorDown: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.min(Math.max(0, buildRows(s).length - 1), s.cursor + 1) })),
    cursorUp: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),

    matrixLeft: (ctx) => ctx.set((s) => {
      const row = currentRow(s);
      if (!row || row.kind !== 'matrix') return s;
      return { ...s, matrixSelection: { ...s.matrixSelection, [row.strength]: 'anthropic' } };
    }),
    matrixRight: (ctx) => ctx.set((s) => {
      const row = currentRow(s);
      if (!row || row.kind !== 'matrix') return s;
      return { ...s, matrixSelection: { ...s.matrixSelection, [row.strength]: 'openai' } };
    }),

    beginEdit: (ctx) => ctx.set((s) => {
      const row = currentRow(s);
      if (!row || s.modelLadders === null) return s;
      const target = settingsTargetForRow(s, row);
      return { ...s, edit: { ...target } };
    }),

    setDraft: (ctx, draft) => ctx.set((s) => (s.edit ? { ...s, edit: { ...s.edit, draft: typeof draft === 'string' ? draft : '' } } : s)),

    cancelEdit: (ctx) => ctx.set((s) => (s.edit ? { ...s, edit: null } : s)),

    async submitEdit(ctx) {
      const edit = ctx.state.edit;
      if (!edit) return;
      const draft = edit.draft.trim();
      if (edit.kind === 'defaultProvider') {
        if (draft !== 'anthropic' && draft !== 'openai') {
          setBanner(ctx, 'default provider must be anthropic or openai', 'action');
          return;
        }
      } else if (edit.kind === 'matrixCell') {
        if (!draft) {
          setBanner(ctx, 'model id cannot be empty', 'action');
          return;
        }
      } else if (edit.kind === 'personaStrength') {
        if (!parseStrength(draft)) {
          setBanner(ctx, 'persona strength must be ultra, strong, medium, or light', 'action');
          return;
        }
      } else if (edit.kind === 'personaNew') {
        const pair = parsePersonaPair(draft);
        if (!pair) {
          setBanner(ctx, 'use "kind strength" or "kind=strength"', 'action');
          return;
        }
      }

      ctx.signal.setStatus('Saving…');
      let key = '';
      let value = '';
      if (edit.kind === 'defaultProvider') {
        key = 'modelLadders.defaultProvider';
        value = draft;
      } else if (edit.kind === 'matrixCell') {
        key = `modelLadders.${edit.provider}.${edit.strength}`;
        value = draft;
      } else if (edit.kind === 'personaStrength') {
        key = `personaStrengths.${edit.persona}`;
        value = draft;
      } else {
        const pair = parsePersonaPair(draft);
        if (!pair) return;
        key = `personaStrengths.${pair.persona}`;
        value = pair.strength;
      }

      const r = await ctx.execute(makeConfigSetCommand(key, value));
      if (!r.ok) {
        setBanner(ctx, r.error.display.explanation || r.error.display.headline, r.error.display.level);
        ctx.signal.setStatus(null);
        return;
      }
      ctx.set((s) => {
        const next = { ...s, edit: null };
        if (edit.kind === 'defaultProvider' && next.modelLadders) next.modelLadders = { ...next.modelLadders, defaultProvider: draft };
        if (edit.kind === 'matrixCell' && next.modelLadders) next.modelLadders = { ...next.modelLadders, [edit.provider]: { ...next.modelLadders[edit.provider], [edit.strength]: draft } };
        if (edit.kind === 'personaStrength') next.personaStrengths = { ...next.personaStrengths, [edit.persona]: /** @type {ModelStrength} */ (draft) };
        if (edit.kind === 'personaNew') {
          const pair = parsePersonaPair(draft);
          if (pair) next.personaStrengths = { ...next.personaStrengths, [pair.persona]: pair.strength };
        }
        return next;
      });
      ctx.signal.setStatus('Saved');
      await ctx.dispatch('refresh');
    },

    jumpAddPersona: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.max(0, buildRows(s).length - 1) })),

    selectRow: (ctx, payload) => ctx.set((s) => {
      const p = payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
      const rows = buildRows(s);
      const target = rows.findIndex((row) => {
        if (row.kind === 'defaultProvider' && p.kind === 'defaultProvider') return true;
        if (row.kind === 'matrix' && p.kind === 'matrix' && p.strength === row.strength) return true;
        if (row.kind === 'persona' && p.kind === 'persona' && p.persona === row.persona) return true;
        if (row.kind === 'addPersona' && p.kind === 'addPersona') return true;
        return false;
      });
      if (target < 0) return s;
      if (p.kind === 'matrix' && (p.provider === 'anthropic' || p.provider === 'openai') && typeof p.strength === 'string') {
        return { ...s, cursor: target, matrixSelection: { ...s.matrixSelection, [/** @type {ModelStrength} */ (p.strength)]: /** @type {ModelProvider} */ (p.provider) } };
      }
      return { ...s, cursor: target };
    }),

    quit: (ctx) => ctx.signal.quit(),
  },
};

export const configGetSource = makeConfigGetSource;
export const configSetCommand = makeConfigSetCommand;

export default core;
