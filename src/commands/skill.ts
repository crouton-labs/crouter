// `crtr skill` subtree handlers.
// Sub-branch: author {guide, scaffold}.
// Discovery and reading are now `crtr memory` verbs.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { authorBranch } from './skill/author.js';

export function registerSkill(): BranchDef {
  return defineBranch({
    name: 'skill',
    rootEntry: {
      concept: 'a SKILL.md you author and manage',
      desc: 'author and manage skills',
      useWhen: 'authoring a new skill (`crtr skill author`). To discover and read skills use `crtr memory` — `crtr memory read <name>`, `crtr memory find`, `crtr memory list`.',
    },
    help: {
      name: 'skill',
      summary: 'author skills — use `crtr memory` to discover and read them',
      model:
        '`author` when you are writing a new skill — it carries the template workflow and the scaffolder. Discovery and reading are `crtr memory` verbs: `crtr memory list`, `crtr memory find`, `crtr memory read`. Visibility is governed by the substrate (INDEX/rung/gate), not a per-skill on/off. Append `-h` at any branch or leaf for its full schema.',
    },
    children: [authorBranch],
  });
}
