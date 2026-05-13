import { Command } from 'commander';
import { join } from 'node:path';
import type { Scope } from '../types.js';
import { SKILL_ENTRY_FILE, SKILLS_DIR, SKILL_TYPES, isSkillType } from '../types.js';
import { out, err, jsonOut, handleError, stdoutColor } from '../core/output.js';
import { projectScopeRoot, userScopeRoot, scopeRoot, pluginsDir, marketplacesDir, listScopes } from '../core/scope.js';
import { readConfig, writeConfig, updateConfig } from '../core/config.js';
import { listInstalledPlugins, listInstalledMarketplaces, listSkillsInPlugin } from '../core/resolver.js';
import { pathExists, listDirs, listEntries, removePath, walkFiles, readText } from '../core/fs-utils.js';
import { readPluginManifest, readMarketplaceManifest } from '../core/manifest.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { lsRemote } from '../core/git.js';
import { ExitCode } from '../types.js';

type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  scope: Scope;
  name: string;
  status: CheckStatus;
  message: string;
  fixed?: boolean;
}

function pass(scope: Scope, name: string, message: string): CheckResult {
  return { scope, name, status: 'pass', message };
}

function fail(scope: Scope, name: string, message: string): CheckResult {
  return { scope, name, status: 'fail', message };
}

function warn(scope: Scope, name: string, message: string): CheckResult {
  return { scope, name, status: 'warn', message };
}

function readRawTypeField(skillPath: string): string | undefined {
  const content = readText(skillPath);
  const { raw } = parseFrontmatter(content);
  if (!raw) return undefined;
  const m = raw.match(/^type:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
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
      results.push(fail(scope, `marketplace:${name}:dir`, `marketplaces directory unavailable`));
      continue;
    }
    const dir = join(mktDir, name);
    if (!pathExists(dir)) {
      if (opts.fix) {
        updateConfig(scope, (c) => {
          delete c.marketplaces[name];
        });
        results.push({ scope, name: `marketplace:${name}:dir`, status: 'fail', message: `directory missing — removed stale config entry`, fixed: true });
      } else {
        results.push(fail(scope, `marketplace:${name}:dir`, `directory missing: ${dir}`));
      }
    } else {
      results.push(pass(scope, `marketplace:${name}:dir`, `directory exists`));
    }
  }

  // Check: every config plugin entry has a corresponding directory
  const plugDir = pluginsDir(scope);
  for (const name of Object.keys(cfg.plugins)) {
    if (!plugDir) {
      results.push(fail(scope, `plugin:${name}:dir`, `plugins directory unavailable`));
      continue;
    }
    const dir = join(plugDir, name);
    if (!pathExists(dir)) {
      if (opts.fix) {
        updateConfig(scope, (c) => {
          delete c.plugins[name];
        });
        results.push({ scope, name: `plugin:${name}:dir`, status: 'fail', message: `directory missing — removed stale config entry`, fixed: true });
      } else {
        results.push(fail(scope, `plugin:${name}:dir`, `directory missing: ${dir}`));
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
        if (opts.fix) {
          removePath(dir);
          results.push({ scope, name: `marketplace:${name}:manifest`, status: 'fail', message: `no valid marketplace.json — removed dangling directory`, fixed: true });
        } else {
          results.push(fail(scope, `marketplace:${name}:manifest`, `no valid marketplace.json in ${dir}`));
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
            results.push(fail(scope, `marketplace:${name}:plugin-source:${entry.name}`, `source path does not resolve: ${resolved}`));
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
        if (opts.fix) {
          removePath(dir);
          results.push({ scope, name: `plugin:${name}:manifest`, status: 'fail', message: `no valid plugin.json — removed dangling directory`, fixed: true });
        } else {
          results.push(fail(scope, `plugin:${name}:manifest`, `no valid plugin.json in ${dir}`));
        }
        continue;
      }
      results.push(pass(scope, `plugin:${name}:manifest`, `manifest valid`));

      // Duplicate names
      if (seenPluginNames.has(name)) {
        results.push(fail(scope, `plugin:${name}:duplicate`, `duplicate plugin name within scope (also at ${seenPluginNames.get(name)})`));
      } else {
        seenPluginNames.set(name, dir);
      }

      // Check: skills frontmatter parses and name matches directory
      const plugin = listInstalledPlugins(scope).find((p) => p.name === name);
      if (plugin) {
        const skills = listSkillsInPlugin(plugin);
        for (const skill of skills) {
          if (!skill.frontmatter.name) {
            results.push(fail(scope, `plugin:${name}:skill:${skill.name}:frontmatter`, `frontmatter missing or name field empty`));
          } else if (skill.frontmatter.name !== skill.name) {
            results.push(warn(scope, `plugin:${name}:skill:${skill.name}:frontmatter`, `name mismatch: frontmatter says "${skill.frontmatter.name}", directory is "${skill.name}"`));
          } else {
            results.push(pass(scope, `plugin:${name}:skill:${skill.name}:frontmatter`, `frontmatter valid`));
          }

          const typeCheckName = `plugin:${name}:skill:${skill.name}:type`;
          const rawType = readRawTypeField(skill.path);
          if (rawType === undefined) {
            results.push(
              warn(
                scope,
                typeCheckName,
                `missing type field — add one of: ${SKILL_TYPES.join(' | ')}`,
              ),
            );
          } else if (!isSkillType(rawType)) {
            results.push(
              fail(
                scope,
                typeCheckName,
                `invalid type "${rawType}" — valid: ${SKILL_TYPES.join(' | ')}`,
              ),
            );
          } else {
            results.push(pass(scope, typeCheckName, `type: ${rawType}`));
          }
        }
      }

      // Git remote check (slow, opt-in)
      if (opts.remote && manifest.source) {
        const res = lsRemote(manifest.source);
        if (res.status !== 0) {
          results.push(fail(scope, `plugin:${name}:remote`, `git remote unreachable: ${manifest.source}`));
        } else {
          results.push(pass(scope, `plugin:${name}:remote`, `git remote reachable`));
        }
      }
    }
  }

  return results;
}

