import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../../core/command.js';
import { notFound, usage, general } from '../../core/errors.js';
import { createJob, appendEvent, writeResult } from '../../core/jobs.js';
import { findPluginByName, listAllPlugins } from '../../core/resolver.js';
import {
  pluginsDir,
  ensureProjectScopeRoot,
  userScopeRoot,
  resolveScopeArg,
  projectScopeRoot,
} from '../../core/scope.js';
import { updateConfig, updateState, ensureScopeInitialized } from '../../core/config.js';
import { pathExists, ensureDir, removePath, nowIso } from '../../core/fs-utils.js';
import { clone, pull, deriveNameFromUrl, currentSha } from '../../core/git.js';
import { readPluginManifest } from '../../core/manifest.js';
import type { Scope } from '../../types.js';
import { isGitUrl, setPluginEnabled, resolveInstallScope } from './shared.js';

// ---------------------------------------------------------------------------
// plugin.manage.install
// ---------------------------------------------------------------------------

const pluginInstall = defineLeaf({
  name: 'install',
  help: {
    name: 'pkg plugin manage install',
    summary: 'install a plugin from a git URL into the given scope',
    params: [
      { kind: 'positional', name: 'source', type: 'string', required: true, constraint: 'Git URL or relative path to the plugin directory.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
      { kind: 'flag', name: 'ref', type: 'string', required: false, constraint: 'Git ref (branch/tag) to clone. Default: default branch.' },
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
    const source = input['source'] as string;
    const scopeInput = input['scope'] as string | undefined;
    const ref = input['ref'] as string | undefined;

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
          `Uninstall the existing plugin first with \`pkg plugin manage remove ${tempName}\``,
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
    params: [
      { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name to remove.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: searches all scopes.' },
    ],
    output: [
      { name: 'removed', type: 'boolean', required: true, constraint: 'True if removed from at least one scope.' },
      { name: 'scopes', type: 'string[]', required: true, constraint: 'Scopes the plugin was removed from.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the plugin directory. Removes the plugin entry from config.json.'],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const scopeInput = input['scope'] as string | undefined;

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
// plugin.manage.enable / disable
// ---------------------------------------------------------------------------

const pluginEnable = defineLeaf({
  name: 'enable',
  help: {
    name: 'pkg plugin manage enable',
    summary: 'enable a plugin in the given scope',
    params: [
      { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name to enable.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: scope where the plugin is installed.' },
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
    params: [
      { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name to disable.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Default: scope where the plugin is installed.' },
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
    params: [
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Plugin name to update. Omit to update all (returns a job handle).' },
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
    const name = input['name'] as string | undefined;

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
      follow_up: `crtr job read result ${jobId} --wait`,
    };
  },
});

export const pluginManageBranch = defineBranch({
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
