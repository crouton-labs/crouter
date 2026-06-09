// `crtr skill` subtree handlers.
// Sub-branches: author {guide, scaffold}, state {enable, disable}.
// Discovery and reading are now `crtr memory` verbs.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { authorBranch } from './skill/author.js';
import { stateBranch } from './skill/state.js';

export function registerSkill(): BranchDef {
  return defineBranch({
    name: 'skill',
    rootEntry: {
      concept: 'a SKILL.md you author and manage',
      desc: 'author and manage skills',
      useWhen: 'authoring a new skill (`crtr skill author`) or toggling a skill on/off (`crtr skill state`). To discover and read skills use `crtr memory` — `crtr memory read <name>`, `crtr memory find`, `crtr memory list`.',
    },
    help: {
      name: 'skill',
      summary: 'author and manage skill state — use `crtr memory` to discover and read skills',
      model:
        '`author` when you are writing a new skill — it carries the template workflow and the scaffolder. `state` when a skill should be hidden from discovery without being removed. Discovery and reading are `crtr memory` verbs: `crtr memory list`, `crtr memory find`, `crtr memory read`. Append `-h` at any branch or leaf for its full schema.',
    },
    children: [authorBranch, stateBranch],
  });
}
