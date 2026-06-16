import { defineBranch, defineLeaf } from '../../core/command.js';
import { notFound } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import {
  listInstalledPlugins,
  findPluginByName,
} from '../../core/resolver.js';
import { listAllMemoryDocs } from '../../core/memory-resolver.js';
import { resolveScopeArg, projectScopeRoot } from '../../core/scope.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// plugin.inspect.list
// ---------------------------------------------------------------------------

const pluginList = defineLeaf({
  name: 'list',
  description: 'paginated list of installed plugins',
  whenToUse: 'enumerating which plugins are installed across user and project scope, optionally including disabled ones',
  help: {
    name: 'pkg plugin inspect list',
    summary: 'paginated list of installed plugins',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'include-disabled', type: 'bool', required: false, constraint: 'Include disabled plugins. Default: false.' },
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: 'Default 50, max 200.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
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
    const scopeInput = input['scope'] as string | undefined;
    const includeDisabled = (input['includeDisabled'] as boolean | undefined) ?? false;
    const limitRaw = input['limit'] as number | undefined;
    const limit = limitRaw !== undefined ? Math.min(Math.max(1, limitRaw), 200) : 50;
    const cursor = input['cursor'] as string | undefined;

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
  description: 'read plugin manifest and substrate inventory',
  whenToUse: 'reading one installed plugin in detail to decide before you enable, disable, or remove it — returns the full manifest, the substrate docs it provides (its `<pluginName>/` memory subtree), its scope, and whether it is currently enabled. Use `pkg plugin inspect list` instead to enumerate plugins rather than drill into one',
  help: {
    name: 'pkg plugin inspect show',
    summary: 'read plugin manifest and metadata by name',
    params: [
      { kind: 'positional', name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'One of: user, project. Narrows resolution.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Plugin name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the plugin is installed in.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the plugin directory.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Whether the plugin is active.' },
      { name: 'manifest', type: 'object', required: true, constraint: 'Full plugin.json contents.' },
      { name: 'docs', type: 'object[]', required: true, constraint: 'Each: {name, path}. Memory docs provided by the plugin (its `<pluginName>/` memory subtree).' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const scopeInput = input['scope'] as string | undefined;

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

    const prefix = `${found.name}/`;
    const docs = listAllMemoryDocs().filter((d) => d.name.startsWith(prefix));

    return {
      name: found.name,
      scope: found.scope,
      path: found.root,
      enabled: found.enabled,
      manifest: found.manifest as unknown as Record<string, unknown>,
      docs: docs.map((d) => ({
        name: d.name,
        path: d.path,
      })),
    };
  },
});

export const pluginInspectBranch = defineBranch({
  name: 'inspect',
  description: 'list or show installed plugins',
  whenToUse: 'reading installed plugin metadata to decide before you change anything — list what is installed, or show the manifest and memory docs of one plugin. Read-only; switch to `pkg plugin manage` to actually install, enable, disable, or remove',
  help: {
    name: 'pkg plugin inspect',
    summary: 'read plugin metadata without modifying state',
  },
  children: [pluginList, pluginShow],
});
