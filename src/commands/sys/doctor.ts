import { join } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { readConfig, updateConfig } from '../../core/config.js';
import { scopeRoot, listScopes, marketplacesDir, pluginsDir } from '../../core/scope.js';
import { readMarketplaceManifest, readPluginManifest } from '../../core/manifest.js';
import { pathExists, listDirs, removePath } from '../../core/fs-utils.js';
import { lsRemote } from '../../core/git.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// Doctor helpers (ported from commands/doctor.ts)
// ---------------------------------------------------------------------------

type CheckStatus = 'pass' | 'fail';

/**
 * Structured fix action for a failing check. Surfaced on each
 * non-pass result so an agent reading doctor output can apply it directly
 * when `--fix` is not used (or when --fix did not auto-apply). Every
 * remediation includes absolute paths / exact keys — no inference required.
 */
interface Remediation {
  kind: 'remove_config_key' | 'rm_path';
  description: string;
  // remove_config_key
  scope?: Scope;
  configKey?: string;       // dotted path, e.g. "plugins.llm-app-authoring"
  // rm_path
  path?: string;            // absolute path to remove
}

interface CheckResult {
  scope: Scope;
  name: string;
  status: CheckStatus;
  message: string;
  fixed?: boolean;
  remediation?: Remediation;
}

function pass(scope: Scope, name: string, message: string): CheckResult {
  return { scope, name, status: 'pass', message };
}

function failCheck(scope: Scope, name: string, message: string, remediation?: Remediation): CheckResult {
  return { scope, name, status: 'fail', message, ...(remediation ? { remediation } : {}) };
}

/**
 * Apply a remediation. Returns true if applied successfully. Idempotent for
 * the supported kinds (re-applying a config-key removal that's already gone
 * returns true).
 */
