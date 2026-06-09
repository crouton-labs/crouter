import { defineLeaf } from '../../core/command.js';
import type { Scope } from '../../types.js';
import { listAllMemoryDocs } from '../../core/memory-resolver.js';
import { parseSubstrateDoc } from '../../core/substrate/index.js';
import type { SubstrateDoc } from '../../core/substrate/index.js';
import { listAllSkills } from '../../core/resolver.js';
import { MEMORY_KINDS, MEMORY_SCOPES, scopeRank } from './shared.js';

export const listLeaf = defineLeaf({
  name: 'list',
  description: 'inventory of stored memory documents',
  whenToUse:
    'browse everything stored — one line per document with its title, short-form hook, kind, and scope. This is the one surface that shows short-form. Reach for `crtr memory find` instead when you already have a topic or keyword in mind rather than wanting the whole inventory.',
  help: {
    name: 'memory list',
    summary: 'inventory every memory document across the resolved scopes, one line each',
    params: [
      { kind: 'flag', name: 'kind', type: 'enum', choices: [...MEMORY_KINDS], required: false, constraint: 'Filter to a single kind. Default: all kinds.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: [...MEMORY_SCOPES], required: false, constraint: 'Filter to a single scope. Default: all resolved scopes.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'One row per document. Each: {name, title, short_form, kind, scope}. short_form is the abbreviated hook — shown here and nowhere else. Sorted by scope then kind then name ascending.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands — read a document in full or narrow the inventory.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const kindFilter = input['kind'] as string | undefined;
    const scopeFilter = input['scope'] as Scope | undefined;

    // Build the same corpus as `find`: substrate memory docs UNIONED with the
    // skill-plugin corpus, deduped by (scope, name) — substrate docs win over
    // skill-plugin docs for the same identity (mirrors resolver precedence).
    // This makes list consistent with find/read (M4 fix).

    interface ListItem {
      name: string;
      kind: string;
      scope: Scope;
      shortForm: string;
    }

    const seen = new Set<string>(); // "scope/name" → first wins
    const items: ListItem[] = [];

    const addItem = (item: ListItem): void => {
      const id = `${item.scope}/${item.name}`;
      if (seen.has(id)) return;
      seen.add(id);
      items.push(item);
    };

    // Substrate memory docs (project > user > builtin precedence).
    for (const doc of listAllMemoryDocs(scopeFilter)) {
      const sub = parseSubstrateDoc(doc);
      if (sub === null) continue;
      if (kindFilter !== undefined && sub.kind !== kindFilter) continue;
      addItem({ name: sub.name, kind: sub.kind, scope: sub.scope, shortForm: sub.shortForm });
    }

    // Skill-plugin corpus (scope-root skills + plugin/marketplace skills).
    // Only include when the kindFilter is absent or explicitly 'skill'.
    if (kindFilter === undefined || kindFilter === 'skill') {
      try {
        for (const skill of listAllSkills(scopeFilter)) {
          const raw = skill.frontmatter.description;
          const desc = typeof raw === 'string' ? raw : '';
          addItem({ name: skill.name, kind: 'skill', scope: skill.scope, shortForm: desc });
        }
      } catch {
        /* skill corpus unavailable — list substrate documents alone */
      }
    }

    items.sort((a, b) => {
      const sr = scopeRank(a.scope) - scopeRank(b.scope);
      if (sr !== 0) return sr;
      const kc = a.kind.localeCompare(b.kind);
      if (kc !== 0) return kc;
      return a.name.localeCompare(b.name);
    });

    return {
      items: items.map((d) => ({
        name: d.name,
        title: d.name,
        short_form: d.shortForm,
        kind: d.kind,
        scope: d.scope,
      })),
      follow_up:
        'Read one in full with `crtr memory read <name>`. Narrow with --kind / --scope, or search a topic with `crtr memory find <query>`.',
    };
  },
});
