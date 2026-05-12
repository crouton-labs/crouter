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
import { ambiguous, notFound } from './errors.js';
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

export interface SkillResolutionOpts {
  scope?: Scope;
  pluginFilter?: string;
}

export function resolveSkill(
  rawName: string,
  opts: SkillResolutionOpts = {},
): Skill {
  const { plugin: pluginQualifier, name } = parseSkillQualifier(rawName);
  const plugins = opts.scope ? listInstalledPlugins(opts.scope) : listAllPlugins();
  const enabledPlugins = plugins.filter((p) => p.enabled);
  const cfgs = loadScopeConfigs();

  const matches: Skill[] = [];

  // Scope-root skills first — they're the user's own captured knowledge.
  if (
    !opts.pluginFilter &&
    (pluginQualifier === undefined || pluginQualifier === SCOPE_SKILL_PLUGIN)
  ) {
    const scopes: Scope[] = opts.scope
      ? [opts.scope]
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
    if (opts.pluginFilter && plugin.name !== opts.pluginFilter) continue;
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

  if (matches.length === 0) {
    throw notFound(
      pluginQualifier
        ? `skill not found: ${pluginQualifier}:${name}`
        : `skill not found: ${name}`,
      { skill: name, plugin: pluginQualifier },
    );
  }
  if (matches.length === 1) return matches[0];

  const sameScopeAndPlugin = matches.every(
    (m) => m.plugin === matches[0].plugin && m.scope === matches[0].scope,
  );
  if (sameScopeAndPlugin) return matches[0];

  // Resolution order picks the first; flag ambiguity only if user didn't qualify.
  if (!pluginQualifier) {
    return matches[0];
  }
  throw ambiguous(
    `ambiguous skill: ${name}`,
    {
      skill: name,
      candidates: matches.map((m) => ({
        plugin: m.plugin,
        scope: m.scope,
        path: m.path,
      })),
    },
  );
}

export function parseSkillQualifier(raw: string): { plugin?: string; name: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { name: raw };
  return { plugin: raw.slice(0, idx), name: raw.slice(idx + 1) };
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
