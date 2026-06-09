import { defineLeaf } from '../../core/command.js';
import { CrtrError, notFound } from '../../core/errors.js';
import { resolveMemoryDoc } from '../../core/memory-resolver.js';
import type { MemoryDoc } from '../../core/memory-resolver.js';
import { parseSubstrateDoc } from '../../core/substrate/index.js';
import { resolveSkill } from '../../core/resolver.js';
import type { Skill } from '../../types.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { readText } from '../../core/fs-utils.js';
import { MEMORY_KINDS } from './shared.js';

export const readLeaf = defineLeaf({
  name: 'read',
  description: 'load a memory document body by name',
  whenToUse:
    'a task in front of you matches a stored document and you already know its name — read it before improvising. Resolves the path-derived name across scopes by precedence (project > user > builtin), with leaf-name fallback like skills. You name the document by its crtr identifier, never a file path — do not cat or find the markdown off disk. Reach for `crtr memory find` first when you do not yet know which document applies.',
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
      { name: 'kind', type: 'string', required: true, constraint: 'Resolved kind: skill, reference, or preference.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the document was resolved from: project, user, or builtin.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the document on disk.' },
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

    // 1) Primary: resolve a substrate/memory document (memory/ dirs across
    //    project>user>builtin). A not_found here is not fatal — it falls through
    //    to the skill resolver below (the D4 union).
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
            : 'reference';
      // --kind asserts the resolved kind; a mismatch falls through to skills
      // (which only satisfy --kind=skill).
      if (kindFilter === undefined || kind === kindFilter) {
        const content = includeFrontmatter ? readText(doc.path) : doc.body;
        return {
          name: doc.name,
          kind,
          scope: doc.scope,
          path: doc.path,
          content,
          follow_up: 'Add --frontmatter to include the YAML header. Browse the inventory with `crtr memory list`.',
        };
      }
    }

    // 2) D4 union fallthrough: the name is not a memory document (or its kind
    //    did not match --kind) — resolve it as a plugin/marketplace/scope skill
    //    so skills are readable through `crtr memory read` too. Skills are kind
    //    "skill", so honor --kind by skipping this path for other kinds.
    if (kindFilter === undefined || kindFilter === 'skill') {
      let skill: Skill | undefined;
      try {
        skill = resolveSkill(nameRaw);
      } catch (e) {
        // not_found → fall through to the memory-not-found below. A genuine
        // CrtrError (e.g. ambiguous) propagates. Any other throw means the skill
        // corpus is currently unparseable (the yaml-parser regression owned by
        // the frontmatter/skill track) — degrade to not-found rather than 500.
        if (e instanceof CrtrError && e.code !== 'not_found') throw e;
      }
      if (skill !== undefined) {
        const raw = readText(skill.path);
        const content = includeFrontmatter ? raw : parseFrontmatter(raw).body;
        return {
          name: skill.name,
          kind: 'skill',
          scope: skill.scope,
          path: skill.path,
          content,
          follow_up: 'Add --frontmatter to include the YAML header. Browse the inventory with `crtr memory list`.',
        };
      }
    }

    throw notFound(`memory document not found: ${nameRaw}`, {
      memory: nameRaw,
      next: 'Run `crtr memory find <query>` to discover documents, or `crtr memory list` to browse the inventory.',
    });
  },
});
