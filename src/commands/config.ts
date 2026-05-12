import { Command } from 'commander';
import { readConfig, writeConfig, configPath } from '../core/config.js';
import { usage, notFound } from '../core/errors.js';
import { out, jsonOut, handleError } from '../core/output.js';
import { scopeRoot, listScopes } from '../core/scope.js';
import type { Scope, ScopeConfig, AutoUpdateConfig } from '../types.js';

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

function parseValue(raw: string): boolean | number | string {
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

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('read and write crtr configuration');

  config
    .command('get <key>')
    .description('print a config value by dotted key (default scope: user)')
    .option('--scope <scope>', 'user|project (default: user)')
    .action(async (key: string, opts: { scope?: string }) => {
      try {
        const scope: Scope = opts.scope === 'project' ? 'project' : 'user';
        const cfg = readConfig(scope);
        const value = getNestedValue(cfg, key);
        if (value === undefined) {
          throw notFound(`config key not found: ${key}`);
        }
        if (typeof value === 'object') {
          out(JSON.stringify(value));
        } else {
          out(String(value));
        }
      } catch (e) {
        handleError(e);
      }
    });

  config
    .command('set <key> <value>')
    .description('set a config value by dotted key (default scope: user)')
    .option('--scope <scope>', 'user|project (default: user)')
    .action(async (key: string, rawValue: string, opts: { scope?: string }) => {
      try {
        const scope: Scope = opts.scope === 'project' ? 'project' : 'user';
        const cfg = readConfig(scope);
        const parsed = parseValue(rawValue);
        setNestedValue(cfg, key, parsed);
        writeConfig(scope, cfg);
      } catch (e) {
        handleError(e);
      }
    });

  config
    .command('path')
    .description('print the absolute path(s) to config.json')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--json', 'emit JSON')
    .action(async (opts: { scope?: string; json?: boolean }) => {
      try {
        const scopes = listScopes(opts.scope);

        if (opts.json) {
          const paths = scopes
            .map((s) => {
              const root = scopeRoot(s);
              if (!root) return null;
              const p = configPath(s);
              if (!p) return null;
              return { scope: s, path: p };
            })
            .filter((x): x is { scope: Scope; path: string } => x !== null);
          jsonOut({ paths });
          return;
        }

        for (const s of scopes) {
          const p = configPath(s);
          if (p) {
            out(p);
          }
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });
}