function applyRemediation(rem: Remediation): boolean {
  try {
    switch (rem.kind) {
      case 'remove_config_key': {
        if (!rem.scope || !rem.configKey) return false;
        const segments = rem.configKey.split('.');
        updateConfig(rem.scope, (c) => {
          let cursor: Record<string, unknown> = c as unknown as Record<string, unknown>;
          for (let i = 0; i < segments.length - 1; i++) {
            const next = cursor[segments[i]];
            if (typeof next !== 'object' || next === null) return;
            cursor = next as Record<string, unknown>;
          }
          delete cursor[segments[segments.length - 1]];
        });
        return true;
      }
      case 'rm_path': {
        if (!rem.path) return false;
        removePath(rem.path);
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function runChecksForScope(scope: Scope, opts: { fix: boolean; remote: boolean }): CheckResult[] {
  const results: CheckResult[] = [];
  const root = scopeRoot(scope);
  if (!root) return results;

  const cfg = readConfig(scope);

  // Check: every config marketplace entry has a corresponding directory
  const mktDir = marketplacesDir(scope);
  for (const name of Object.keys(cfg.marketplaces)) {
    if (!mktDir) {
      results.push(failCheck(scope, `marketplace:${name}:dir`, `marketplaces directory unavailable`));
      continue;
    }
    const dir = join(mktDir, name);
    if (!pathExists(dir)) {
      const remediation: Remediation = {
        kind: 'remove_config_key',
        description: `Drop stale config entry config.${scope}.marketplaces.${name}`,
        scope,
        configKey: `marketplaces.${name}`,
      };
      if (opts.fix && applyRemediation(remediation)) {
        results.push({ scope, name: `marketplace:${name}:dir`, status: 'fail', message: `directory missing — removed stale config entry`, fixed: true, remediation });
      } else {
        results.push(failCheck(scope, `marketplace:${name}:dir`, `directory missing: ${dir}`, remediation));
      }
    } else {
      results.push(pass(scope, `marketplace:${name}:dir`, `directory exists`));
    }
  }

  // Check: every config plugin entry has a corresponding directory
  const plugDir = pluginsDir(scope);
  for (const name of Object.keys(cfg.plugins)) {
    if (!plugDir) {
      results.push(failCheck(scope, `plugin:${name}:dir`, `plugins directory unavailable`));
      continue;
    }
    const dir = join(plugDir, name);
    if (!pathExists(dir)) {
      const remediation: Remediation = {
        kind: 'remove_config_key',
        description: `Drop stale config entry config.${scope}.plugins.${name}`,
        scope,
        configKey: `plugins.${name}`,
      };
      if (opts.fix && applyRemediation(remediation)) {
        results.push({ scope, name: `plugin:${name}:dir`, status: 'fail', message: `directory missing — removed stale config entry`, fixed: true, remediation });
      } else {
        results.push(failCheck(scope, `plugin:${name}:dir`, `directory missing: ${dir}`, remediation));
      }
    } else {
      results.push(pass(scope, `plugin:${name}:dir`, `directory exists`));
    }
  }

  // Check: every marketplace directory has a valid manifest
  if (mktDir && pathExists(mktDir)) {
    for (const name of listDirs(mktDir)) {
      const dir = join(mktDir, name);
      const manifest = readMarketplaceManifest(dir);
      if (!manifest) {
        const remediation: Remediation = {
          kind: 'rm_path',
          description: `Remove dangling marketplace directory (no valid .crouter-marketplace/marketplace.json)`,
          path: dir,
        };
        if (opts.fix && applyRemediation(remediation)) {
          results.push({ scope, name: `marketplace:${name}:manifest`, status: 'fail', message: `no valid marketplace.json — removed dangling directory`, fixed: true, remediation });
        } else {
          results.push(failCheck(scope, `marketplace:${name}:manifest`, `no valid marketplace.json in ${dir}`, remediation));
        }
      } else {
        results.push(pass(scope, `marketplace:${name}:manifest`, `manifest valid`));

        // Check: marketplace plugins[].source paths resolve (relative paths only)
        for (const entry of manifest.plugins) {
          if (entry.source.startsWith('http://') || entry.source.startsWith('https://') || entry.source.startsWith('git@')) {
            continue;
          }
          const resolved = join(dir, entry.source);
          if (!pathExists(resolved)) {
            results.push(failCheck(scope, `marketplace:${name}:plugin-source:${entry.name}`, `source path does not resolve: ${resolved}`));
          } else {
            results.push(pass(scope, `marketplace:${name}:plugin-source:${entry.name}`, `source resolves`));
          }
        }
      }
    }
  }

  // Check: every plugin directory has a valid manifest + no duplicate names
  const seenPluginNames = new Map<string, string>();
  if (plugDir && pathExists(plugDir)) {
    for (const name of listDirs(plugDir)) {
      const dir = join(plugDir, name);
      const manifest = readPluginManifest(dir);
      if (!manifest) {
        const remediation: Remediation = {
          kind: 'rm_path',
          description: `Remove dangling plugin directory (no valid .crouter-plugin/plugin.json)`,
          path: dir,
        };
        if (opts.fix && applyRemediation(remediation)) {
          results.push({ scope, name: `plugin:${name}:manifest`, status: 'fail', message: `no valid plugin.json — removed dangling directory`, fixed: true, remediation });
        } else {
          results.push(failCheck(scope, `plugin:${name}:manifest`, `no valid plugin.json in ${dir}`, remediation));
        }
        continue;
      }
      results.push(pass(scope, `plugin:${name}:manifest`, `manifest valid`));

      // Duplicate names
      if (seenPluginNames.has(name)) {
        results.push(failCheck(scope, `plugin:${name}:duplicate`, `duplicate plugin name within scope (also at ${seenPluginNames.get(name)})`));
      } else {
        seenPluginNames.set(name, dir);
      }

      // Git remote check (slow, opt-in)
      if (opts.remote && manifest.source) {
        const res = lsRemote(manifest.source);
        if (res.status !== 0) {
          results.push(failCheck(scope, `plugin:${name}:remote`, `git remote unreachable: ${manifest.source}`));
        } else {
          results.push(pass(scope, `plugin:${name}:remote`, `git remote reachable`));
        }
      }
    }
  }

  return results;
}

export const sysDoctorLeaf = defineLeaf({
  name: 'doctor',
  description: 'diagnose installation health',
  whenToUse: 'something in your crtr install looks off and you want it diagnosed — a plugin or marketplace manifest is missing, or a config entry points at a directory that no longer exists. Reports each problem with a structured remediation, and can apply the repairs for you.',
  help: {
    name: 'sys doctor',
    summary: 'diagnose missing manifests and broken config entries',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Scope to check. Default: all scopes.' },
      { kind: 'flag', name: 'fix', type: 'bool', required: false, constraint: 'Apply each non-pass check\'s remediation and report what was fixed.' },
      { kind: 'flag', name: 'remote', type: 'bool', required: false, constraint: 'Check git remotes with ls-remote (slow — makes network calls).' },
    ],
    output: [
      { name: 'checks', type: 'object[]', required: true, constraint: 'Each: {scope, name, status, message, fixed?, remediation?}. status: pass | fail. remediation (when present) is {kind, description, ...payload} where kind is remove_config_key | rm_path. Sorted by scope then name.' },
      { name: 'ok', type: 'boolean', required: true, constraint: 'True when no unresolved fail checks remain.' },
    ],
    outputKind: 'object',
    effects: [
      'Read-only unless --fix is passed.',
      'With --fix: applies each non-pass check\'s `remediation` — removes stale config entries and deletes dangling plugin/marketplace directories.',
      'Each non-pass result carries a structured `remediation` describing the fix action (absolute paths, exact config keys) so callers can apply it directly without --fix.',
    ],
  },
  run: async (input) => {
    const scopeArg = input['scope'] as string | undefined;
    const fix = input['fix'] as boolean;
    const remote = input['remote'] as boolean;

    const scopes = listScopes(scopeArg);
    const allResults: CheckResult[] = [];
    for (const scope of scopes) {
      const results = runChecksForScope(scope, { fix, remote });
      allResults.push(...results);
    }

    // Sort by scope then name (mirrors old printResults grouping)
    allResults.sort((a, b) => {
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
      return a.name.localeCompare(b.name);
    });

    const ok = !allResults.some((r) => r.status === 'fail' && r.fixed !== true);
    // failed count = unresolved fails
    const failed = allResults.filter((r) => r.status === 'fail' && r.fixed !== true).length;

    // The skeleton schema declared `ok` not `failed`; returning both for completeness
    return { checks: allResults as unknown as Record<string, unknown>[], ok, failed };
  },
});
