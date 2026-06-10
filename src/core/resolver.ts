import { join } from 'node:path';
import type {
  InstalledMarketplace,
  InstalledPlugin,
  Scope,
} from '../types.js';
import { readConfig } from './config.js';
import { listDirs, pathExists } from './fs-utils.js';
import { readMarketplaceManifest, readPluginManifest } from './manifest.js';
import { InputError } from './io.js';
import {
  marketplacesDir,
  pluginsDir,
  projectScopeRoot,
  userScopeRoot,
} from './scope.js';

export function listInstalledPlugins(scope: Scope): InstalledPlugin[] {
  // The builtin scope has no scopeRoot, so pluginsDir('builtin') is null and
  // this returns [] — builtin content is the memory substrate, not plugins.
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

export interface ParsedSkillQualifier {
  scope?: Scope;
  segments: string[];
}

const SCOPE_QUALIFIERS: ReadonlySet<string> = new Set<Scope>(['user', 'project']);

// Accepted identifier forms:
//   <name>                         — bare name; scope-root first, then plugins
//   <plugin>/<name>                — explicit plugin (plugin may contain slashes)
//   <scope>/<name>                 — scope-root in a specific scope
//   <scope>/<plugin>/<name>        — fully qualified
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
