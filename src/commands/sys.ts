// `crtr sys` subtree: config {get,set,path}, doctor, update, version.
// Replaces old config.ts + doctor.ts + update.ts command files.

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { readConfig, writeConfig, configPath as coreConfigPath, updateConfig, updateState } from '../core/config.js';
import { usage, notFound } from '../core/errors.js';
import { scopeRoot, listScopes, builtinSkillsRoot, marketplacesDir, pluginsDir, projectScopeRoot } from '../core/scope.js';
import { listInstalledPlugins, listSkillsInPlugin } from '../core/resolver.js';
import { readMarketplaceManifest, readPluginManifest } from '../core/manifest.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { pathExists, listDirs, removePath, readText, writeText, nowIso } from '../core/fs-utils.js';
import { lsRemote } from '../core/git.js';
import { createJob, appendEvent, writeResult } from '../core/jobs.js';
import { selfCheck, selfUpdate, contentCheck, contentUpdate } from '../core/self-update.js';
import { SKILL_TYPES, isSkillType } from '../types.js';
import type { Scope, ScopeConfig, AutoUpdateConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..', '..');

function readPackageVersion(): string {
  const raw = readFileSync(join(PKG_ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

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

function resolveScope(raw: string | undefined): Scope {
  if (raw === undefined) return 'user';
  if (raw === 'user' || raw === 'project') return raw;
  throw usage(`scope must be 'user' or 'project', got: ${raw}`);
}

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

const configBranch = defineBranch({
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

const sysDoctorLeaf = defineLeaf({
  name: 'doctor',
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

const sysUpdateLeaf = defineLeaf({
  name: 'update',
  help: {
    name: 'sys update',
    summary: 'update the crtr binary and/or installed plugins and marketplaces',
    params: [
      { kind: 'flag', name: 'target', type: 'enum', choices: ['self', 'content', 'all'], required: false, constraint: "What to update. Default: all." },
      { kind: 'flag', name: 'check', type: 'bool', required: false, constraint: 'Check for updates without applying them (bounded, blocking).' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: false, constraint: 'Present when applying updates. Poll with `crtr job read result JOB_ID --wait`.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Instruction for retrieving the job result.' },
      { name: 'updates', type: 'object[]', required: false, constraint: 'Present when --check. Each: {name, current, latest, up_to_date, unreachable, kind}.' },
      { name: 'up_to_date', type: 'boolean', required: false, constraint: 'Present when --check. True when all items are up to date.' },
    ],
    outputKind: 'object',
    effects: [
      '--check — read-only, bounded network calls.',
      'Default (no --check) — launches a background job; returns job handle immediately.',
    ],
  },
  run: async (input) => {
    const target = input['target'] as string | undefined;
    const check = input['check'] as boolean;
    const resolvedTarget = target !== undefined ? target : 'all';

    if (check) {
      // Bounded blocking path: collect check results and return
      const updates: Array<{
        name: string;
        kind: string;
        current: string | null;
        latest: string | null;
        up_to_date: boolean;
        unreachable: boolean;
      }> = [];

      if (resolvedTarget === 'self' || resolvedTarget === 'all') {
        const r = selfCheck();
        if (r !== null) {
          updates.push({
            name: '@crouton-kit/crtr',
            kind: 'self',
            current: r.current,
            latest: r.latest,
            up_to_date: r.current === r.latest,
            unreachable: false,
          });
        } else {
          updates.push({
            name: '@crouton-kit/crtr',
            kind: 'self',
            current: null,
            latest: null,
            up_to_date: true,
            unreachable: true,
          });
        }
      }

      if (resolvedTarget === 'content' || resolvedTarget === 'all') {
        const entries = contentCheck();
        for (const e of entries) {
          updates.push({
            name: e.name,
            kind: e.kind,
            current: e.current,
            latest: e.latest,
            up_to_date: e.up_to_date,
            unreachable: e.unreachable,
          });
        }
      }

      const up_to_date = updates.every((u) => u.up_to_date || u.unreachable);
      return { updates: updates as unknown as Record<string, unknown>[], up_to_date };
    }

    // Long-running apply path: create a job, run in background, return handle
    const cwd = process.cwd();
    const { jobId } = createJob('sys-update', { cwd, pid: process.pid });

    // Run update asynchronously without awaiting in the main path
    void (async () => {
      try {
        if (resolvedTarget === 'self' || resolvedTarget === 'all') {
          appendEvent(jobId, { level: 'info', event: 'self-update:start', message: 'running npm install -g @crouton-kit/crtr@latest' });
          selfUpdate();
          const scopes: Scope[] = ['user'];
          if (projectScopeRoot()) scopes.unshift('project');
          for (const scope of scopes) {
            updateState(scope, (s) => {
              s.last_self_check = nowIso();
            });
          }
          appendEvent(jobId, { level: 'info', event: 'self-update:done', message: 'crtr binary updated' });
        }

        if (resolvedTarget === 'content' || resolvedTarget === 'all') {
          appendEvent(jobId, { level: 'info', event: 'content-update:start', message: 'pulling updates for marketplaces and plugins' });
          contentUpdate();
          appendEvent(jobId, { level: 'info', event: 'content-update:done', message: 'content updates complete' });
        }

        writeResult(jobId, { target: resolvedTarget, status: 'done' }, 'done');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendEvent(jobId, { level: 'error', event: 'update:error', message: msg });
        writeResult(jobId, { error: msg }, 'failed');
      }
    })();

    return {
      job_id: jobId,
      follow_up: `crtr job read result ${jobId} --wait`,
    };
  },
});

const sysVersionLeaf = defineLeaf({
  name: 'version',
  help: {
    name: 'sys version',
    summary: 'print the installed crtr version',
    params: [],
    output: [
      { name: 'version', type: 'string', required: true, constraint: 'Semver string from package.json.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (_input) => {
    return { version: readPackageVersion() };
  },
});

export function registerSys(): BranchDef {
  return defineBranch({
    name: 'sys',
    help: {
      name: 'sys',
      summary: 'crtr system configuration, diagnostics, and self-management',
      children: [
        { name: 'config', desc: 'read and write configuration', useWhen: 'inspecting or changing crtr settings' },
        { name: 'doctor', desc: 'diagnose installation health', useWhen: 'troubleshooting missing manifests or broken config' },
        { name: 'update', desc: 'update binary and content', useWhen: 'upgrading crtr or its installed plugins/marketplaces' },
        { name: 'version', desc: 'print installed version', useWhen: 'checking which version of crtr is installed' },
      ],
    },
    children: [configBranch, sysDoctorLeaf, sysUpdateLeaf, sysVersionLeaf],
  });
}
