// Subagent discovery + resolution.
//
// Subagents are markdown files with YAML frontmatter, modeled on the pi
// subagent extension but surfaced through the crtr `agent` CLI. Each file
// declares a name/description (+ optional tools/model) in frontmatter; its
// markdown body becomes the spawned agent's appended system prompt.
//
// Layout mirrors skills, one level shallower (flat files, not nested dirs):
//   <scope-root>/agents/<name>.md        — scope-root agents (user/project)
//   <plugin-root>/agents/<name>.md       — plugin-provided agents
//
// Resolution precedence matches skills: project before user before builtin;
// scope-root agents before plugin agents within a scope.

import { join, basename } from 'node:path';
import { readdirSync } from 'node:fs';
import { AGENTS_DIR, SCOPE_SKILL_PLUGIN } from '../types.js';
import type { Scope, Subagent, SubagentFrontmatter } from '../types.js';
import { listAllPlugins, listInstalledPlugins } from './resolver.js';
import { parseFrontmatterGeneric } from './frontmatter.js';
import { pathExists, readText } from './fs-utils.js';
import { projectScopeRoot, scopeRoot } from './scope.js';
import { ambiguous, notFound } from './errors.js';

/** `<scope-root>/agents` for a given scope, or null when the scope has no root. */
export function scopeAgentsDir(scope: Scope): string | null {
  const root = scopeRoot(scope);
  return root ? join(root, AGENTS_DIR) : null;
}

function coerceTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof value === 'string') {
    const arr = value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

function parseSubagentFile(
  filePath: string,
  scope: Scope,
  plugin: string,
): Subagent | null {
  let source: string;
  try {
    source = readText(filePath);
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatterGeneric(source);
  if (data === null) return null;

  // Name defaults to the filename stem when frontmatter omits it. A description
  // is required for the agent to be useful in listings; skip files without one.
  const fileStem = basename(filePath).replace(/\.md$/i, '');
  const name = typeof data.name === 'string' && data.name.trim() !== ''
    ? data.name.trim()
    : fileStem;
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    return null;
  }

  const fm: SubagentFrontmatter = {
    name,
    description: data.description.trim(),
    tools: coerceTools(data.tools),
    model: typeof data.model === 'string' && data.model.trim() !== '' ? data.model.trim() : undefined,
  };

  return {
    name,
    plugin,
    scope,
    path: filePath,
    frontmatter: fm,
    systemPrompt: body,
  };
}

function listAgentsInDir(dir: string, scope: Scope, plugin: string): Subagent[] {
  if (!pathExists(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Subagent[] = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith('.md')) continue;
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const parsed = parseSubagentFile(join(dir, e.name), scope, plugin);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Scope-root agents under `<scope-root>/agents/*.md`. */
export function listScopeRootSubagents(scope: Scope): Subagent[] {
  if (scope === 'builtin') return [];
  const dir = scopeAgentsDir(scope);
  if (!dir) return [];
  return listAgentsInDir(dir, scope, SCOPE_SKILL_PLUGIN);
}

/** All subagents: scope-root agents (project, user) plus enabled plugins. */
export function listSubagents(scopeFilter?: Scope): Subagent[] {
  const scopes: Scope[] = scopeFilter
    ? [scopeFilter]
    : ([projectScopeRoot() ? 'project' : null, 'user'].filter(Boolean) as Scope[]);

  const fromScopeRoots = scopes.flatMap((s) => listScopeRootSubagents(s));

  const plugins = scopeFilter ? listInstalledPlugins(scopeFilter) : listAllPlugins();
  const fromPlugins = plugins
    .filter((p) => p.enabled)
    .flatMap((p) => listAgentsInDir(join(p.root, AGENTS_DIR), p.scope, p.name));

  return [...fromScopeRoots, ...fromPlugins].sort((a, b) => a.name.localeCompare(b.name));
}

/** Canonical, unambiguous identifier: `<plugin>/<name>`, or bare `<name>` for
 *  scope-root agents. */
export function subagentId(a: Subagent): string {
  return a.plugin === SCOPE_SKILL_PLUGIN ? a.name : `${a.plugin}/${a.name}`;
}

export interface SubagentResolutionOpts {
  scope?: Scope;
  plugin?: string;
}

/** Resolve a subagent by name. Accepts a bare `<name>` or a `<plugin>/<name>`
 *  qualifier. Project precedes user precedes builtin; scope-root precedes
 *  plugin. Throws notFound / ambiguous as the skill resolver does. */
export function resolveSubagent(rawName: string, opts: SubagentResolutionOpts = {}): Subagent {
  const slash = rawName.indexOf('/');
  const pluginQualifier = opts.plugin ?? (slash !== -1 ? rawName.slice(0, slash) : undefined);
  const name = slash !== -1 && opts.plugin === undefined ? rawName.slice(slash + 1) : rawName;

  const all = listSubagents(opts.scope);
  let matches = all.filter((a) => a.name === name);
  if (pluginQualifier !== undefined) {
    matches = matches.filter((a) =>
      a.plugin === pluginQualifier ||
      (pluginQualifier === SCOPE_SKILL_PLUGIN && a.plugin === SCOPE_SKILL_PLUGIN),
    );
  }

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known = all.map(subagentId).slice(0, 8).join(', ');
    throw notFound(`subagent not found: ${rawName}`, {
      subagent: name,
      plugin: pluginQualifier,
      next: known !== ''
        ? `Known subagents: ${known}. Run \`crtr agent subagent list\` for the full set.`
        : 'No subagents defined. Run `crtr agent subagent author -h` to scaffold one.',
    });
  }

  // Multiple matches: prefer the highest-precedence scope/source deterministically.
  const score = (a: Subagent): number => {
    const scopeScore = a.scope === 'project' ? 0 : a.scope === 'user' ? 1 : 2;
    const sourceScore = a.plugin === SCOPE_SKILL_PLUGIN ? 0 : 1;
    return scopeScore * 2 + sourceScore;
  };
  const sorted = [...matches].sort((a, b) => score(a) - score(b));
  if (score(sorted[0]) !== score(sorted[1])) return sorted[0];

  throw ambiguous(`ambiguous subagent: ${rawName}`, {
    subagent: name,
    candidates: matches.map((m) => ({ id: subagentId(m), scope: m.scope, path: m.path })),
    next: 'Qualify with `<plugin>/<name>` or pass --scope to disambiguate.',
  });
}
