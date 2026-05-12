import { Command } from 'commander';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { SCHEMA_VERSION } from '../types.js';
import type { Scope } from '../types.js';
import { notFound, usage, general } from '../core/errors.js';
import { out, hint, info, jsonOut, handleError, isTTY } from '../core/output.js';
import {
  pluginsDir,
  ensureProjectScopeRoot,
  resolveScopeArg,
  listScopes,
  userScopeRoot,
  scopeRoot,
} from '../core/scope.js';
import { updateConfig, updateState, ensureScopeInitialized } from '../core/config.js';
import {
  listInstalledPlugins,
  listAllPlugins,
  findPluginByName,
  listSkillsInPlugin,
} from '../core/resolver.js';
import { pathExists, ensureDir, removePath, nowIso } from '../core/fs-utils.js';
import { clone, pull, deriveNameFromUrl } from '../core/git.js';
import { readPluginManifest } from '../core/manifest.js';

const KNOWN_VERBS = new Set([
  'list',
  'show',
  'install',
  'uninstall',
  'enable',
  'disable',
  'update',
]);

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;

function isGitUrl(arg: string): boolean {
  return GIT_URL_RE.test(arg) || arg.endsWith('.git');
}

export function registerPluginCommands(program: Command): void {
  const plugin = program
    .command('plugin [nameOrVerb] [rest...]')
    .description('manage plugins')
    .action(async (nameOrVerb: string | undefined, rest: string[]) => {
      if (nameOrVerb === undefined) {
        plugin.help();
        return;
      }
      if (!KNOWN_VERBS.has(nameOrVerb)) {
        try {
          await showPlugin(nameOrVerb, { json: false });
        } catch (e) {
          handleError(e);
        }
        return;
      }
      // Known verbs dispatched by commander subcommands; nothing to do here.
      void rest;
    });

  // list
  plugin
    .command('list')
    .description('list installed plugins')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--json', 'emit JSON')
    .action(async (opts: { scope?: string; json?: boolean }) => {
      try {
        const scopes = listScopes(opts.scope);
        const plugins = scopes
          .flatMap((s: Scope) => listInstalledPlugins(s))
          .sort((a, b) => {
            if (a.scope === 'project' && b.scope !== 'project') return -1;
            if (a.scope !== 'project' && b.scope === 'project') return 1;
            return a.name.localeCompare(b.name);
          });

        if (opts.json) {
          jsonOut({
            plugins: plugins.map((p) => ({
              name: p.name,
              scope: p.scope,
              version: p.version,
              source_marketplace: p.sourceMarketplace,
              description: p.manifest.description,
              enabled: p.enabled,
              root: p.root,
            })),
          });
          return;
        }

        for (const p of plugins) {
          const version = p.version !== undefined ? `@${p.version}` : '';
          const mkt = p.sourceMarketplace !== undefined ? `  [${p.sourceMarketplace}]` : '';
          const desc = p.manifest.description !== undefined ? `  ${p.manifest.description}` : '';
          out(`${p.scope}:${p.name}${version}${mkt}${desc}`);
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });

  // show
  plugin
    .command('show <name>')
    .description('print plugin.json and skill index (default verb)')
    .option('--json', 'emit JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        await showPlugin(name, opts);
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });

  // install
  plugin
    .command('install <gitUrlOrName>')
    .description('install a plugin from a git URL or marketplace name')
    .option('--scope <scope>', 'user|project (default: user)')
    .option('--ref <branch>', 'git branch/tag/ref to clone')
    .action(
      async (
        gitUrlOrName: string,
        opts: { scope?: string; ref?: string },
      ) => {
        try {
          if (!isGitUrl(gitUrlOrName)) {
            throw usage(
              `"${gitUrlOrName}" is not a git URL and no matching marketplace plugin was found.\n` +
                `Use \`crtr marketplace install <mkt>:<name>\` to install from a marketplace.`,
              { code: 'USAGE' },
            );
          }

          const url = gitUrlOrName;
          let scope: Scope = 'user';
          if (opts.scope !== undefined) {
            const resolved = resolveScopeArg(opts.scope);
            if (resolved === 'all') {
              throw usage('--scope must be user or project, not all');
            }
            scope = resolved;
          } else {
            hint(
              'No --scope provided; defaulting to user scope (~/.crouter/plugins/).' +
                ' Pass --scope project to install into the project scope.',
            );
          }

          let scopeRootPath: string;
          if (scope === 'project') {
            scopeRootPath = ensureProjectScopeRoot();
            ensureScopeInitialized(scope, scopeRootPath);
          } else {
            scopeRootPath = userScopeRoot();
            ensureScopeInitialized(scope, scopeRootPath);
          }

          const pDir = join(scopeRootPath, 'plugins');
          ensureDir(pDir);

          const tempName = deriveNameFromUrl(url);
          const tempDir = join(pDir, tempName);

          if (pathExists(tempDir)) {
            throw general(
              `plugin directory already exists: ${tempDir}\n` +
                `Uninstall the existing plugin first with \`crtr plugin uninstall ${tempName}\`.`,
            );
          }

          clone(url, tempDir, { ref: opts.ref, depth: 1 });

          const manifest = readPluginManifest(tempDir);
          if (manifest === null) {
            removePath(tempDir);
            throw general(
              `cloned repo does not contain a valid .crouter-plugin/plugin.json: ${url}`,
            );
          }

          const finalName = manifest.name;
          let finalDir = tempDir;

          if (finalName !== tempName) {
            const candidateDir = join(pDir, finalName);
            if (pathExists(candidateDir)) {
              removePath(tempDir);
              throw general(
                `plugin "${finalName}" is already installed at ${candidateDir}`,
              );
            }
            renameSync(tempDir, candidateDir);
            finalDir = candidateDir;
          }

          updateConfig(scope, (cfg) => {
            cfg.plugins[finalName] = {
              enabled: true,
              version: manifest.version,
            };
          });

          info(`installed plugin "${finalName}"${manifest.version !== undefined ? ` v${manifest.version}` : ''} (${scope} scope)`);
          out(finalDir);
        } catch (e) {
          handleError(e);
        }
      },
    );

  // uninstall
  plugin
    .command('uninstall <name>')
    .description('remove a plugin and its config entry')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--yes', 'skip confirmation in non-TTY mode')
    .action(async (name: string, opts: { scope?: string; yes?: boolean }) => {
      try {
        if (!isTTY() && !opts.yes) {
          throw usage(
            `uninstall requires --yes in non-TTY mode: crtr plugin uninstall ${name} --yes`,
          );
        }

        const scopes = listScopes(opts.scope);
        let removed = false;

        for (const scope of scopes) {
          const pDir = pluginsDir(scope);
          if (pDir === null) continue;
          const pluginDir = join(pDir, name);
          if (!pathExists(pluginDir)) continue;

          removePath(pluginDir);
          updateConfig(scope, (cfg) => {
            delete cfg.plugins[name];
          });

          info(`uninstalled plugin "${name}" from ${scope} scope`);
          removed = true;
        }

        if (!removed) {
          throw notFound(`plugin not found: ${name}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // enable
  plugin
    .command('enable <name>')
    .description('enable a plugin')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .action(async (name: string, opts: { scope?: string }) => {
      try {
        await setEnabled(name, true, opts.scope);
      } catch (e) {
        handleError(e);
      }
    });

  // disable
  plugin
    .command('disable <name>')
    .description('disable a plugin without removing it')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .action(async (name: string, opts: { scope?: string }) => {
      try {
        await setEnabled(name, false, opts.scope);
      } catch (e) {
        handleError(e);
      }
    });

  // update
  plugin
    .command('update [name]')
    .description('git pull one or all enabled non-marketplace plugins')
    .action(async (name: string | undefined) => {
      try {
        let targets: Array<{ name: string; scope: Scope; root: string }>;

        if (name !== undefined) {
          const found = findPluginByName(name);
          if (found === null) {
            throw notFound(`plugin not found: ${name}`);
          }
          targets = [{ name: found.name, scope: found.scope, root: found.root }];
        } else {
          const all = listAllPlugins();
          targets = all
            .filter((p) => p.enabled && !p.sourceMarketplace)
            .map((p) => ({ name: p.name, scope: p.scope, root: p.root }));
        }

        if (targets.length === 0) {
          info('no plugins to update');
          return;
        }

        for (const target of targets) {
          const res = pull(target.root);
          if (res.status !== 0) {
            info(`failed to update "${target.name}": ${res.stderr.trim()}`);
            continue;
          }

          const manifest = readPluginManifest(target.root);
          if (manifest !== null) {
            updateConfig(target.scope, (cfg) => {
              const entry = cfg.plugins[target.name];
              if (entry !== undefined) {
                entry.version = manifest.version;
              } else {
                cfg.plugins[target.name] = {
                  enabled: true,
                  version: manifest.version,
                };
              }
            });
            updateState(target.scope, (s) => {
              if (s.plugins[target.name] === undefined) {
                s.plugins[target.name] = {};
              }
              s.plugins[target.name].last_updated = nowIso();
            });
          }

          const version = manifest !== null && manifest.version !== undefined
            ? ` → v${manifest.version}`
            : '';
          info(`updated "${target.name}"${version}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
}

async function showPlugin(name: string, opts: { json?: boolean }): Promise<void> {
  const found = findPluginByName(name);
  if (found === null) {
    throw notFound(`plugin not found: ${name}`);
  }

  const skills = listSkillsInPlugin(found);

  if (opts.json) {
    jsonOut({
      plugin: {
        name: found.manifest.name,
        version: found.manifest.version,
        description: found.manifest.description,
        source: found.manifest.source,
        owner: found.manifest.owner,
        scope: found.scope,
        root: found.root,
        enabled: found.enabled,
      },
      skills: skills.map((s) => ({
        name: s.name,
        description: s.frontmatter.description,
        path: s.path,
      })),
    });
    return;
  }

  const manifest = found.manifest;
  const version = manifest.version !== undefined ? ` v${manifest.version}` : '';
  const desc = manifest.description !== undefined ? `\n  ${manifest.description}` : '';
  const source = manifest.source !== undefined ? `\n  source: ${manifest.source}` : '';
  out(`${manifest.name}${version} (${found.scope})${desc}${source}`);

  if (skills.length > 0) {
    out('');
    out('Skills:');
    for (const s of skills) {
      const skillDesc = s.frontmatter.description !== undefined
        ? ` — ${s.frontmatter.description}`
        : '';
      out(`  ${s.name}${skillDesc}`);
    }
  }

  hint(`crtr: update with \`crtr plugin update ${name}\``);
}

async function setEnabled(
  name: string,
  enabled: boolean,
  scopeOpt: string | undefined,
): Promise<void> {
  const scopes = listScopes(scopeOpt);
  let acted = false;

  for (const scope of scopes) {
    const pDir = pluginsDir(scope);
    if (pDir === null) continue;
    const pluginDir = join(pDir, name);
    if (!pathExists(pluginDir)) continue;

    updateConfig(scope, (cfg) => {
      const entry = cfg.plugins[name];
      if (entry !== undefined) {
        entry.enabled = enabled;
      } else {
        cfg.plugins[name] = { enabled };
      }
    });

    info(`plugin "${name}" ${enabled ? 'enabled' : 'disabled'} in ${scope} scope`);
    acted = true;
  }

  if (!acted) {
    throw notFound(`plugin not found: ${name}`);
  }
}
