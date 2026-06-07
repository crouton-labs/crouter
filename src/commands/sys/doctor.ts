import { join } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { readConfig, updateConfig } from '../../core/config.js';
import { scopeRoot, listScopes, builtinSkillsRoot, marketplacesDir, pluginsDir } from '../../core/scope.js';
import { listInstalledPlugins, listSkillsInPlugin } from '../../core/resolver.js';
import { readMarketplaceManifest, readPluginManifest } from '../../core/manifest.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { pathExists, listDirs, removePath, readText, writeText } from '../../core/fs-utils.js';
import { lsRemote } from '../../core/git.js';
import { SKILL_TYPES, isSkillType } from '../../types.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// Doctor helpers (ported from commands/doctor.ts)
// ---------------------------------------------------------------------------

type CheckStatus = 'pass' | 'fail' | 'warn';

/**
 * Structured fix action for a failing or warning check. Surfaced on each
 * non-pass result so an agent reading doctor output can apply it directly
 * when `--fix` is not used (or when --fix did not auto-apply). Every
 * remediation includes absolute paths / exact keys — no inference required.
 */
interface Remediation {
  kind: 'remove_config_key' | 'rm_path' | 'edit_frontmatter';
  description: string;
  // remove_config_key
  scope?: Scope;
  configKey?: string;       // dotted path, e.g. "plugins.llm-app-authoring"
  // rm_path
  path?: string;            // absolute path to remove
  // edit_frontmatter
  filePath?: string;        // absolute path to the SKILL.md
  field?: string;           // frontmatter field to edit (currently only 'name')
  value?: string;           // new value for that field
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

function warnCheck(scope: Scope, name: string, message: string, remediation?: Remediation): CheckResult {
  return { scope, name, status: 'warn', message, ...(remediation ? { remediation } : {}) };
}

/**
 * Surgically replace a single frontmatter scalar field's value in a SKILL.md
 * file. Preserves the rest of the file (key order, comments, extra fields,
 * body) exactly. Returns true on success, false if no frontmatter or no such
 * field was found.
 */
function editFrontmatterField(filePath: string, field: string, newValue: string): boolean {
  let src: string;
  try {
    src = readText(filePath);
  } catch {
    return false;
  }
  const fmMatch = src.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*\r?\n?)/);
  if (!fmMatch) return false;
  const [, head, body, tail] = fmMatch;
  const fieldRe = new RegExp(`^(\\s*${field}\\s*:\\s*)(.*)$`, 'm');
  if (!fieldRe.test(body)) return false;
  const quoted = /[:#\-\[\]{},&*?|<>=!%@`]/.test(newValue) || /^\s/.test(newValue) || /\s$/.test(newValue);
  const formatted = quoted ? `"${newValue.replace(/"/g, '\\"')}"` : newValue;
  const newBody = body.replace(fieldRe, `$1${formatted}`);
  try {
    writeText(filePath, head + newBody + tail + src.slice(fmMatch[0].length));
    return true;
  } catch {
    return false;
  }
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
      case 'edit_frontmatter': {
        if (!rem.filePath || !rem.field || rem.value === undefined) return false;
        return editFrontmatterField(rem.filePath, rem.field, rem.value);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
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

function runChecksForBuiltin(): CheckResult[] {
  const root = builtinSkillsRoot();
  const plugins = listInstalledPlugins('builtin');
  if (plugins.length === 0) {
    return [failCheck('builtin', 'builtin:crtr:root', `builtin-skills root missing or has no valid plugin.json: ${root}`)];
  }
  const results: CheckResult[] = [
    pass('builtin', 'builtin:crtr:root', `builtin-skills root present: ${root}`),
  ];
  for (const plugin of plugins) {
    results.push(pass('builtin', `builtin:${plugin.name}:manifest`, `manifest valid`));
    const skills = listSkillsInPlugin(plugin);
    for (const skill of skills) {
      if (!skill.frontmatter.name) {
        results.push(failCheck('builtin', `builtin:${plugin.name}:skill:${skill.name}:frontmatter`, `frontmatter missing or name field empty`));
      } else {
        results.push(pass('builtin', `builtin:${plugin.name}:skill:${skill.name}:frontmatter`, `frontmatter valid`));
      }
    }
  }
  return results;
}

function runChecksForScope(scope: Scope, opts: { fix: boolean; remote: boolean }): CheckResult[] {
  if (scope === 'builtin') return runChecksForBuiltin();
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

      // Check: skills frontmatter name. Convention: frontmatter `name:` holds
      // the leaf segment only (e.g. "cli-design"); the full discovered name
      // ("interface/cli-design") is derived from the path automatically.
      const plugin = listInstalledPlugins(scope).find((p) => p.name === name);
      if (plugin) {
        const skills = listSkillsInPlugin(plugin);
        for (const skill of skills) {
          const checkName = `plugin:${name}:skill:${skill.name}:frontmatter`;
          const segments = skill.name.split('/');
          const baseName = segments[segments.length - 1];
          if (skill.frontmatter.name === baseName) {
            results.push(pass(scope, checkName, `frontmatter valid`));
          } else if (skill.frontmatter.name === '') {
            const remediation: Remediation = {
              kind: 'edit_frontmatter',
              description: `Set frontmatter "name: ${baseName}" (discovered name "${skill.name}" is auto-derived from the directory path; frontmatter holds the base segment only)`,
              filePath: skill.path,
              field: 'name',
              value: baseName,
            };
            if (opts.fix && applyRemediation(remediation)) {
              results.push({ scope, name: checkName, status: 'fail', message: `frontmatter name was missing — set to "${baseName}"`, fixed: true, remediation });
            } else {
              results.push(failCheck(scope, checkName, `frontmatter missing or name field empty`, remediation));
            }
          } else {
            const remediation: Remediation = {
              kind: 'edit_frontmatter',
              description: `Replace frontmatter "name: ${skill.frontmatter.name}" with "name: ${baseName}" (discovered name "${skill.name}" is auto-derived from the directory path; frontmatter holds the base segment only)`,
              filePath: skill.path,
              field: 'name',
              value: baseName,
            };
            if (opts.fix && applyRemediation(remediation)) {
              results.push({ scope, name: checkName, status: 'warn', message: `frontmatter name updated from "${skill.frontmatter.name}" to "${baseName}"`, fixed: true, remediation });
            } else {
              results.push(warnCheck(scope, checkName, `name mismatch: frontmatter says "${skill.frontmatter.name}", expected base name "${baseName}" (discovered as "${skill.name}")`, remediation));
            }
          }

          const typeCheckName = `plugin:${name}:skill:${skill.name}:type`;
          const rawType = readRawTypeField(skill.path);
          if (rawType === undefined) {
            results.push(warnCheck(scope, typeCheckName, `missing type field — add one of: ${SKILL_TYPES.join(' | ')}`));
          } else if (!isSkillType(rawType)) {
            results.push(failCheck(scope, typeCheckName, `invalid type "${rawType}" — valid: ${SKILL_TYPES.join(' | ')}`));
          } else {
            results.push(pass(scope, typeCheckName, `type: ${rawType}`));
          }
        }
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
  whenToUse: 'something in your crtr install looks off and you want it diagnosed — a plugin or marketplace manifest is missing, a config entry points at a directory that no longer exists, or skill frontmatter has drifted from its filename. Reports each problem with a structured remediation, and can apply the repairs for you.',
  help: {
    name: 'sys doctor',
    summary: 'diagnose missing manifests, broken config entries, and skill frontmatter drift',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Scope to check. Default: all scopes.' },
      { kind: 'flag', name: 'fix', type: 'bool', required: false, constraint: 'Apply each non-pass check\'s remediation and report what was fixed.' },
      { kind: 'flag', name: 'remote', type: 'bool', required: false, constraint: 'Check git remotes with ls-remote (slow — makes network calls).' },
    ],
    output: [
      { name: 'checks', type: 'object[]', required: true, constraint: 'Each: {scope, name, status, message, fixed?, remediation?}. status: pass | fail | warn. remediation (when present) is {kind, description, ...payload} where kind is remove_config_key | rm_path | edit_frontmatter. Sorted by scope then name.' },
      { name: 'ok', type: 'boolean', required: true, constraint: 'True when no unresolved fail checks remain.' },
    ],
    outputKind: 'object',
    effects: [
      'Read-only unless --fix is passed.',
      'With --fix: applies each non-pass check\'s `remediation` — removes stale config entries, deletes dangling plugin/marketplace directories, edits frontmatter name fields to the base-name convention.',
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
