import { defineBranch, defineLeaf } from '../../core/command.js';
import { readConfig, writeConfig, configPath as coreConfigPath } from '../../core/config.js';
import { usage, notFound } from '../../core/errors.js';
import { scopeRoot, listScopes } from '../../core/scope.js';
import { resolveScope } from './shared.js';
import type { Scope, ScopeConfig, AutoUpdateConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Config helpers (ported from commands/config.ts)
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'auto_update',
  'marketplaces',
  'plugins',
  'max_panes_per_window',
]);

function getNestedValue(obj: ScopeConfig, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseConfigValue(raw: string): boolean | number | string {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function setNestedValue(cfg: ScopeConfig, key: string, value: unknown): void {
  const parts = key.split('.');
  const topKey = parts[0];

  if (!TOP_LEVEL_KEYS.has(topKey)) {
    throw usage(`unknown config key: ${topKey} (expected: ${[...TOP_LEVEL_KEYS].join('|')})`);
  }

  if (key === 'auto_update.content') {
    if (value !== 'notify' && value !== 'apply' && value !== false) {
      throw usage(`auto_update.content must be 'notify', 'apply', or false`);
    }
    cfg.auto_update.content = value as AutoUpdateConfig['content'];
    return;
  }

  if (key === 'auto_update.crtr') {
    const coerced = value === true ? 'notify' : value;
    if (coerced !== 'notify' && coerced !== 'apply' && coerced !== false) {
      throw usage(`auto_update.crtr must be 'notify', 'apply', or false`);
    }
    cfg.auto_update.crtr = coerced as AutoUpdateConfig['crtr'];
    return;
  }

  if (key === 'max_panes_per_window') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      throw usage(`max_panes_per_window must be an integer >= 1`);
    }
    cfg.max_panes_per_window = Math.floor(value);
    return;
  }

  if (parts.length === 1) {
    (cfg as unknown as Record<string, unknown>)[topKey] = value;
    return;
  }

  if (parts.length === 2 && topKey === 'auto_update') {
    const subKey = parts[1];
    (cfg.auto_update as unknown as Record<string, unknown>)[subKey] = value;
    return;
  }

  throw usage(`unsupported key path for set: ${key}`);
}

// ---------------------------------------------------------------------------
// Leaf definitions
// ---------------------------------------------------------------------------

const configGet = defineLeaf({
  name: 'get',
  help: {
    name: 'sys config get',
    summary: 'read a config value by dotted key',
    params: [
      { kind: 'positional', name: 'key', type: 'string', required: true, constraint: 'Dotted key path. Top-level keys: auto_update, marketplaces, plugins, max_panes_per_window.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Scope to read from. Default: user.' },
    ],
    output: [
      { name: 'key', type: 'string', required: true, constraint: 'Echo of input key.' },
      { name: 'value', type: 'unknown', required: true, constraint: 'The resolved value. Type depends on the key.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the value was read from.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const key = input['key'] as string;
    const scope = resolveScope(input['scope'] as string | undefined);
    const cfg = readConfig(scope);
    const value = getNestedValue(cfg, key);
    if (value === undefined) {
      throw notFound(`config key not found: ${key}`);
    }
    return { key, value: value as Record<string, unknown> | string | number | boolean, scope };
  },
});

const configSet = defineLeaf({
  name: 'set',
  help: {
    name: 'sys config set',
    summary: 'write a config value by dotted key',
    params: [
      { kind: 'positional', name: 'key', type: 'string', required: true, constraint: 'Dotted key path. Supported: auto_update.crtr, auto_update.content, auto_update.interval_hours, max_panes_per_window.' },
      { kind: 'flag', name: 'value', type: 'string', required: true, constraint: 'value VALUE — string, required. Stored as-is if quoted; coerced to number or boolean when unambiguous.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Scope to write to. Default: user.' },
    ],
    output: [
      { name: 'key', type: 'string', required: true, constraint: 'Echo of input key.' },
      { name: 'value', type: 'unknown', required: true, constraint: 'Value as written.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the value was written to.' },
    ],
    outputKind: 'object',
    effects: ['Writes the updated value to config.json in the target scope.'],
  },
  run: async (input) => {
    const key = input['key'] as string;
    const rawValue = input['value'] as string;
    const scope = resolveScope(input['scope'] as string | undefined);

    // Flags are stringly-typed; coerce to number or boolean when unambiguous
    const parsed: boolean | number | string = parseConfigValue(rawValue);

    const cfg = readConfig(scope);
    setNestedValue(cfg, key, parsed);
    writeConfig(scope, cfg);

    // Read back the written value for echo
    const written = getNestedValue(cfg, key);
    return { key, value: written as Record<string, unknown> | string | number | boolean, scope };
  },
});

const configPath = defineLeaf({
  name: 'path',
  help: {
    name: 'sys config path',
    summary: 'print absolute path(s) to config.json',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Scope to show paths for. Default: all.' },
    ],
    output: [
      { name: 'paths', type: 'object[]', required: true, constraint: 'Each: {scope, path}. Only includes scopes that have a config file.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeArg = input['scope'] as string | undefined;
    // Resolve 'all' or undefined → all writable scopes
    let scopes: Scope[];
    if (scopeArg === undefined || scopeArg === 'all') {
      scopes = listScopes(undefined);
    } else {
      scopes = listScopes(scopeArg);
    }

    const paths = scopes
      .map((s) => {
        const root = scopeRoot(s);
        if (!root) return null;
        const p = coreConfigPath(s);
        if (!p) return null;
        return { scope: s, path: p };
      })
      .filter((x): x is { scope: Scope; path: string } => x !== null);

    return { paths };
  },
});

export const configBranch = defineBranch({
  name: 'config',
  help: {
    name: 'sys config',
    summary: 'read and write crtr configuration',
    children: [
      { name: 'get', desc: 'read a config value by key', useWhen: 'inspecting current configuration' },
      { name: 'set', desc: 'write a config value by key', useWhen: 'changing a configuration setting' },
      { name: 'path', desc: 'print path(s) to config.json', useWhen: 'locating the config file for manual inspection' },
    ],
  },
  children: [configGet, configSet, configPath],
});
