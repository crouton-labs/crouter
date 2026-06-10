import { join } from 'node:path';
import { CONFIG_FILE, STATE_FILE, defaultScopeConfig, defaultScopeState, defaultCanvasNavConfig } from '../types.js';
import type { Scope, ScopeConfig, ScopeState, CanvasNavConfig, CanvasBind } from '../types.js';
import { readJsonIfExists, writeJson, ensureDir } from './fs-utils.js';
import { scopeRoot, requireScopeRoot } from './scope.js';

function configPathFor(root: string): string {
  return join(root, CONFIG_FILE);
}

function statePathFor(root: string): string {
  return join(root, STATE_FILE);
}

export function configPath(scope: Scope): string | null {
  const root = scopeRoot(scope);
  return root ? configPathFor(root) : null;
}

export function statePath(scope: Scope): string | null {
  const root = scopeRoot(scope);
  return root ? statePathFor(root) : null;
}

export function readConfig(scope: Scope): ScopeConfig {
  const root = scopeRoot(scope);
  if (!root) return defaultScopeConfig();
  const existing = readJsonIfExists<Partial<ScopeConfig>>(configPathFor(root));
  if (!existing) return defaultScopeConfig();
  return mergeConfig(existing);
}

export function readState(scope: Scope): ScopeState {
  const root = scopeRoot(scope);
  if (!root) return defaultScopeState();
  const existing = readJsonIfExists<Partial<ScopeState>>(statePathFor(root));
  if (!existing) return defaultScopeState();
  return {
    marketplaces: existing.marketplaces ?? {},
    plugins: existing.plugins ?? {},
    last_self_check: existing.last_self_check,
    bootstrap_done: existing.bootstrap_done,
  };
}

export function writeConfig(scope: Scope, config: ScopeConfig): void {
  const root = requireScopeRoot(scope);
  ensureDir(root);
  writeJson(configPathFor(root), config);
}

export function writeState(scope: Scope, state: ScopeState): void {
  const root = requireScopeRoot(scope);
  ensureDir(root);
  writeJson(statePathFor(root), state);
}

export function ensureScopeInitialized(scope: Scope, root: string): void {
  ensureDir(root);
  const cfgPath = configPathFor(root);
  if (!readJsonIfExists(cfgPath)) {
    writeJson(cfgPath, defaultScopeConfig());
  }
}

/** Deep-merge one bind table over its built-in defaults: a user adding a single
 *  bind must not wipe the rest. Each user entry is validated (a `run` string is
 *  required) before it replaces/extends a key. */
function mergeBinds(
  base: Record<string, CanvasBind>,
  over: unknown,
): Record<string, CanvasBind> {
  const out: Record<string, CanvasBind> = { ...base };
  if (over !== null && typeof over === 'object') {
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'string') {
        const b = v as CanvasBind;
        out[k] = {
          run: b.run,
          ...(b.confirm === true ? { confirm: true } : {}),
          ...(typeof b.desc === 'string' ? { desc: b.desc } : {}),
        };
      }
    }
  }
  return out;
}

/** Validate + deep-merge a user `canvasNav` block over the built-in defaults.
 *  An absent or malformed block falls back wholesale to defaults. */
function mergeCanvasNav(raw: unknown): CanvasNavConfig {
  const defaults = defaultCanvasNavConfig();
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Partial<CanvasNavConfig>;
  const prefixKey =
    typeof r.prefixKey === 'string' && r.prefixKey.trim() !== '' ? r.prefixKey : defaults.prefixKey;
  return {
    prefixKey,
    prefixBinds: mergeBinds(defaults.prefixBinds, r.prefixBinds),
    graphBinds: mergeBinds(defaults.graphBinds, r.graphBinds),
  };
}

function normalizeMode(value: unknown, fallback: ScopeConfig['auto_update']['crtr']): ScopeConfig['auto_update']['crtr'] {
  if (value === true) return 'notify';
  if (value === false) return false;
  if (value === 'notify' || value === 'apply') return value;
  return fallback;
}

function mergeConfig(partial: Partial<ScopeConfig>): ScopeConfig {
  const defaults = defaultScopeConfig();
  const schema_version =
    partial.schema_version === undefined ? defaults.schema_version : partial.schema_version;
  const marketplaces = partial.marketplaces === undefined ? {} : partial.marketplaces;
  const plugins = partial.plugins === undefined ? {} : partial.plugins;
  const au = partial.auto_update as Partial<Record<keyof ScopeConfig['auto_update'], unknown>> | undefined;
  const rawInterval = au && typeof au.interval_hours === 'number' ? au.interval_hours : undefined;
  const interval_hours =
    rawInterval !== undefined && Number.isFinite(rawInterval) && rawInterval >= 0
      ? rawInterval
      : defaults.auto_update.interval_hours;
  const auto_update = {
    crtr: normalizeMode(au?.crtr, defaults.auto_update.crtr),
    content: normalizeMode(au?.content, defaults.auto_update.content),
    interval_hours,
  };
  const rawMaxPanes = partial.max_panes_per_window;
  const max_panes_per_window =
    typeof rawMaxPanes === 'number' && Number.isFinite(rawMaxPanes) && rawMaxPanes >= 1
      ? Math.floor(rawMaxPanes)
      : defaults.max_panes_per_window;
  const canvasNav = mergeCanvasNav(partial.canvasNav);
  // The merge drops unknown keys, so `headless` must be carried explicitly or it
  // is lost on every read-modify-write of config.json.
  const headless = typeof partial.headless === 'boolean' ? partial.headless : defaults.headless;
  return { schema_version, marketplaces, plugins, auto_update, max_panes_per_window, canvasNav, headless };
}

export function updateConfig(scope: Scope, mutate: (cfg: ScopeConfig) => void): ScopeConfig {
  const cfg = readConfig(scope);
  mutate(cfg);
  writeConfig(scope, cfg);
  return cfg;
}

export function updateState(scope: Scope, mutate: (s: ScopeState) => void): ScopeState {
  const s = readState(scope);
  mutate(s);
  writeState(scope, s);
  return s;
}
