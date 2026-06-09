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
  readTextIfExists,
  walkFiles,
} from './fs-utils.js';
import { readMarketplaceManifest, readPluginManifest } from './manifest.js';
import { parseFrontmatter, type ParsedFrontmatter } from './frontmatter.js';
import { ambiguous, notFound, usage } from './errors.js';
import { warn } from './output.js';
import { InputError } from './io.js';
import {
  builtinSkillsRoot,
  marketplacesDir,
  pluginsDir,
  projectScopeRoot,
  scopeSkillsDir,
  userScopeRoot,
} from './scope.js';

function getBuiltinPlugin(): InstalledPlugin | null {
  const root = builtinSkillsRoot();
  if (!pathExists(root)) return null;
  const manifest = readPluginManifest(root);
  if (!manifest) return null;
  return {
    name: manifest.name,
    scope: 'builtin',
    root,
    manifest,
    enabled: true,
    builtin: true,
    version: manifest.version,
  };
}

export function listInstalledPlugins(scope: Scope): InstalledPlugin[] {
  if (scope === 'builtin') {
    const builtin = getBuiltinPlugin();
    return builtin ? [builtin] : [];
  }
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
  scopes.push('builtin');
  return scopes.flatMap(listInstalledPlugins);
}

export function findPluginByName(name: string, scope?: Scope): InstalledPlugin | null {
  if (scope) {
    return listInstalledPlugins(scope).find((p) => p.name === name) ?? null;
  }
  for (const s of (['project', 'user', 'builtin'] as const).filter((sc) =>
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

/** Parse one skill file's frontmatter at the COLLECTION layer: the strict
 *  parser THROWS on invalid YAML (the frontmatter contract is "valid YAML"),
 *  so a single malformed SKILL.md must not brick a whole `skill find`/catalog
 *  scan across the corpus. On a parse error, emit a clear scoped notice naming
 *  the file and return null so the iterator SKIPS it and continues. A doc with
 *  no frontmatter block parses fine (data === null) and is kept. */
function readSkillFrontmatterSafe(file: string): ParsedFrontmatter | null {
  try {
    return parseFrontmatter(readText(file));
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    warn(`invalid frontmatter in ${file}: ${msg}`);
    return null;
  }
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
    const parsed = readSkillFrontmatterSafe(file);
    if (parsed === null) continue;
    const { data } = parsed;
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
  if (scope === 'builtin') return [];
  const skillsRoot = scopeSkillsDir(scope);
  if (!skillsRoot || !pathExists(skillsRoot)) return [];
  const configs = cfgs === undefined ? loadScopeConfigs() : cfgs;
  const skills: Skill[] = [];
  const skillFiles = walkFiles(skillsRoot, (n) => n === SKILL_ENTRY_FILE);
  for (const file of skillFiles) {
    const rel = relative(skillsRoot, dirname(file));
    const name = rel.split(sep).join('/');
    if (!name) continue;
    const parsed = readSkillFrontmatterSafe(file);
    if (parsed === null) continue;
    const { data } = parsed;
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

  const effectiveScope: Scope | undefined = opts.scope ?? parsed.scope;

  // Lookup-based disambiguation: if segments[0] matches an installed plugin, treat it as plugin.
  // Otherwise the entire segments array is the skill path under the scope-direct plugin.
  let pluginQualifier: string | undefined;
  let skillName: string;

  if (parsed.segments.length === 0) {
    throw usage(`skill name required`);
  }

  if (opts.pluginFilter !== undefined) {
    // Explicit plugin filter overrides disambiguation.
    pluginQualifier = opts.pluginFilter;
    skillName = parsed.segments.join('/');
  } else if (parsed.segments.length > 1) {
    const maybePlugin = parsed.segments[0];
    const pluginMatch = findPluginByName(maybePlugin, effectiveScope) ??
      (effectiveScope === undefined ? null : findPluginByName(maybePlugin));
    if (pluginMatch !== null) {
      pluginQualifier = maybePlugin;
      skillName = parsed.segments.slice(1).join('/');
    } else {
      pluginQualifier = undefined;
      skillName = parsed.segments.join('/');
    }
  } else {
    pluginQualifier = undefined;
    skillName = parsed.segments[0];
  }

  if (pluginQualifier && opts.pluginFilter && pluginQualifier !== opts.pluginFilter) {
    throw usage(
      `plugin conflict: identifier "${rawName}" uses plugin "${pluginQualifier}" but --plugin is "${opts.pluginFilter}"`,
    );
  }

  const effectivePluginFilter: string | undefined = opts.pluginFilter ?? pluginQualifier;

  const direct = findSkillMatches(skillName, pluginQualifier, effectiveScope, effectivePluginFilter);
  if (direct.length > 0) return pickMatch(direct, skillName, pluginQualifier);

  // Leaf-name fallback: the caller supplied only the final path segment
  // (e.g. "cli-design" for "ai/interface/cli-design"). A direct path lookup
  // missed because the skill lives under a nested path. Match by last segment.
  const byLeaf = findSkillsByLeaf(skillName, pluginQualifier, effectiveScope, effectivePluginFilter);
  if (byLeaf.length === 1) return byLeaf[0];
  if (byLeaf.length > 1) {
    throw ambiguous(formatLeafAmbiguousMessage(skillName, byLeaf), {
      skill: skillName,
      candidates: byLeaf.map((m) => ({
        id: formatSkillId(m),
        plugin: m.plugin,
        scope: m.scope,
        path: m.path,
      })),
      next: 'Multiple skills share this leaf name. Re-run with one of the full paths in candidates.',
    });
  }

  throw notFound(formatNotFoundMessage(rawName, skillName, pluginQualifier), {
    skill: skillName,
    plugin: pluginQualifier,
    scope: parsed.scope,
  });
}

/** Canonical, unambiguous identifier for a skill. Scope-root skills are
 *  qualified by scope; plugin skills by plugin name. */
function formatSkillId(s: Skill): string {
  return s.plugin === SCOPE_SKILL_PLUGIN ? `${s.scope}/${s.name}` : `${s.plugin}/${s.name}`;
}

/** Match skills whose final path segment equals `leaf`. Only meaningful when
 *  `leaf` is a bare segment (no slash) — a slashed query can never equal a
 *  single segment, so this returns empty and the caller falls through. */
function findSkillsByLeaf(
  leaf: string,
  pluginQualifier: string | undefined,
  scope: Scope | undefined,
  pluginFilter: string | undefined,
): Skill[] {
  if (leaf.includes('/')) return [];
  let all: Skill[];
  try {
    all = scope ? listAllSkills(scope) : listAllSkills();
  } catch {
    return [];
  }
  return all.filter((s) => {
    if ((s.name.split('/').pop() ?? s.name) !== leaf) return false;
    if (pluginQualifier && s.plugin !== pluginQualifier) return false;
    if (pluginFilter && s.plugin !== pluginFilter) return false;
    return true;
  });
}

function formatLeafAmbiguousMessage(leaf: string, matches: Skill[]): string {
  const ids = matches.map(formatSkillId).join(', ');
  return `ambiguous skill: ${leaf} matches multiple skills: ${ids}`;
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

function formatNotFoundMessage(
  rawName: string,
  skillName: string,
  pluginQualifier: string | undefined,
): string {
  const suggestions = suggestSkills(skillName, pluginQualifier);
  const lines: string[] = [`skill not found: ${rawName}`];
  lines.push('       expected forms: <name>, <plugin>/<name>, <scope>/<name>, <scope>/<plugin>/<name>');
  if (suggestions.length > 0) {
    const formatted = suggestions
      .map((s) =>
        s.plugin === SCOPE_SKILL_PLUGIN ? s.name : `${s.plugin}/${s.name}`,
      )
      .slice(0, 3);
    lines.push(`       did you mean: ${formatted.join(', ')}`);
  } else {
    lines.push('       run `crtr skill find list` or `crtr skill find search <query>` to discover skills');
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
  segments: string[];
}

const SCOPE_QUALIFIERS: ReadonlySet<string> = new Set<Scope>(['user', 'project']);

// Accepted identifier forms:
//   <name>                         — bare name; scope-root first, then plugins
//   <plugin>/<name>                — explicit plugin (plugin may contain slashes)
//   <scope>/<name>                 — scope-root in a specific scope
//   <scope>/<plugin>/<name>        — fully qualified; plugin-vs-path disambiguation is lookup-based in resolveSkill
export function parseSkillQualifier(raw: string): ParsedSkillQualifier {
  if (raw.includes(':')) {
    const suggested = raw.replace(/:/g, '/');
    throw new InputError({
      error: 'invalid_qualifier',
      message: "mixed separators ':' and '/' no longer supported; use slashes throughout",
      received: raw,
      field: 'name',
      next: `Use ${suggested}.`,
    });
  }
  const segments = raw.split('/');
  if (SCOPE_QUALIFIERS.has(segments[0])) {
    const scope = segments[0] as Scope;
    return { scope, segments: segments.slice(1) };
  }
  return { segments };
}

function orderPluginsByResolution(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const score = (p: InstalledPlugin) => {
    if (p.scope === 'builtin') return 4;
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

export interface CategoryResolution {
  id: string;
  plugin: string | undefined;
  scope: Scope | undefined;
  dir: string;
  indexPath: string | undefined;
  skills: Skill[];
}

export function resolveCategory(
  name: string,
  opts: SkillResolutionOpts = {},
): CategoryResolution | null {
  const parsed = parseSkillQualifier(name);
  if (parsed.segments.length === 0) return null;

  const effectiveScope: Scope | undefined = opts.scope ?? parsed.scope;

  let pluginQualifier: string | undefined;
  let subpath: string | undefined;

  if (opts.pluginFilter !== undefined) {
    pluginQualifier = opts.pluginFilter;
    const sub = parsed.segments.join('/');
    subpath = sub || undefined;
  } else if (parsed.segments.length > 1) {
    const maybePlugin = parsed.segments[0];
    const pluginMatch =
      findPluginByName(maybePlugin, effectiveScope) ??
      (effectiveScope === undefined ? null : findPluginByName(maybePlugin));
    if (pluginMatch !== null) {
      pluginQualifier = maybePlugin;
      subpath = parsed.segments.slice(1).join('/');
    } else {
      pluginQualifier = undefined;
      subpath = parsed.segments.join('/');
    }
  } else {
    const maybePlugin = parsed.segments[0];
    const pluginMatch =
      findPluginByName(maybePlugin, effectiveScope) ??
      (effectiveScope === undefined ? null : findPluginByName(maybePlugin));
    if (pluginMatch !== null) {
      pluginQualifier = maybePlugin;
      subpath = undefined;
    } else {
      pluginQualifier = undefined;
      subpath = maybePlugin;
    }
  }

  let skills: Skill[];
  let dir: string;
  let id: string;
  let resolvedScope: Scope | undefined;

  if (pluginQualifier !== undefined) {
    const plugin =
      findPluginByName(pluginQualifier, effectiveScope) ??
      (effectiveScope === undefined ? null : findPluginByName(pluginQualifier));
    if (!plugin) return null;

    resolvedScope = plugin.scope;
    const allPluginSkills = listSkillsInPlugin(plugin);

    if (subpath === undefined) {
      skills = allPluginSkills;
      dir = join(plugin.root, SKILLS_DIR);
      id = pluginQualifier;
    } else {
      skills = allPluginSkills.filter((s) => s.name.startsWith(subpath! + '/'));
      dir = join(plugin.root, SKILLS_DIR, ...subpath.split('/'));
      id = `${pluginQualifier}/${subpath}`;
    }
  } else if (subpath !== undefined) {
    const scope = effectiveScope ?? 'user';
    resolvedScope = scope;
    const skillsRoot = scopeSkillsDir(scope);
    if (!skillsRoot) return null;
    const allScopeSkills = listScopeRootSkills(scope);
    skills = allScopeSkills.filter((s) => s.name.startsWith(subpath! + '/'));
    dir = join(skillsRoot, ...subpath.split('/'));
    id = `${scope}/${subpath}`;
  } else {
    return null;
  }

  if (skills.length === 0) return null;

  const indexMd = join(dir, 'index.md');
  const indexPath = pathExists(indexMd) ? indexMd : undefined;

  return { id, plugin: pluginQualifier, scope: resolvedScope, dir, indexPath, skills };
}

export function buildCategoryIndex(cat: CategoryResolution): string {
  const lines: string[] = [];
  lines.push(`# ${cat.id} — ${cat.skills.length} skills`);
  lines.push('');

  if (cat.indexPath !== undefined) {
    const authored = readTextIfExists(cat.indexPath);
    if (authored !== null) {
      const { body } = parseFrontmatter(authored);
      const trimmed = body.trim();
      if (trimmed.length > 0) {
        lines.push(trimmed);
        lines.push('');
      }
    }
  }

  lines.push('## Skills');
  const sorted = [...cat.skills].sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of sorted) {
    const fullId =
      skill.plugin === SCOPE_SKILL_PLUGIN
        ? `${skill.scope}/${skill.name}`
        : `${skill.plugin}/${skill.name}`;
    const desc = skill.frontmatter.description ?? '(no description)';
    lines.push(`- \`${fullId}\` — ${desc}`);
  }
  lines.push('');
  lines.push(
    `Read one with \`crtr skill read <full-id>\`. Narrow with \`crtr skill find list --plugin ${
      cat.plugin ?? cat.id
    }\`.`,
  );

  return lines.join('\n');
}

export function scopeRootsLabel(): string {
  const proj = projectScopeRoot();
  return proj ? `project=${proj}, user=${userScopeRoot()}` : `user=${userScopeRoot()}`;
}
