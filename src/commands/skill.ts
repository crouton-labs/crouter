// `crtr skill` subtree handlers — P3 implementation.
// Sub-branches: find {list, search, grep}, author {guide, scaffold}, state {enable, disable}.
// Leaf children of skill: read.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { buildSkillCatalog } from './skill/shared.js';
import { findBranch } from './skill/find.js';
import { readLeaf } from './skill/read.js';
import { authorBranch } from './skill/author.js';
import { stateBranch } from './skill/state.js';

export function registerSkill(): BranchDef {
  return defineBranch({
    name: 'skill',
    rootEntry: {
      concept: 'a SKILL.md you read to adopt its workflow',
      desc: 'find, read, author, and manage skills',
      useWhen: 'a task matches a loaded skill — read it before improvising. `crtr skill read <name>` loads one by name from the catalog below; `crtr skill find` only when the name is not already listed. Names are crtr identifiers, not file paths — never cat or find SKILL.md off disk.',
      dynamicState: buildSkillCatalog,
    },
    help: {
      name: 'skill',
      summary: 'discover, read, author, and manage skill state',
      model:
        '`find` when you do not yet know which skill applies — it locates candidates by topic, keyword, or body text. `read` (leaf) loads SKILL.md by name; takes the name as a positional, returns body + metadata, accepts --no-body to skip the body. `author` when you are writing a new skill — it carries the template workflow and the scaffolder. `state` when a skill should be hidden from discovery without being removed. Append `-h` at any branch or leaf for its full schema.',
      dynamicState: buildSkillCatalog,
      children: [
        { name: 'find', desc: 'list, search, or grep skills', useWhen: 'discovering what skills are available' },
        { name: 'read', desc: 'load SKILL.md body + metadata for a named skill', useWhen: 'loading a skill to act on it' },
        { name: 'author', desc: 'create and scaffold skills', useWhen: 'writing a new skill' },
        { name: 'state', desc: 'enable or disable skills', useWhen: 'toggling skill visibility' },
      ],
    },
    children: [findBranch, readLeaf, authorBranch, stateBranch],
  });
}
