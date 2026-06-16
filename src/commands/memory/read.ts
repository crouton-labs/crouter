import { defineLeaf } from '../../core/command.js';
import { CrtrError, notFound } from '../../core/errors.js';
import { resolveMemoryDoc } from '../../core/memory-resolver.js';
import type { MemoryDoc } from '../../core/memory-resolver.js';
import { parseSubstrateDoc } from '../../core/substrate/index.js';
import { readText } from '../../core/fs-utils.js';
import { MEMORY_KINDS } from './shared.js';

export const readLeaf = defineLeaf({
  name: 'read',
  description: 'load a memory document body by name',
  whenToUse:
    'a task in front of you matches a stored document and you already know its name — read it before improvising. Resolves the path-derived name across scopes by precedence (project > user > builtin), with leaf-name fallback. You name the document by its crtr identifier, never a file path — do not cat or find the markdown off disk. Reach for `crtr memory find` first when you do not yet know which document applies.',
  help: {
    name: 'memory read',
    summary: 'resolve a path-derived name to its document body, frontmatter stripped unless --frontmatter',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Path-derived memory identifier (e.g. `topic` or `area/topic`). Resolved across scopes by precedence: project > user > builtin, with leaf-name fallback.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: [...MEMORY_KINDS], required: false, constraint: 'Narrows resolution when the name is ambiguous across kinds.' },
      { kind: 'flag', name: 'frontmatter', type: 'bool', required: false, constraint: 'When present, includes the YAML frontmatter in the returned body. Off by default — only the body is returned.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved document name.' },
      { name: 'kind', type: 'string', required: true, constraint: 'Resolved kind: knowledge or preference.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the document was resolved from: project, user, or builtin.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the document on disk — edit this file directly to tweak the doc in place.' },
      { name: 'content', type: 'string', required: true, constraint: 'Document body. Frontmatter stripped unless --frontmatter is set.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Hints at variant flags or next commands.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = input['name'] as string;
    const kindFilter = input['kind'] as string | undefined;
    const includeFrontmatter = input['frontmatter'] as boolean;

    // Resolve a substrate/memory document across scopes (project>user>builtin,
    // with leaf-name fallback). The substrate corpus now includes plugin docs
    // (mounted under <pluginName>/), so this resolves every name.
    let doc: MemoryDoc | undefined;
    try {
      doc = resolveMemoryDoc(nameRaw);
    } catch (e) {
      if (!(e instanceof CrtrError && e.code === 'not_found')) throw e;
    }

    if (doc !== undefined) {
      const sub = parseSubstrateDoc(doc);
      const kind =
        sub !== null
          ? sub.kind
          : typeof doc.frontmatter?.['kind'] === 'string'
            ? (doc.frontmatter['kind'] as string)
            : 'knowledge';
      // --kind asserts the resolved kind; a mismatch falls through to not-found.
      if (kindFilter === undefined || kind === kindFilter) {
        const content = includeFrontmatter ? readText(doc.path) : doc.body;
        return {
          name: doc.name,
          kind,
          scope: doc.scope,
          path: doc.path,
          content,
          follow_up: 'Read the raw file at `path` to view the YAML frontmatter or edit this memory. Browse the inventory with `crtr memory list`.',
        };
      }
    }

    throw notFound(`memory document not found: ${nameRaw}`, {
      memory: nameRaw,
      next: 'Run `crtr memory find <query>` to discover documents, or `crtr memory list` to browse the inventory.',
    });
  },
});
