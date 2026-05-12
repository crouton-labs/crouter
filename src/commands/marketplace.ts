import { Command } from 'commander';
import { join, isAbsolute } from 'node:path';
import { renameSync } from 'node:fs';
import type { Scope } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';
import { notFound, usage } from '../core/errors.js';
import { out, err, hint, info, jsonOut, handleError } from '../core/output.js';
import {
  requireScopeRoot,
  marketplacesDir,
  pluginsDir,
  resolveScopeArg,
  userScopeRoot,
  projectScopeRoot,
} from '../core/scope.js';
import { readConfig, writeConfig, updateConfig, updateState, ensureScopeInitialized } from '../core/config.js';
import {
  listInstalledMarketplaces,
  listAllMarketplaces,
  findMarketplaceByName,
  listInstalledPlugins,
} from '../core/resolver.js';
import { pathExists, ensureDir, removePath, linkOrCopy, isSymlink, nowIso } from '../core/fs-utils.js';
import { clone, pull, deriveNameFromUrl } from '../core/git.js';
import { readMarketplaceManifest, readPluginManifest } from '../core/manifest.js';

export function registerMarketplaceCommands(program: Command): void {
  const marketplace = program
    .command('marketplace')
    .description('manage marketplaces');

  // list
  marketplace
    .command('list')
    .description('list installed marketplaces across all scopes')
    .option('--json', 'emit JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const all = listAllMarketplaces();

        if (opts.json) {
          jsonOut({
            marketplaces: all.map((m) => ({
              name: m.name,
              scope: m.scope,
              url: m.url,
              ref: m.ref,
              version: m.manifest.version,
              plugins_count: m.manifest.plugins.length,
              root: m.root,
            })),
          });
          return;
        }

        for (const m of all) {
          const version = m.manifest.version !== undefined ? m.manifest.version : 'unknown';
          out(`${m.scope}:${m.name}@${version}  ${m.url}  (${m.manifest.plugins.length} plugins)`);
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });

  // add
  marketplace
    .command('add <git-url>')
    .description('clone and register a marketplace')
    .option('--scope <scope>', 'user|project (default: user)')
    .option('--ref <branch>', 'branch/tag to clone')
    .action(async (gitUrl: string, opts: { scope?: string; ref?: string }) => {
      try {
        const scope: Scope = opts.scope !== undefined
          ? (resolveScopeArg(opts.scope) as Scope)
          : 'user';

        if (scope === 'all' as string) {
          throw usage('--scope must be user or project, not all');
        }

        hint(`default scope is user (private); pass --scope project to share with collaborators`);

        const root = requireScopeRoot(scope);
        ensureScopeInitialized(scope, root);

        const tempName = deriveNameFromUrl(gitUrl);
        const mktsDir = join(root, 'marketplaces');
        ensureDir(mktsDir);
        const tempDest = join(mktsDir, tempName);

        if (pathExists(tempDest)) {
          removePath(tempDest);
        }

        info(`cloning ${gitUrl}...`);
        clone(gitUrl, tempDest, { depth: 1, ref: opts.ref });

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

        updateConfig(scope, (cfg) => {
          const ref = opts.ref !== undefined ? opts.ref : 'main';
          cfg.marketplaces[finalName] = {
            url: gitUrl,
            ref,
            installed_at: nowIso(),
          };
        });

        out(finalDest);
        info(`marketplace "${finalName}" added to ${scope} scope`);
      } catch (e) {
        handleError(e);
      }
    });

  // remove
  marketplace
    .command('remove <name>')
    .description('remove a marketplace and its sourced plugins')
    .option('--scope <scope>', 'user|project')
    .action(async (name: string, opts: { scope?: string }) => {
      try {
        const scopeArg = opts.scope !== undefined ? resolveScopeArg(opts.scope) : undefined;

        let targetScope: Scope | undefined;
        let mktRoot: string | undefined;

        if (scopeArg !== undefined && scopeArg !== 'all') {
          const s = scopeArg as Scope;
          const found = findMarketplaceByName(name, s);
          if (!found) {
            throw notFound(`marketplace not found: ${name} (scope: ${s})`);
          }
          targetScope = s;
          mktRoot = found.root;
        } else {
          const found = findMarketplaceByName(name);
          if (!found) {
            throw notFound(`marketplace not found: ${name}`);
          }
          targetScope = found.scope;
          mktRoot = found.root;
        }

        const scope = targetScope;
        const root = requireScopeRoot(scope);
        const plgDir = join(root, 'plugins');

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
          info(`removed plugin "${pluginName}" (sourced from ${name})`);
        }

        removePath(mktRoot);

        updateConfig(scope, (c) => {
          delete c.marketplaces[name];
          for (const pluginName of pluginsToRemove) {
            delete c.plugins[pluginName];
          }
        });

        info(`marketplace "${name}" removed from ${scope} scope`);
      } catch (e) {
        handleError(e);
      }
    });

  // browse
  marketplace
    .command('browse <name>')
    .description('list available plugins in a marketplace, marking installed ones')
    .option('--json', 'emit JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const mkt = findMarketplaceByName(name);
        if (!mkt) {
          throw notFound(`marketplace not found: ${name}`);
        }

        const allPlugins = listInstalledPlugins('user').concat(
          projectScopeRoot() ? listInstalledPlugins('project') : [],
        );

        const installedMap = new Map<string, Scope>();
        for (const p of allPlugins) {
          if (!installedMap.has(p.name)) {
            installedMap.set(p.name, p.scope);
          }
        }

        if (opts.json) {
          jsonOut({
            marketplace: mkt.name,
            plugins: mkt.manifest.plugins.map((entry) => {
              const installedScope = installedMap.get(entry.name);
              const installed = installedScope !== undefined;
              const result: Record<string, unknown> = {
                name: entry.name,
                version: entry.version,
                description: entry.description,
                keywords: entry.keywords,
                installed,
              };
              if (installed) {
                result.installed_scope = installedScope;
              }
              return result;
            }),
          });
          return;
        }

        for (const entry of mkt.manifest.plugins) {
          const installedScope = installedMap.get(entry.name);
          const installed = installedScope !== undefined;
          const mark = installed ? '[x]' : '[ ]';
          const version = entry.version !== undefined ? `@${entry.version}` : '';
          const desc = entry.description !== undefined ? `  ${entry.description}` : '';
          out(`${mark} ${entry.name}${version}${desc}`);
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });

  // update
  marketplace
    .command('update [name]')
    .description('git pull marketplace(s) and update their sourced plugins')
    .action(async (name: string | undefined, _opts: Record<string, unknown>) => {
      try {
        const toUpdate = name !== undefined
          ? (() => {
              const found = findMarketplaceByName(name);
              if (!found) {
                throw notFound(`marketplace not found: ${name}`);
              }
              return [found];
            })()
          : listAllMarketplaces();

        for (const mkt of toUpdate) {
          info(`updating marketplace "${mkt.name}" (${mkt.scope})...`);

          const pullResult = pull(mkt.root);
          if (pullResult.status !== 0) {
            err(`crtr: git pull failed for ${mkt.name}: ${pullResult.stderr.trim()}`);
            continue;
          }

          const freshManifest = readMarketplaceManifest(mkt.root);
          const newVersion = freshManifest !== null && freshManifest.version !== undefined
            ? freshManifest.version
            : undefined;

          updateState(mkt.scope, (s) => {
            if (!s.marketplaces[mkt.name]) {
              s.marketplaces[mkt.name] = {};
            }
            s.marketplaces[mkt.name].last_updated = nowIso();
          });

          // newVersion is available but ConfigMarketplaceEntry has no version field; state tracks last_updated

          const cfg = readConfig(mkt.scope);
          for (const [pluginName, entry] of Object.entries(cfg.plugins)) {
            if (entry.source_marketplace !== mkt.name) continue;

            const pluginPath = join(requireScopeRoot(mkt.scope), 'plugins', pluginName);
            if (isSymlink(pluginPath)) {
              // symlink points into marketplace; content is already updated by the pull above
              info(`plugin "${pluginName}" updated via symlink (marketplace pull)`);
            } else if (pathExists(pluginPath)) {
              // URL-sourced plugin — pull it too
              const pluginPullResult = pull(pluginPath);
              if (pluginPullResult.status !== 0) {
                err(`crtr: git pull failed for plugin "${pluginName}": ${pluginPullResult.stderr.trim()}`);
                continue;
              }
              info(`plugin "${pluginName}" updated`);
            }

            if (freshManifest !== null) {
              const pluginEntry = freshManifest.plugins.find((p) => p.name === pluginName);
              if (pluginEntry !== undefined && pluginEntry.version !== undefined) {
                updateConfig(mkt.scope, (c) => {
                  if (c.plugins[pluginName]) {
                    c.plugins[pluginName].version = pluginEntry.version;
                  }
                });
              }
            }

            updateState(mkt.scope, (s) => {
              if (!s.plugins[pluginName]) {
                s.plugins[pluginName] = {};
              }
              s.plugins[pluginName].last_updated = nowIso();
            });
          }

          info(`marketplace "${mkt.name}" up to date`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // install
  marketplace
    .command('install <marketplace-plugin>')
    .description('install a plugin from a marketplace using <marketplace>:<plugin> syntax')
    .option('--scope <scope>', 'user|project')
    .action(async (marketplacePlugin: string, opts: { scope?: string }) => {
      try {
        const colonIdx = marketplacePlugin.indexOf(':');
        if (colonIdx === -1) {
          throw usage(
            `argument must be in the form <marketplace>:<plugin> (e.g. crouton-kit:authoring)`,
          );
        }

        const mktName = marketplacePlugin.slice(0, colonIdx);
        const pluginName = marketplacePlugin.slice(colonIdx + 1);

        if (!mktName || !pluginName) {
          throw usage(
            `argument must be in the form <marketplace>:<plugin> (e.g. crouton-kit:authoring)`,
          );
        }

        const scopeArg = opts.scope !== undefined ? resolveScopeArg(opts.scope) : undefined;

        let mkt;
        if (scopeArg !== undefined && scopeArg !== 'all') {
          mkt = findMarketplaceByName(mktName, scopeArg as Scope);
        } else {
          mkt = findMarketplaceByName(mktName);
        }

        if (!mkt) {
          throw notFound(`marketplace not found: ${mktName}`);
        }

        const entry = mkt.manifest.plugins.find((p) => p.name === pluginName);
        if (!entry) {
          throw notFound(`plugin "${pluginName}" not found in marketplace "${mktName}"`);
        }

        let destScope: Scope;
        if (opts.scope !== undefined && scopeArg !== 'all') {
          destScope = scopeArg as Scope;
        } else {
          destScope = mkt.scope;
        }

        const destRoot = requireScopeRoot(destScope);
        ensureScopeInitialized(destScope, destRoot);
        const destPluginDir = join(destRoot, 'plugins', pluginName);

        const source = entry.source;
        const isRelativePath = source.startsWith('./') || source.startsWith('../') ||
          (!source.includes('://') && !isAbsolute(source));

        if (isRelativePath) {
          const sourcePath = join(mkt.root, source);
          if (!pathExists(sourcePath)) {
            throw notFound(
              `plugin source path does not exist: ${sourcePath}`,
            );
          }
          linkOrCopy(sourcePath, destPluginDir);
          info(`linked plugin "${pluginName}" → ${sourcePath}`);
        } else {
          // URL source — clone directly
          if (pathExists(destPluginDir)) {
            removePath(destPluginDir);
          }
          info(`cloning plugin "${pluginName}" from ${source}...`);
          clone(source, destPluginDir, { depth: 1 });
        }

        const pluginManifest = readPluginManifest(destPluginDir);
        if (!pluginManifest) {
          removePath(destPluginDir);
          throw notFound(
            `plugin manifest not found at ${destPluginDir}/.crouter-plugin/plugin.json`,
          );
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

        out(destPluginDir);
        info(`plugin "${pluginName}" installed to ${destScope} scope`);
      } catch (e) {
        handleError(e);
      }
    });
}
