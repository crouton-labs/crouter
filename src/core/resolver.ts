import { join, relative, sep, dirname } from 'node:path';
import {
  SCOPE_SKILL_PLUGIN,
  SKILL_ENTRY_FILE,
  SKILLS_DIR,
  skillConfigKey,
} from '../types.js';
import type {
  InstalledMarketplace,
  InstalledPlugin,
  Scope,
  ScopeConfig,
  Skill,
} from '../types.js';
import { readConfig } from './config.js';
import {
  listDirs,
  pathExists,
  readText,
  walkFiles,
} from './fs-utils.js';
import { readMarketplaceManifest, readPluginManifest } from './manifest.js';
import { parseFrontmatter } from './frontmatter.js';
import { ambiguous, notFound, usage } from './errors.js';
import {
  marketplacesDir,
  pluginsDir,
  projectScopeRoot,
  scopeSkillsDir,
  userScopeRoot,
} from './scope.js';

export function listInstalledPlugins(scope: Scope): InstalledPlugin[] {
  const dir = pluginsDir(scope);
  if (!dir || !pathExists(dir)) return [];
  const cfg = readConfig(scope);
  const out: InstalledPlugin[] = [];
  for (const name of listDirs(dir)) {
    const root = join(dir, name);
    const manifest = readPluginManifest(root);
    if (!manifest) continue;
    const entry = cfg.plugins[name];
    let version: string | undefined;
    if (entry && entry.version !== undefined) version = entry.version;
    else if (manifest.version !== undefined) version = manifest.version;
    out.push({
      name,
      scope,
      root,
      manifest,
      enabled: entry ? entry.enabled : true,
      sourceMarketplace: entry ? entry.source_marketplace : undefined,
      version,
    });
  }
  return out;
}

export function listAllPlugins(): InstalledPlugin[] {
  const scopes: Scope[] = [];
  if (projectScopeRoot()) scopes.push('project');
  scopes.push('user');
  return scopes.flatMap(listInstalledPlugins);
}

export function findPluginByName(name: string, scope?: Scope): InstalledPlugin | null {
  if (scope) {
    return listInstalledPlugins(scope).find((p) => p.name === name) ?? null;
  }
  for (const s of (['project', 'user'] as const).filter((sc) =>
    sc === 'project' ? projectScopeRoot() !== null : true,
  )) {
    const match = listInstalledPlugins(s).find((p) => p.name === name);
    if (match) return match;
  }
  return null;
}

interface ScopeConfigs {
  project?: ScopeConfig;
  user: ScopeConfig;
}

function loadScopeConfigs(): ScopeConfigs {
  const user = readConfig('user');
  if (projectScopeRoot()) return { project: readConfig('project'), user };
  return { user };
}

export function effectiveSkillEnabled(
  pluginName: string,
  skillName: string,
  cfgs: ScopeConfigs,
): { enabled: boolean; disabledIn?: Scope } {
  const key = skillConfigKey(pluginName, skillName);
  if (cfgs.project && cfgs.project.skills[key] !== undefined) {
    const e = cfgs.project.skills[key].enabled;
    return e ? { enabled: true } : { enabled: false, disabledIn: 'project' };
  }
  if (cfgs.user.skills[key] !== undefined) {
    const e = cfgs.user.skills[key].enabled;
    return e ? { enabled: true } : { enabled: false, disabledIn: 'user' };
  }
  return { enabled: true };
}