function printResults(results: CheckResult[]): void {
  const byScopeMap = new Map<Scope, CheckResult[]>();
  for (const r of results) {
    const existing = byScopeMap.get(r.scope);
    if (existing) {
      existing.push(r);
    } else {
      byScopeMap.set(r.scope, [r]);
    }
  }

  for (const [scope, checks] of byScopeMap) {
    out(stdoutColor.bold(`[${scope}]`));
    for (const c of checks) {
      if (c.status === 'pass') {
        out(stdoutColor.green(`  PASS  ${c.name}: ${c.message}`));
      } else if (c.status === 'warn') {
        out(stdoutColor.yellow(`  WARN  ${c.name}: ${c.message}`));
      } else {
        const fixSuffix = c.fixed ? ' (fixed)' : '';
        out(stdoutColor.red(`  FAIL  ${c.name}: ${c.message}${fixSuffix}`));
      }
    }
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('diagnose missing manifests, broken config entries, and skill frontmatter drift')
    .option('--fix', 'drop stale config entries and prune directories without manifests')
    .option('--remote', 'check git remotes with ls-remote (slow)')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--json', 'emit JSON')
    .action(async (opts: { fix?: boolean; remote?: boolean; scope?: string; json?: boolean }) => {
      try {
        const scopes = listScopes(opts.scope);
        const fix = opts.fix === true;
        const remote = opts.remote === true;

        const allResults: CheckResult[] = [];
        for (const scope of scopes) {
          const results = runChecksForScope(scope, { fix, remote });
          allResults.push(...results);
        }

        if (opts.json) {
          jsonOut({ checks: allResults });
          return;
        }

        printResults(allResults);

        const anyUnresolvedFail = allResults.some((r) => r.status === 'fail' && r.fixed !== true);
        if (anyUnresolvedFail) {
          process.exit(ExitCode.GENERAL);
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });
}
