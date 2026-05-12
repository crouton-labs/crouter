import { join } from 'node:path';
import { CONFIG_FILE, STATE_FILE, defaultScopeConfig, defaultScopeState } from '../types.js';
import type { Scope, ScopeConfig, ScopeState } from '../types.js';
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
  const skills = partial.skills === undefined ? {} : partial.skills;
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
  return { schema_version, marketplaces, plugins, skills, auto_update };
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
