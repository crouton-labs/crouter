// `crtr memory` subtree — the document substrate (skills, references,
// preferences) accessed via the CLI. Four flat leaves: list, read, find, write.
// SKELETON ONLY (task B1): the `-h` contracts here are final; the leaf handlers
// are stubs that B2 fills in. Mirrors `skill.ts` minus the loaded-skills
// catalog dynamicState.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { listLeaf } from './memory/list.js';
import { readLeaf } from './memory/read.js';
import { findLeaf } from './memory/find.js';
import { writeLeaf } from './memory/write.js';
import { migrateLeaf } from './memory/migrate.js';
import { lintLeaf } from './memory/lint.js';

export function registerMemory(): BranchDef {
  return defineBranch({
    name: 'memory',
    rootEntry: {
      concept: 'a memory document you read on demand — a skill, reference, or preference',
      desc: 'list, read, search, and write memory documents',
      useWhen:
        'a task matches a stored skill, reference, or preference — read it before improvising. `crtr memory read <name>` loads one by name; `crtr memory list` browses the inventory; `crtr memory find` searches by topic when you do not yet know the name. Names are path-derived crtr identifiers, not file paths — never cat or find the markdown off disk.',
    },
    help: {
      name: 'memory',
      summary: 'list, read, search, and write memory documents — skills, references, preferences',
      model:
        '`list` for a human inventory of what is stored — one line per document, the only surface that shows short-form. `read` (leaf) loads one document body by name, resolved project > user > builtin with leaf-name fallback; --frontmatter keeps the YAML header. `find` when you do not yet know which document applies — it ranks by relevance over name/when/why/short-form, --body to also weigh bodies, --grep for an exact regex over bodies. `write` creates or updates memory/<name>.md at a scope from frontmatter flags + a body piped on stdin. `lint` strict-parses the whole bounded corpus and fails on any invalid frontmatter — run it after authoring. Append `-h` at any leaf for its full schema.',
    },
    children: [listLeaf, readLeaf, findLeaf, writeLeaf, migrateLeaf, lintLeaf],
  });
}
