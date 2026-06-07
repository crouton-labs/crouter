import { join, isAbsolute } from 'node:path';
import { renameSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../../core/command.js';
import { notFound } from '../../core/errors.js';
import { listAllMarketplaces, findMarketplaceByName } from '../../core/resolver.js';
import { resolveScopeArg, requireScopeRoot } from '../../core/scope.js';
import { updateConfig, updateState, ensureScopeInitialized, readConfig } from '../../core/config.js';
import { pathExists, ensureDir, removePath, linkOrCopy, isSymlink, nowIso } from '../../core/fs-utils.js';
import { clone, pull, deriveNameFromUrl, currentSha } from '../../core/git.js';
import { readMarketplaceManifest, readPluginManifest } from '../../core/manifest.js';
import type { Scope } from '../../types.js';
import { resolveInstallScope } from './shared.js';

// ---------------------------------------------------------------------------
// market.manage.add
// ---------------------------------------------------------------------------

const marketAdd = defineLeaf({
  name: 'add',
  description: 'add a marketplace by git URL',
  whenToUse: 'registering a new marketplace by git URL so its plugins become installable by name',
  help: {
    name: 'pkg market manage add',
    summary: 'add a marketplace by git URL',
    params: [
      { kind: 'flag', name: 'url', type: 'string', required: true, constraint: 'Git URL of the marketplace repo.' },
      { kind: 'flag', name: 'ref', type: 'string', required: false, constraint: 'Git ref to track. Default: main.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Marketplace name as declared in marketplace.json.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the marketplace was added into.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the cloned marketplace directory.' },
    ],
    outputKind: 'object',
    effects: ['Clones the marketplace repo. Registers the marketplace in config.json.'],
  },
  run: async (input) => {
    const url = input['url'] as string;
    const ref = input['ref'] as string | undefined;
    const scopeInput = input['scope'] as string | undefined;

    const scope = resolveInstallScope(scopeInput);
    const root = requireScopeRoot(scope);
    ensureScopeInitialized(scope, root);

    const tempName = deriveNameFromUrl(url);
    const mktsDir = join(root, 'marketplaces');
    ensureDir(mktsDir);
    const tempDest = join(mktsDir, tempName);

    if (pathExists(tempDest)) {
      removePath(tempDest);
    }

    clone(url, tempDest, { depth: 1, ref: ref !== undefined ? ref : undefined });

    const manifest = readMarketplaceManifest(tempDest);
    if (!manifest) {
      removePath(tempDest);
      throw notFound(
        `marketplace manifest not found at ${tempDest}/.crouter-marketplace/marketplace.json — not a valid marketplace`,
      );
    }

    const finalName = manifest.name;
    const finalDest = join(mktsDir, finalName);

    if (finalName !== tempName) {
      if (pathExists(finalDest)) {
        removePath(finalDest);
      }
      renameSync(tempDest, finalDest);
    }

    const effectiveRef = ref !== undefined ? ref : 'main';
    updateConfig(scope, (cfg) => {
      cfg.marketplaces[finalName] = {
        url,
        ref: effectiveRef,
        installed_at: nowIso(),
      };
    });

    return { name: finalName, scope, path: finalDest };
  },
});

// ---------------------------------------------------------------------------
// market.manage.remove
// ---------------------------------------------------------------------------

const marketRemove = defineLeaf({
  name: 'remove',
  description: 'remove a marketplace',
  whenToUse: 'unregistering a marketplace: deletes it and any plugins installed from it',
  help: {
    name: 'pkg market manage remove',
    summary: 'remove a marketplace and its directory',
    params: [
      { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Marketplace name to remove.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Removed marketplace name.' },
      { name: 'removed', type: 'boolean', required: true, constraint: 'Always true on success.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the marketplace directory. Removes the entry from config.json.'],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const scopeInput = input['scope'] as string | undefined;

    let targetScope: Scope | undefined;
    let mktRoot: string | undefined;

    if (scopeInput !== undefined) {
      const resolved = resolveScopeArg(scopeInput);
      if (resolved !== 'all' && resolved !== 'builtin') {
        const s = resolved as Scope;
        const found = findMarketplaceByName(name, s);
        if (!found) throw notFound(`marketplace not found: ${name} (scope: ${s})`);
        targetScope = s;
        mktRoot = found.root;
      } else {
        const found = findMarketplaceByName(name);
        if (!found) throw notFound(`marketplace not found: ${name}`);
        targetScope = found.scope;
        mktRoot = found.root;
      }
    } else {
      const found = findMarketplaceByName(name);
      if (!found) throw notFound(`marketplace not found: ${name}`);
      targetScope = found.scope;
      mktRoot = found.root;
    }

    const scope = targetScope;
    const scopeRootPath = requireScopeRoot(scope);
    const plgDir = join(scopeRootPath, 'plugins');

    const cfg = readConfig(scope);
    const pluginsToRemove: string[] = [];
    for (const [pluginName, entry] of Object.entries(cfg.plugins)) {
      if (entry.source_marketplace === name) {
        pluginsToRemove.push(pluginName);
      }
    }

    for (const pluginName of pluginsToRemove) {
      const pluginPath = join(plgDir, pluginName);
      removePath(pluginPath);
    }

    removePath(mktRoot);

    updateConfig(scope, (c) => {
      delete c.marketplaces[name];
      for (const pluginName of pluginsToRemove) {
        delete c.plugins[pluginName];
      }
    });

    return { name, removed: true };
  },
});

// ---------------------------------------------------------------------------
// market.manage.update
// Single marketplace: blocking. All marketplaces: job handle.
// ---------------------------------------------------------------------------

const marketUpdate = defineLeaf({
  name: 'update',
  description: 'pull latest marketplace index',
  whenToUse: 'refreshing the plugin index of one named marketplace from git, or of all registered marketplaces when no name is given',
  help: {
    name: 'pkg market manage update',
    summary: 'git pull updates for one or all registered marketplaces',
    params: [
      { kind: 'flag', name: 'marketplace', type: 'string', required: false, constraint: 'Marketplace name to update. Omit to update all (returns a job handle).' },
    ],
    output: [
      { name: 'updated', type: 'object[]', required: false, constraint: 'Present for single (blocking) path: [{name, updated, sha}].' },
      { name: 'updated', type: 'object[]', required: true, constraint: 'One entry per marketplace processed: {name, updated, sha}.' },
    ],
    outputKind: 'object',
    effects: ['Runs git pull in marketplace directories.'],
  },
  run: async (input) => {
    const name = input['marketplace'] as string | undefined;

    async function doUpdate(
      targets: Array<{ name: string; scope: Scope; root: string }>,
    ): Promise<Array<{ name: string; updated: boolean; sha: string }>> {
      const results: Array<{ name: string; updated: boolean; sha: string }> = [];
      for (const target of targets) {
        const shaBefore = currentSha(target.root);
        const res = pull(target.root);
        if (res.status !== 0) {
          results.push({ name: target.name, updated: false, sha: shaBefore !== null ? shaBefore : '' });
          continue;
        }
        const shaAfter = currentSha(target.root);
        const updated = shaBefore !== shaAfter;

        const freshManifest = readMarketplaceManifest(target.root);

        updateState(target.scope, (s) => {
          if (s.marketplaces[target.name] === undefined) {
            s.marketplaces[target.name] = {};
          }
          s.marketplaces[target.name].last_updated = nowIso();
        });

        const cfg = readConfig(target.scope);
        for (const [pluginName, entry] of Object.entries(cfg.plugins)) {
          if (entry.source_marketplace !== target.name) continue;
          const scopeRootPath = requireScopeRoot(target.scope);
          const pluginPath = join(scopeRootPath, 'plugins', pluginName);
          if (isSymlink(pluginPath)) {
            // content updated by marketplace pull above
          } else if (pathExists(pluginPath)) {
            pull(pluginPath);
          }
          if (freshManifest !== null) {
            const pluginEntry = freshManifest.plugins.find((p) => p.name === pluginName);
            if (pluginEntry !== undefined && pluginEntry.version !== undefined) {
              updateConfig(target.scope, (c) => {
                if (c.plugins[pluginName] !== undefined) {
                  c.plugins[pluginName].version = pluginEntry.version;
                }
              });
            }
          }
          updateState(target.scope, (s) => {
            if (s.plugins[pluginName] === undefined) {
              s.plugins[pluginName] = {};
            }
            s.plugins[pluginName].last_updated = nowIso();
          });
        }

        results.push({ name: target.name, updated, sha: shaAfter !== null ? shaAfter : '' });
      }
      return results;
    }

    if (name !== undefined) {
      // Single marketplace — blocking
      const found = findMarketplaceByName(name);
      if (!found) throw notFound(`marketplace not found: ${name}`);
      const results = await doUpdate([{ name: found.name, scope: found.scope, root: found.root }]);
      return { updated: results };
    }

    // All marketplaces — run synchronously (the underlying git pulls are sync).
    const all = listAllMarketplaces();
    const targets = all.map((m) => ({ name: m.name, scope: m.scope, root: m.root }));
    const results = await doUpdate(targets);
    return { updated: results };
  },
});

// ---------------------------------------------------------------------------
// market.manage.install
// ---------------------------------------------------------------------------

const marketInstall = defineLeaf({
  name: 'install',
  description: 'install a plugin from a marketplace',
  whenToUse: 'installing a plugin by name from a marketplace you have already registered',
  help: {
    name: 'pkg market manage install',
    summary: 'install a plugin from an added marketplace by plugin name',
    params: [
      { kind: 'flag', name: 'marketplace', type: 'string', required: true, constraint: 'Marketplace name (must already be added via `pkg market manage add`).' },
      { kind: 'flag', name: 'plugin', type: 'string', required: true, constraint: 'Plugin name as listed in the marketplace manifest.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Installed plugin name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the plugin was installed into.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the installed plugin directory.' },
    ],
    outputKind: 'object',
    effects: ['Clones or copies the plugin from the marketplace into the scope plugins directory. Registers the plugin in config.json with source_marketplace set.'],
  },
  run: async (input) => {
    const mktName = input['marketplace'] as string;
    const pluginName = input['plugin'] as string;
    const scopeInput = input['scope'] as string | undefined;

    const mkt = findMarketplaceByName(mktName);
    if (!mkt) throw notFound(`marketplace not found: ${mktName}`);

    const entry = mkt.manifest.plugins.find((p) => p.name === pluginName);
    if (!entry) throw notFound(`plugin "${pluginName}" not found in marketplace "${mktName}"`);

    const destScope = resolveInstallScope(scopeInput);
    const destRoot = requireScopeRoot(destScope);
    ensureScopeInitialized(destScope, destRoot);
    const destPluginDir = join(destRoot, 'plugins', pluginName);

    const source = entry.source;
    const isRelativePath =
      source.startsWith('./') ||
      source.startsWith('../') ||
      (!source.includes('://') && !isAbsolute(source));

    if (isRelativePath) {
      const sourcePath = join(mkt.root, source);
      if (!pathExists(sourcePath)) {
        throw notFound(`plugin source path does not exist: ${sourcePath}`);
      }
      linkOrCopy(sourcePath, destPluginDir);
    } else {
      if (pathExists(destPluginDir)) {
        removePath(destPluginDir);
      }
      clone(source, destPluginDir, { depth: 1 });
    }

    const pluginManifest = readPluginManifest(destPluginDir);
    if (!pluginManifest) {
      removePath(destPluginDir);
      throw notFound(`plugin manifest not found at ${destPluginDir}/.crouter-plugin/plugin.json`);
    }

    const version = entry.version !== undefined ? entry.version : pluginManifest.version;

    updateConfig(destScope, (cfg) => {
      const pluginCfg: { enabled: boolean; source_marketplace: string; version?: string } = {
        enabled: true,
        source_marketplace: mktName,
      };
      if (version !== undefined) {
        pluginCfg.version = version;
      }
      cfg.plugins[pluginName] = pluginCfg;
    });

    return { name: pluginName, scope: destScope, path: destPluginDir };
  },
});

export const marketManageBranch = defineBranch({
  name: 'manage',
  description: 'add, remove, update, install',
  whenToUse: 'changing marketplace state: add or remove a marketplace, refresh its index, or install a plugin from it',
  help: {
    name: 'pkg market manage',
    summary: 'add, remove, update, or install from marketplaces',
  },
  children: [marketAdd, marketRemove, marketUpdate, marketInstall],
});
