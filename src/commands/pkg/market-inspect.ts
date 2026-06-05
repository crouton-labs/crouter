import { defineBranch, defineLeaf } from '../../core/command.js';
import { notFound, usage } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import {
  listInstalledPlugins,
  listInstalledMarketplaces,
  listAllMarketplaces,
  findMarketplaceByName,
} from '../../core/resolver.js';
import { resolveScopeArg, projectScopeRoot } from '../../core/scope.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// market.inspect.list
// ---------------------------------------------------------------------------

const marketList = defineLeaf({
  name: 'list',
  description: 'list registered marketplaces',
  whenToUse: 'listing which marketplaces are registered, with their git URL, ref, and scope',
  help: {
    name: 'pkg market inspect list',
    summary: 'list registered marketplaces',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'One of: user, project, all. Default: all.' },
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: 'Default 50, max 200.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
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
    const scopeInput = input['scope'] as string | undefined;
    const limitRaw = input['limit'] as number | undefined;
    const limit = limitRaw !== undefined ? Math.min(Math.max(1, limitRaw), 200) : 50;
    const cursor = input['cursor'] as string | undefined;

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
  description: 'list plugins available in a marketplace',
  whenToUse: 'exploring what a marketplace offers so you can decide before installing — lists every plugin in a marketplace index with its description, keywords, version, and whether it is already installed. Reach for this to pick which plugin to pull, then install it by name with `pkg market manage install`',
  help: {
    name: 'pkg market inspect browse',
    summary: 'list plugins available in a marketplace',
    params: [
      { kind: 'flag', name: 'marketplace', type: 'string', required: false, constraint: 'Marketplace name. Omit to browse all registered marketplaces.' },
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: 'Default 50, max 200.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
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
    const mktName = input['marketplace'] as string | undefined;
    const limitRaw = input['limit'] as number | undefined;
    const limit = limitRaw !== undefined ? Math.min(Math.max(1, limitRaw), 200) : 50;
    const cursor = input['cursor'] as string | undefined;

    if (mktName === undefined) {
      throw usage('--marketplace is required for browse. Use `pkg market inspect list` to see registered marketplaces.');
    }

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

export const marketInspectBranch = defineBranch({
  name: 'inspect',
  description: 'list or browse marketplaces',
  whenToUse: 'reading marketplace metadata to decide before you install — list registered marketplaces, or browse the plugins available in one marketplace. Read-only; switch to `pkg market manage` to add a marketplace or install a plugin from it',
  help: {
    name: 'pkg market inspect',
    summary: 'read marketplace metadata without modifying state',
  },
  children: [marketList, marketBrowse],
});