export function listSkillsInPlugin(
  plugin: InstalledPlugin,
  cfgs?: ScopeConfigs,
): Skill[] {
  const skillsRoot = join(plugin.root, SKILLS_DIR);
  if (!pathExists(skillsRoot)) return [];
  const configs = cfgs === undefined ? loadScopeConfigs() : cfgs;
  const skills: Skill[] = [];
  const skillFiles = walkFiles(skillsRoot, (n) => n === SKILL_ENTRY_FILE);
  for (const file of skillFiles) {
    const rel = relative(skillsRoot, dirname(file));
    const name = rel.split(sep).join('/');
    if (!name) continue;
    const source = readText(file);
    const { data } = parseFrontmatter(source);
    const { enabled, disabledIn } = effectiveSkillEnabled(plugin.name, name, configs);
    skills.push({
      name,
      plugin: plugin.name,
      scope: plugin.scope,
      path: file,
      pluginRoot: plugin.root,
      frontmatter: data === null ? { name } : data,
      enabled,
      disabledIn,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listScopeRootSkills(
  scope: Scope,
  cfgs?: ScopeConfigs,
): Skill[] {
  const skillsRoot = scopeSkillsDir(scope);
  if (!skillsRoot || !pathExists(skillsRoot)) return [];
  const configs = cfgs === undefined ? loadScopeConfigs() : cfgs;
  const skills: Skill[] = [];
  const skillFiles = walkFiles(skillsRoot, (n) => n === SKILL_ENTRY_FILE);
  for (const file of skillFiles) {
    const rel = relative(skillsRoot, dirname(file));
    const name = rel.split(sep).join('/');
    if (!name) continue;
    const source = readText(file);
    const { data } = parseFrontmatter(source);
    const { enabled, disabledIn } = effectiveSkillEnabled(
      SCOPE_SKILL_PLUGIN,
      name,
      configs,
    );
    skills.push({
      name,
      plugin: SCOPE_SKILL_PLUGIN,
      scope,
      path: file,
      pluginRoot: skillsRoot,
      frontmatter: data === null ? { name } : data,
      enabled,
      disabledIn,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAllSkills(scopeFilter?: Scope): Skill[] {
  const plugins = scopeFilter ? listInstalledPlugins(scopeFilter) : listAllPlugins();
  const cfgs = loadScopeConfigs();
  const scopes: Scope[] = scopeFilter
    ? [scopeFilter]
    : ([projectScopeRoot() ? 'project' : null, 'user'].filter(Boolean) as Scope[]);
  return [
    ...scopes.flatMap((s) => listScopeRootSkills(s, cfgs)),
    ...plugins.filter((p) => p.enabled).flatMap((p) => listSkillsInPlugin(p, cfgs)),
  ];
}

function enumerateNeighborPool(skill: Skill): Skill[] {
  if (skill.plugin === SCOPE_SKILL_PLUGIN) {
    return listScopeRootSkills(skill.scope);
  }
  const plugin = listInstalledPlugins(skill.scope).find((p) => p.name === skill.plugin);
  if (!plugin) return [];
  return listSkillsInPlugin(plugin);
}

export function listSkillSiblings(skill: Skill): Skill[] {
  const pool = enumerateNeighborPool(skill);
  const segs = skill.name.split('/');
  const depth = segs.length;
  const parentPrefix = segs.slice(0, -1).join('/');
  return pool.filter((s) => {
    if (s.name === skill.name) return false;
    const sSegs = s.name.split('/');
    if (sSegs.length !== depth) return false;
    if (parentPrefix === '') return !s.name.includes('/');
    return s.name.startsWith(parentPrefix + '/');
  });
}

export function listSkillChildren(skill: Skill): Skill[] {
  const pool = enumerateNeighborPool(skill);
  const prefix = skill.name + '/';
  return pool.filter((s) => {
    if (!s.name.startsWith(prefix)) return false;
    const rest = s.name.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
  });
}

export interface SkillResolutionOpts {
  scope?: Scope;
  pluginFilter?: string;
}

export function resolveSkill(
  rawName: string,
  opts: SkillResolutionOpts = {},
): Skill {
  const parsed = parseSkillQualifier(rawName);

  if (parsed.scope && opts.scope && parsed.scope !== opts.scope) {
    throw usage(
      `scope conflict: identifier "${rawName}" uses scope "${parsed.scope}" but --scope is "${opts.scope}"`,
    );
  }
  if (parsed.plugin && opts.pluginFilter && parsed.plugin !== opts.pluginFilter) {
    throw usage(
      `plugin conflict: identifier "${rawName}" uses plugin "${parsed.plugin}" but --plugin is "${opts.pluginFilter}"`,
    );
  }

  const effectiveScope: Scope | undefined = opts.scope ?? parsed.scope;
  const effectivePluginFilter: string | undefined = opts.pluginFilter ?? parsed.plugin;

  const direct = findSkillMatches(parsed.name, parsed.plugin, effectiveScope, effectivePluginFilter);
  if (direct.length > 0) return pickMatch(direct, parsed.name, parsed.plugin);

  // Fallback: bare `plugin/name` (no colon) — try splitting on first `/`.
  // Disambiguates "claude-authoring/rules" (which the search/list display also emits as
  // "user:claude-authoring/rules") from a nested scope-root skill of the same shape.
  if (!parsed.plugin && parsed.name.includes('/')) {
    const slashIdx = parsed.name.indexOf('/');
    const maybePlugin = parsed.name.slice(0, slashIdx);
    const rest = parsed.name.slice(slashIdx + 1);
    if (effectivePluginFilter === undefined || effectivePluginFilter === maybePlugin) {
      const fallback = findSkillMatches(rest, maybePlugin, effectiveScope, maybePlugin);
      if (fallback.length > 0) return pickMatch(fallback, rest, maybePlugin);
    }
  }

  throw notFound(formatNotFoundMessage(rawName, parsed), {
    skill: parsed.name,
    plugin: parsed.plugin,
    scope: parsed.scope,
  });
}

function findSkillMatches(
  name: string,
  pluginQualifier: string | undefined,
  scope: Scope | undefined,
  pluginFilter: string | undefined,
): Skill[] {
  const plugins = scope ? listInstalledPlugins(scope) : listAllPlugins();
  const enabledPlugins = plugins.filter((p) => p.enabled);
  const cfgs = loadScopeConfigs();
  const matches: Skill[] = [];

  // Scope-root skills first — they're the user's own captured knowledge.
  if (
    !pluginFilter &&
    (pluginQualifier === undefined || pluginQualifier === SCOPE_SKILL_PLUGIN)
  ) {
    const scopes: Scope[] = scope
      ? [scope]
      : ([projectScopeRoot() ? 'project' : null, 'user'].filter(Boolean) as Scope[]);
    for (const s of scopes) {
      const skillsRoot = scopeSkillsDir(s);
      if (!skillsRoot) continue;
      const skillPath = join(skillsRoot, ...name.split('/'), SKILL_ENTRY_FILE);
      if (!pathExists(skillPath)) continue;
      const source = readText(skillPath);
      const { data } = parseFrontmatter(source);
      const { enabled, disabledIn } = effectiveSkillEnabled(
        SCOPE_SKILL_PLUGIN,
        name,
        cfgs,
      );
      matches.push({
        name,
        plugin: SCOPE_SKILL_PLUGIN,
        scope: s,
        path: skillPath,
        pluginRoot: skillsRoot,
        frontmatter: data === null ? { name } : data,
        enabled,
        disabledIn,
      });
    }
  }

  const ordered = orderPluginsByResolution(enabledPlugins);
  for (const plugin of ordered) {
    if (pluginQualifier && plugin.name !== pluginQualifier) continue;
    if (pluginFilter && plugin.name !== pluginFilter) continue;
    const skillPath = join(plugin.root, SKILLS_DIR, ...name.split('/'), SKILL_ENTRY_FILE);
    if (!pathExists(skillPath)) continue;
    const source = readText(skillPath);
    const { data } = parseFrontmatter(source);
    const { enabled, disabledIn } = effectiveSkillEnabled(plugin.name, name, cfgs);
    matches.push({
      name,
      plugin: plugin.name,
      scope: plugin.scope,
      path: skillPath,
      pluginRoot: plugin.root,
      frontmatter: data === null ? { name } : data,
      enabled,
      disabledIn,
    });
  }

  return matches;
}

function pickMatch(matches: Skill[], name: string, pluginQualifier: string | undefined): Skill {
  if (matches.length === 1) return matches[0];

  const sameScopeAndPlugin = matches.every(
    (m) => m.plugin === matches[0].plugin && m.scope === matches[0].scope,
  );
  if (sameScopeAndPlugin) return matches[0];

  if (!pluginQualifier) return matches[0];

  throw ambiguous(`ambiguous skill: ${name}`, {
    skill: name,
    candidates: matches.map((m) => ({
      plugin: m.plugin,
      scope: m.scope,
      path: m.path,
    })),
  });
}

function formatNotFoundMessage(rawName: string, parsed: ParsedSkillQualifier): string {
  const suggestions = suggestSkills(parsed.name, parsed.plugin);
  const lines: string[] = [`skill not found: ${rawName}`];
  lines.push('       expected forms: <name>, <plugin>:<name>, <scope>:<plugin>/<name>');
  if (suggestions.length > 0) {
    const formatted = suggestions
      .map((s) =>
        s.plugin === SCOPE_SKILL_PLUGIN ? s.name : `${s.plugin}:${s.name}`,
      )
      .slice(0, 3);
    lines.push(`       did you mean: ${formatted.join(', ')}`);
  } else {
    lines.push('       run `crtr skill list` or `crtr skill search <query>` to discover skills');
  }
  return lines.join('\n');
}

function suggestSkills(name: string, plugin: string | undefined): Skill[] {
  let all: Skill[];
  try {
    all = listAllSkills();
  } catch {
    return [];
  }
  const target = name.toLowerCase();
  const targetBase = target.split('/').pop() ?? target;
  const targetPluginGuess = target.includes('/') ? target.split('/')[0] : undefined;

  const exactName = all.filter((s) => s.name.toLowerCase() === target);
  if (exactName.length > 0) return exactName;

  const exactBase = all.filter((s) => {
    const sBase = s.name.toLowerCase().split('/').pop() ?? s.name.toLowerCase();
    return sBase === targetBase;
  });
  if (exactBase.length > 0) return exactBase;

  const scored = all
    .map((s) => {
      const sName = s.name.toLowerCase();
      const sBase = sName.split('/').pop() ?? sName;
      const sPlugin = s.plugin.toLowerCase();
      let score = 0;
      if (plugin !== undefined && sPlugin === plugin.toLowerCase()) score += 5;
      if (targetPluginGuess !== undefined && sPlugin === targetPluginGuess) score += 5;
      if (sName.includes(target) || target.includes(sName)) score += 4;
      if (sBase.includes(targetBase) || targetBase.includes(sBase)) score += 3;
      if (editDistance(sBase, targetBase) <= 2) score += 4;
      return { skill: s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((x) => x.skill);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export interface ParsedSkillQualifier {
  scope?: Scope;
  plugin?: string;
  name: string;
}

const SCOPE_QUALIFIERS: ReadonlySet<string> = new Set<Scope>(['user', 'project']);

// Accepted identifier forms:
//   <name>                         — bare name; scope-root first, then plugins
//   <plugin>:<name>                — explicit plugin
//   <scope>:<name>                 — scope-root in a specific scope
//   <scope>:<plugin>/<name>        — fully qualified (matches `skill list` / `skill search` display)
// Bare `<plugin>/<name>` (no colon) is handled as a fallback inside resolveSkill.
export function parseSkillQualifier(raw: string): ParsedSkillQualifier {
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return { name: raw };
  const before = raw.slice(0, colonIdx);
  const after = raw.slice(colonIdx + 1);
  if (SCOPE_QUALIFIERS.has(before)) {
    const scope = before as Scope;
    const slashIdx = after.indexOf('/');
    if (slashIdx !== -1) {
      return {
        scope,
        plugin: after.slice(0, slashIdx),
        name: after.slice(slashIdx + 1),
      };
    }
    return { scope, name: after };
  }
  return { plugin: before, name: after };
}

function orderPluginsByResolution(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const score = (p: InstalledPlugin) => {
    const fromMarketplace = Boolean(p.sourceMarketplace);
    if (p.scope === 'project' && !fromMarketplace) return 0;
    if (p.scope === 'user' && !fromMarketplace) return 1;
    if (p.scope === 'project' && fromMarketplace) return 2;
    return 3;
  };
  return [...plugins].sort((a, b) => score(a) - score(b));
}

export function listInstalledMarketplaces(scope: Scope): InstalledMarketplace[] {
  const dir = marketplacesDir(scope);
  if (!dir || !pathExists(dir)) return [];
  const cfg = readConfig(scope);
  const out: InstalledMarketplace[] = [];
  for (const name of listDirs(dir)) {
    const root = join(dir, name);
    const manifest = readMarketplaceManifest(root);
    if (!manifest) continue;
    const entry = cfg.marketplaces[name];
    const url = entry && entry.url !== undefined ? entry.url : '';
    const ref = entry && entry.ref !== undefined ? entry.ref : 'main';
    out.push({
      name,
      scope,
      root,
      manifest,
      url,
      ref,
    });
  }
  return out;
}

export function listAllMarketplaces(): InstalledMarketplace[] {
  const scopes: Scope[] = [];
  if (projectScopeRoot()) scopes.push('project');
  scopes.push('user');
  return scopes.flatMap(listInstalledMarketplaces);
}

export function findMarketplaceByName(
  name: string,
  scope?: Scope,
): InstalledMarketplace | null {
  if (scope) {
    return listInstalledMarketplaces(scope).find((m) => m.name === name) ?? null;
  }
  for (const s of ['project', 'user'] as const) {
    if (s === 'project' && !projectScopeRoot()) continue;
    const found = listInstalledMarketplaces(s).find((m) => m.name === name);
    if (found) return found;
  }
  return null;
}

export function scopeRootsLabel(): string {
  const proj = projectScopeRoot();
  return proj ? `project=${proj}, user=${userScopeRoot()}` : `user=${userScopeRoot()}`;
}
