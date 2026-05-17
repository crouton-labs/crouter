// `crtr pkg` subtree: replaces plugin.ts + marketplace.ts for the agent-first CLI.
// Sub-branches: plugin {manage {install,remove,enable,disable,update}, inspect {list,show}}
//               market {manage {add,remove,update,install}, inspect {list,browse}}

import { join, isAbsolute } from 'node:path';
import { renameSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { reqStr, str, bool, int } from '../core/io.js';
import { notFound, usage, general } from '../core/errors.js';
import { createJob, appendEvent, writeResult } from '../core/jobs.js';
import { paginate } from '../core/pagination.js';
import {
  listInstalledPlugins,
  listAllPlugins,
  findPluginByName,
  listSkillsInPlugin,
  listInstalledMarketplaces,
  listAllMarketplaces,
  findMarketplaceByName,
} from '../core/resolver.js';
import {
  pluginsDir,
  ensureProjectScopeRoot,
  resolveScopeArg,
  userScopeRoot,
  requireScopeRoot,
  projectScopeRoot,
} from '../core/scope.js';
import {
  updateConfig,
  updateState,
  ensureScopeInitialized,
  readConfig,
} from '../core/config.js';
import { pathExists, ensureDir, removePath, linkOrCopy, isSymlink, nowIso } from '../core/fs-utils.js';
import { clone, pull, deriveNameFromUrl, currentSha } from '../core/git.js';
import { readPluginManifest, readMarketplaceManifest } from '../core/manifest.js';
import type { Scope } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;

function isGitUrl(arg: string): boolean {
  return GIT_URL_RE.test(arg) || arg.endsWith('.git');
}

function resolveInstallScope(scopeInput: string | undefined): Scope {
  if (scopeInput !== undefined) {
    const resolved = resolveScopeArg(scopeInput);
    if (resolved === 'all' || resolved === 'builtin') {
      throw usage('scope must be "user" or "project"');
    }
    return resolved;
  }
  // Default: project if available, else user
  return projectScopeRoot() !== null ? 'project' : 'user';
}

// ---------------------------------------------------------------------------
// plugin.manage.install
// ---------------------------------------------------------------------------

const pluginInstall = defineLeaf({
  name: 'install',
  help: {
    name: 'pkg plugin manage install',
    summary: 'install a plugin from a git URL into the given scope',
    input: [
      { name: 'source', type: 'string', required: true, constraint: 'Git URL or relative path to the plugin directory.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
      { name: 'ref', type: 'string', required: false, constraint: 'Git ref (branch/tag) to clone. Default: default branch.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name as declared in plugin.json.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the plugin was installed into.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the installed plugin directory.' },
    ],
    outputKind: 'object',
    effects: ['Clones or copies the plugin into the scope plugins directory. Registers the plugin in config.json.'],
  },
  run: async (input) => {
    const source = reqStr(input, 'source');
    const scopeInput = str(input, 'scope');
    const ref = str(input, 'ref');

    if (!isGitUrl(source)) {
      throw usage(
        `"${source}" is not a git URL. Use \`pkg market manage install\` to install from a marketplace.`,
      );
    }

    const scope = resolveInstallScope(scopeInput);

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

    const tempName = deriveNameFromUrl(source);
    const tempDir = join(pDir, tempName);

    if (pathExists(tempDir)) {
      throw general(
        `plugin directory already exists: ${tempDir}\n` +
          `Uninstall the existing plugin first with \`pkg plugin manage remove\` {\"name\":\"${tempName}\"}`,
      );
    }

    clone(source, tempDir, { ref: ref !== undefined ? ref : undefined, depth: 1 });

    const manifest = readPluginManifest(tempDir);
    if (manifest === null) {
      removePath(tempDir);
      throw general(`cloned repo does not contain a valid .crouter-plugin/plugin.json: ${source}`);
    }

    const finalName = manifest.name;
    let finalDir = tempDir;

    if (finalName !== tempName) {
      const candidateDir = join(pDir, finalName);
      if (pathExists(candidateDir)) {
        removePath(tempDir);
        throw general(`plugin "${finalName}" is already installed at ${candidateDir}`);
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

    return { name: finalName, scope, path: finalDir };
  },
});

// ---------------------------------------------------------------------------
// plugin.manage.remove
// ---------------------------------------------------------------------------

const pluginRemove = defineLeaf({
  name: 'remove',
  help: {
    name: 'pkg plugin manage remove',
    summary: 'remove a plugin and its directory from the given scope',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name to remove.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: searches all scopes.' },
    ],
    output: [
      { name: 'removed', type: 'boolean', required: true, constraint: 'True if removed from at least one scope.' },
      { name: 'scopes', type: 'string[]', required: true, constraint: 'Scopes the plugin was removed from.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the plugin directory. Removes the plugin entry from config.json.'],
  },
  run: async (input) => {
    const name = reqStr(input, 'name');
    const scopeInput = str(input, 'scope');

    if (name === 'crtr') {
      throw usage('cannot remove builtin plugin "crtr" — it ships with the binary');
    }

    let scopes: Scope[];
    if (scopeInput !== undefined) {
      const resolved = resolveScopeArg(scopeInput);
      if (resolved === 'builtin') throw usage('cannot remove plugins from builtin scope');
      scopes = resolved === 'all' ? (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null) : [resolved];
    } else {
      scopes = (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null);
    }

    const removedFrom: string[] = [];

    for (const scope of scopes) {
      const pDir = pluginsDir(scope);
      if (pDir === null) continue;
      const pluginDir = join(pDir, name);
      if (!pathExists(pluginDir)) continue;

      removePath(pluginDir);
      updateConfig(scope, (cfg) => {
        delete cfg.plugins[name];
      });
      removedFrom.push(scope);
    }

    if (removedFrom.length === 0) {
      throw notFound(`plugin not found: ${name}`);
    }

    return { removed: true, scopes: removedFrom };
  },
});

// ---------------------------------------------------------------------------
// plugin.manage.enable / disable (shared helper)
// ---------------------------------------------------------------------------

async function setPluginEnabled(
  input: Record<string, unknown>,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  const name = reqStr(input, 'name');
  const scopeInput = str(input, 'scope');

  let scopes: Scope[];
  if (scopeInput !== undefined) {
    const resolved = resolveScopeArg(scopeInput);
    if (resolved === 'builtin') throw usage('cannot enable/disable plugins in builtin scope');
    scopes = resolved === 'all' ? (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null) : [resolved];
  } else {
    scopes = (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null);
  }

  let actedScope: string | undefined;

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
    actedScope = scope;
    break; // only act on first found scope
  }

  if (actedScope === undefined) {
    throw notFound(`plugin not found: ${name}`);
  }

  return { name, scope: actedScope, enabled };
}

const pluginEnable = defineLeaf({
  name: 'enable',
  help: {
    name: 'pkg plugin manage enable',
    summary: 'enable a plugin in the given scope',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name to enable.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: scope where the plugin is installed.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the change was applied in.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always true.' },
    ],
    outputKind: 'object',
    effects: ['Sets plugin enabled=true in config.json.'],
  },
  run: async (input) => setPluginEnabled(input, true),
});

const pluginDisable = defineLeaf({
  name: 'disable',
  help: {
    name: 'pkg plugin manage disable',
    summary: 'disable a plugin (keeps files, hides from resolution)',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name to disable.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: scope where the plugin is installed.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the change was applied in.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always false.' },
    ],
    outputKind: 'object',
    effects: ['Sets plugin enabled=false in config.json.'],
  },
  run: async (input) => setPluginEnabled(input, false),
});

// ---------------------------------------------------------------------------
// plugin.manage.update
// Single plugin: blocking (bounded). All plugins: job handle (unbounded network).
// ---------------------------------------------------------------------------

const pluginUpdate = defineLeaf({
  name: 'update',
  help: {
    name: 'pkg plugin manage update',
    summary: 'git pull updates for one or all installed plugins',
    input: [
      { name: 'name', type: 'string', required: false, constraint: 'Plugin name to update. Omit to update all (returns a job handle).' },
    ],
    output: [
      { name: 'updated', type: 'object[]', required: false, constraint: 'Present for single-plugin (blocking) path: [{name, updated, sha}].' },
      { name: 'job_id', type: 'string', required: false, constraint: 'Present for all-plugins (async) path.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Instruction for retrieving async result.' },
    ],
    outputKind: 'object',
    effects: ['Runs git pull in plugin directories. Updates version in config.json.'],
  },
  run: async (input) => {
    const name = str(input, 'name');

    if (name !== undefined) {
      // Single plugin — blocking (bounded network op, one repo)
      const found = findPluginByName(name);
      if (found === null) {
        throw notFound(`plugin not found: ${name}`);
      }

      const shaBefore = currentSha(found.root);
      const res = pull(found.root);
      if (res.status !== 0) {
        throw general(`git pull failed for "${name}": ${res.stderr.trim()}`);
      }

      const shaAfter = currentSha(found.root);
      const updated = shaBefore !== shaAfter;

      const manifest = readPluginManifest(found.root);
      if (manifest !== null) {
        updateConfig(found.scope, (cfg) => {
          const entry = cfg.plugins[found.name];
          if (entry !== undefined) {
            entry.version = manifest.version;
          } else {
            cfg.plugins[found.name] = { enabled: true, version: manifest.version };
          }
        });
        updateState(found.scope, (s) => {
          if (s.plugins[found.name] === undefined) {
            s.plugins[found.name] = {};
          }
          s.plugins[found.name].last_updated = nowIso();
        });
      }

      return {
        updated: [
          {
            name: found.name,
            updated,
            sha: shaAfter !== null ? shaAfter : '',
          },
        ],
      };
    }

    // All plugins — async job (unbounded network, N repos)
    const all = listAllPlugins();
    const targets = all
      .filter((p) => p.enabled && !p.sourceMarketplace && p.scope !== 'builtin')
      .map((p) => ({ name: p.name, scope: p.scope, root: p.root }));

    const { jobId } = createJob('pkg-update', { cwd: process.cwd(), pid: process.pid });

    // Fire-and-forget: run updates in background after returning job handle.
    // Using setImmediate so the job handle is returned before the work starts.
    setImmediate(() => {
      void (async () => {
        const results: Array<{ name: string; updated: boolean; sha: string }> = [];
        for (const target of targets) {
          appendEvent(jobId, { level: 'info', event: 'updating', message: `updating ${target.name}` });
          const shaBefore = currentSha(target.root);
          const res = pull(target.root);
          if (res.status !== 0) {
            appendEvent(jobId, { level: 'error', event: 'pull_failed', message: `git pull failed for "${target.name}": ${res.stderr.trim()}` });
            results.push({ name: target.name, updated: false, sha: shaBefore !== null ? shaBefore : '' });
            continue;
          }
          const shaAfter = currentSha(target.root);
          const updated = shaBefore !== shaAfter;
          const manifest = readPluginManifest(target.root);
          if (manifest !== null) {
            updateConfig(target.scope, (cfg) => {
              const entry = cfg.plugins[target.name];
              if (entry !== undefined) {
                entry.version = manifest.version;
              } else {
                cfg.plugins[target.name] = { enabled: true, version: manifest.version };
              }
            });
            updateState(target.scope, (s) => {
              if (s.plugins[target.name] === undefined) {
                s.plugins[target.name] = {};
              }
              s.plugins[target.name].last_updated = nowIso();
            });
          }
          results.push({ name: target.name, updated, sha: shaAfter !== null ? shaAfter : '' });
          appendEvent(jobId, { level: 'info', event: 'updated', message: `${target.name} updated=${updated}` });
        }
        writeResult(jobId, { updated: results }, 'done');
      })();
    });

    return {
      job_id: jobId,
      follow_up: `{"job_id":"${jobId}","wait":true} | crtr job read result`,
    };
  },
});

const pluginManageBranch = defineBranch({
  name: 'manage',
  help: {
    name: 'pkg plugin manage',
    summary: 'install, remove, enable, disable, or update plugins',
    children: [
      { name: 'install', desc: 'install from a git URL', useWhen: 'adding a new plugin' },
      { name: 'remove', desc: 'remove plugin and directory', useWhen: 'uninstalling a plugin' },
      { name: 'enable', desc: 'enable a plugin', useWhen: 'activating a disabled plugin' },
      { name: 'disable', desc: 'disable without removing', useWhen: 'temporarily hiding a plugin' },
      { name: 'update', desc: 'pull latest from git', useWhen: 'updating a plugin to its latest version' },
    ],
  },
  children: [pluginInstall, pluginRemove, pluginEnable, pluginDisable, pluginUpdate],
});

// ---------------------------------------------------------------------------
// plugin.inspect.list
// ---------------------------------------------------------------------------

const pluginList = defineLeaf({
  name: 'list',
  help: {
    name: 'pkg plugin inspect list',
    summary: 'paginated list of installed plugins',
    input: [
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project, all. Default: all.' },
      { name: 'include_disabled', type: 'boolean', required: false, constraint: 'Default false.' },
      { name: 'limit', type: 'integer', required: false, constraint: 'Default 50, max 200.' },
      { name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {name, scope, version?, enabled, source_marketplace?, path}. Sorted by scope then name ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Exact when cheap; null otherwise.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeInput = str(input, 'scope');
    const includeDisabled = bool(input, 'include_disabled', false);
    const limit = int(input, 'limit', { default: 50, min: 1, max: 200 });
    const cursor = str(input, 'cursor');

    let scopesToScan: Scope[];
    if (scopeInput !== undefined) {
      const resolved = resolveScopeArg(scopeInput);
      scopesToScan = resolved === 'all'
        ? (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null)
        : [resolved as Scope];
    } else {
      scopesToScan = (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null);
    }

    const all = scopesToScan
      .flatMap((s) => listInstalledPlugins(s))
      .filter((p) => includeDisabled || p.enabled)
      .sort((a, b) => {
        if (a.scope === 'project' && b.scope !== 'project') return -1;
        if (a.scope !== 'project' && b.scope === 'project') return 1;
        return a.name.localeCompare(b.name);
      });

    const result = paginate(
      all,
      { limit, cursor: cursor !== undefined ? cursor : undefined },
      {
        defaultLimit: 50,
        maxLimit: 200,
        keyOf: (p) => `${p.scope}:${p.name}`,
        total: 'count',
      },
    );

    return {
      items: result.items.map((p) => ({
        name: p.name,
        scope: p.scope,
        version: p.version,
        enabled: p.enabled,
        source_marketplace: p.sourceMarketplace,
        path: p.root,
      })),
      next_cursor: result.next_cursor,
      total: result.total,
    };
  },
});

// ---------------------------------------------------------------------------
// plugin.inspect.show
// ---------------------------------------------------------------------------

const pluginShow = defineLeaf({
  name: 'show',
  help: {
    name: 'pkg plugin inspect show',
    summary: 'read plugin manifest and metadata by name',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Narrows resolution.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the plugin is installed in.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the plugin directory.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Whether the plugin is active.' },
      { name: 'manifest', type: 'object', required: true, constraint: 'Full plugin.json contents.' },
      { name: 'skills', type: 'object[]', required: true, constraint: 'Each: {name, path, enabled}. Skills provided by the plugin.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const name = reqStr(input, 'name');
    const scopeInput = str(input, 'scope');

    let found;
    if (scopeInput !== undefined) {
      const resolved = resolveScopeArg(scopeInput);
      if (resolved === 'all' || resolved === 'builtin') {
        found = findPluginByName(name);
      } else {
        found = findPluginByName(name, resolved);
      }
    } else {
      found = findPluginByName(name);
    }

    if (found === null) {
      throw notFound(`plugin not found: ${name}`);
    }

    const skills = listSkillsInPlugin(found);

    return {
      name: found.name,
      scope: found.scope,
      path: found.root,
      enabled: found.enabled,
      manifest: found.manifest as unknown as Record<string, unknown>,
      skills: skills.map((s) => ({
        name: s.name,
        path: s.path,
        enabled: s.enabled,
      })),
    };
  },
});

const pluginInspectBranch = defineBranch({
  name: 'inspect',
  help: {
    name: 'pkg plugin inspect',
    summary: 'read plugin metadata without modifying state',
    children: [
      { name: 'list', desc: 'paginated list of installed plugins', useWhen: 'enumerating what plugins are installed' },
      { name: 'show', desc: 'read plugin manifest and skill inventory', useWhen: 'inspecting a specific plugin\'s details' },
    ],
  },
  children: [pluginList, pluginShow],
});

const pluginBranch = defineBranch({
  name: 'plugin',
  help: {
    name: 'pkg plugin',
    summary: 'install and manage plugins that extend crtr with skills',
    model: 'Plugins are git repos or local directories containing a .crouter-plugin/plugin.json manifest and a skills/ directory.',
    children: [
      { name: 'manage', desc: 'install, remove, enable, disable, update', useWhen: 'changing plugin state' },
      { name: 'inspect', desc: 'list or show installed plugins', useWhen: 'reading plugin metadata' },
    ],
  },
  children: [pluginManageBranch, pluginInspectBranch],
});

// ---------------------------------------------------------------------------
// market.manage.add
// ---------------------------------------------------------------------------

const marketAdd = defineLeaf({
  name: 'add',
  help: {
    name: 'pkg market manage add',
    summary: 'add a marketplace by git URL',
    input: [
      { name: 'url', type: 'string', required: true, constraint: 'Git URL of the marketplace repo.' },
      { name: 'ref', type: 'string', required: false, constraint: 'Git ref to track. Default: main.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
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
    const url = reqStr(input, 'url');
    const ref = str(input, 'ref');
    const scopeInput = str(input, 'scope');

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
  help: {
    name: 'pkg market manage remove',
    summary: 'remove a marketplace and its directory',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Marketplace name to remove.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Removed marketplace name.' },
      { name: 'removed', type: 'boolean', required: true, constraint: 'Always true on success.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the marketplace directory. Removes the entry from config.json.'],
  },
  run: async (input) => {
    const name = reqStr(input, 'name');
    const scopeInput = str(input, 'scope');

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
  help: {
    name: 'pkg market manage update',
    summary: 'git pull updates for one or all registered marketplaces',
    input: [
      { name: 'name', type: 'string', required: false, constraint: 'Marketplace name to update. Omit to update all (returns a job handle).' },
    ],
    output: [
      { name: 'updated', type: 'object[]', required: false, constraint: 'Present for single (blocking) path: [{name, updated, sha}].' },
      { name: 'job_id', type: 'string', required: false, constraint: 'Present for all (async) path.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Instruction for retrieving async result.' },
    ],
    outputKind: 'object',
    effects: ['Runs git pull in marketplace directories.'],
  },
  run: async (input) => {
    const name = str(input, 'name');

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

    // All marketplaces — async job
    const all = listAllMarketplaces();
    const targets = all.map((m) => ({ name: m.name, scope: m.scope, root: m.root }));

    const { jobId } = createJob('pkg-market-update', { cwd: process.cwd(), pid: process.pid });

    setImmediate(() => {
      void (async () => {
        appendEvent(jobId, { level: 'info', event: 'start', message: `updating ${targets.length} marketplace(s)` });
        try {
          const results = await doUpdate(targets);
          writeResult(jobId, { updated: results }, 'done');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          appendEvent(jobId, { level: 'error', event: 'failed', message: msg });
          writeResult(jobId, { error: msg }, 'failed');
        }
      })();
    });

    return {
      job_id: jobId,
      follow_up: `{"job_id":"${jobId}","wait":true} | crtr job read result`,
    };
  },
});

// ---------------------------------------------------------------------------
// market.manage.install
// ---------------------------------------------------------------------------

const marketInstall = defineLeaf({
  name: 'install',
  help: {
    name: 'pkg market manage install',
    summary: 'install a plugin from an added marketplace by plugin name',
    input: [
      { name: 'marketplace', type: 'string', required: true, constraint: 'Marketplace name (must already be added via `pkg market manage add`).' },
      { name: 'plugin', type: 'string', required: true, constraint: 'Plugin name as listed in the marketplace manifest.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
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
    const mktName = reqStr(input, 'marketplace');
    const pluginName = reqStr(input, 'plugin');
    const scopeInput = str(input, 'scope');

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

const marketManageBranch = defineBranch({
  name: 'manage',
  help: {
    name: 'pkg market manage',
    summary: 'add, remove, update, or install from marketplaces',
    children: [
      { name: 'add', desc: 'add a marketplace by git URL', useWhen: 'registering a new marketplace source' },
      { name: 'remove', desc: 'remove a marketplace', useWhen: 'unregistering a marketplace' },
      { name: 'update', desc: 'pull latest marketplace index', useWhen: 'refreshing the marketplace plugin list' },
      { name: 'install', desc: 'install a plugin from a marketplace', useWhen: 'adding a plugin sourced from a registered marketplace' },
    ],
  },
  children: [marketAdd, marketRemove, marketUpdate, marketInstall],
});

// ---------------------------------------------------------------------------
// market.inspect.list
// ---------------------------------------------------------------------------

const marketList = defineLeaf({
  name: 'list',
  help: {
    name: 'pkg market inspect list',
    summary: 'list registered marketplaces',
    input: [
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project, all. Default: all.' },
      { name: 'limit', type: 'integer', required: false, constraint: 'Default 50, max 200.' },
      { name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {name, scope, url, ref, path, last_updated?}. Sorted by scope then name ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Total count.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeInput = str(input, 'scope');
    const limit = int(input, 'limit', { default: 50, min: 1, max: 200 });
    const cursor = str(input, 'cursor');

    let all: ReturnType<typeof listAllMarketplaces>;
    if (scopeInput !== undefined) {
      const resolved = resolveScopeArg(scopeInput);
      if (resolved === 'all') {
        all = listAllMarketplaces();
      } else if (resolved === 'builtin') {
        all = [];
      } else {
        all = listInstalledMarketplaces(resolved as Scope);
      }
    } else {
      all = listAllMarketplaces();
    }

    const sorted = [...all].sort((a, b) => {
      if (a.scope === 'project' && b.scope !== 'project') return -1;
      if (a.scope !== 'project' && b.scope === 'project') return 1;
      return a.name.localeCompare(b.name);
    });

    const result = paginate(
      sorted,
      { limit, cursor: cursor !== undefined ? cursor : undefined },
      {
        defaultLimit: 50,
        maxLimit: 200,
        keyOf: (m) => `${m.scope}:${m.name}`,
        total: 'count',
      },
    );

    return {
      items: result.items.map((m) => ({
        name: m.name,
        scope: m.scope,
        url: m.url,
        ref: m.ref,
        path: m.root,
      })),
      next_cursor: result.next_cursor,
      total: result.total,
    };
  },
});

// ---------------------------------------------------------------------------
// market.inspect.browse
// ---------------------------------------------------------------------------

const marketBrowse = defineLeaf({
  name: 'browse',
  help: {
    name: 'pkg market inspect browse',
    summary: 'list plugins available in a marketplace',
    input: [
      { name: 'marketplace', type: 'string', required: true, constraint: 'Marketplace name.' },
      { name: 'limit', type: 'integer', required: false, constraint: 'Default 50, max 200.' },
      { name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
    ],
    output: [
      { name: 'marketplace', type: 'string', required: true, constraint: 'Echo of the input marketplace name.' },
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {name, source, version?, description?, keywords?, installed, installed_scope?}. Sorted by name ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Total plugins in the marketplace; null if unavailable.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const mktName = reqStr(input, 'marketplace');
    const limit = int(input, 'limit', { default: 50, min: 1, max: 200 });
    const cursor = str(input, 'cursor');

    const mkt = findMarketplaceByName(mktName);
    if (!mkt) throw notFound(`marketplace not found: ${mktName}`);

    const allScopes: Scope[] = (['project', 'user'] as Scope[]).filter(
      (s) => s !== 'project' || projectScopeRoot() !== null,
    );
    const installedMap = new Map<string, Scope>();
    for (const scope of allScopes) {
      for (const p of listInstalledPlugins(scope)) {
        if (!installedMap.has(p.name)) {
          installedMap.set(p.name, p.scope);
        }
      }
    }

    const pluginsSorted = [...mkt.manifest.plugins].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const result = paginate(
      pluginsSorted,
      { limit, cursor: cursor !== undefined ? cursor : undefined },
      {
        defaultLimit: 50,
        maxLimit: 200,
        keyOf: (p) => p.name,
        total: 'count',
      },
    );

    return {
      marketplace: mkt.name,
      items: result.items.map((entry) => {
        const installedScope = installedMap.get(entry.name);
        const installed = installedScope !== undefined;
        const item: Record<string, unknown> = {
          name: entry.name,
          source: entry.source,
          version: entry.version,
          description: entry.description,
          keywords: entry.keywords,
          installed,
        };
        if (installed) {
          item.installed_scope = installedScope;
        }
        return item;
      }),
      next_cursor: result.next_cursor,
      total: result.total,
    };
  },
});

const marketInspectBranch = defineBranch({
  name: 'inspect',
  help: {
    name: 'pkg market inspect',
    summary: 'read marketplace metadata without modifying state',
    children: [
      { name: 'list', desc: 'list registered marketplaces', useWhen: 'seeing which marketplaces are configured' },
      { name: 'browse', desc: 'list plugins available in a marketplace', useWhen: 'exploring what a marketplace offers before installing' },
    ],
  },
  children: [marketList, marketBrowse],
});

const marketBranch = defineBranch({
  name: 'market',
  help: {
    name: 'pkg market',
    summary: 'manage and browse plugin marketplaces',
    model: 'Marketplaces are git repos containing a .crouter-marketplace/marketplace.json index of plugins.',
    children: [
      { name: 'manage', desc: 'add, remove, update, install', useWhen: 'changing marketplace or marketplace-sourced plugin state' },
      { name: 'inspect', desc: 'list or browse marketplaces', useWhen: 'reading marketplace metadata' },
    ],
  },
  children: [marketManageBranch, marketInspectBranch],
});

export function registerPkg(): BranchDef {
  return defineBranch({
    name: 'pkg',
    help: {
      name: 'pkg',
      summary: 'manage plugins and plugin marketplaces',
      children: [
        { name: 'plugin', desc: 'install and manage plugins', useWhen: 'working with individual plugins directly' },
        { name: 'market', desc: 'manage marketplace sources and install from them', useWhen: 'using curated plugin collections' },
      ],
    },
    children: [pluginBranch, marketBranch],
  });
}
