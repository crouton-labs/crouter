// `crtr memory` subtree — the document substrate (knowledge and
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
import { lintLeaf } from './memory/lint.js';

export function registerMemory(): BranchDef {
  return defineBranch({
    name: 'memory',
    rootEntry: {
      concept: 'a memory document you read on demand — knowledge or a preference',
      desc: 'list, read, search, and write memory documents',
      useWhen:
        'a task matches stored knowledge or a preference — read it before improvising. `crtr memory read <name>` loads one by name; `crtr memory list` browses the inventory; `crtr memory find` searches by topic when you do not yet know the name. Names are path-derived crtr identifiers, not file paths — to READ a doc go through these commands, never cat or find the markdown off disk. To EDIT one in place, every command emits the doc’s absolute `path` — edit that file directly.',
    },
    help: {
      name: 'memory',
      summary: 'list, read, search, and write memory documents — knowledge and preferences',
      model:
        '`list` for a human inventory of what is stored — one line per document, the only surface that shows short-form. `read` (leaf) loads one document body by name, resolved project > user > builtin with leaf-name fallback; --frontmatter keeps the YAML header. `find` when you do not yet know which document applies — it ranks by relevance over name/when/why/short-form, --body to also weigh bodies, --grep for an exact regex over bodies. `write` creates or updates memory/<name>.md at a scope from frontmatter flags + a body piped on stdin — use it for new docs and frontmatter changes; for a quick body tweak, edit the `path` every leaf emits directly. `lint` strict-parses the whole bounded corpus and fails on any invalid frontmatter — run it after authoring. A directory may carry an `INDEX.md` with the same frontmatter schema as any doc; the dir then renders as one entry at the INDEX\'s rung, and that rung is a ceiling for its whole subtree (`none` hides the dir) — when a doc mysteriously is not surfacing, check its ancestors\' INDEX rungs and its gate. Append `-h` at any leaf for its full schema, and `crtr memory write -h` for the authoring guide.',
    },
    children: [listLeaf, readLeaf, findLeaf, writeLeaf, lintLeaf],
  });
}
