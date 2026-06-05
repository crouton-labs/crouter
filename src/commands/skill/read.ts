import { defineLeaf } from '../../core/command.js';
import { CrtrError } from '../../core/errors.js';
import type { Scope } from '../../types.js';
import {
  resolveSkill,
  resolveCategory,
  buildCategoryIndex,
} from '../../core/resolver.js';
import { resolveScopeArg } from '../../core/scope.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { readText } from '../../core/fs-utils.js';
import { appendNeighbors } from './shared.js';

export const readLeaf = defineLeaf({
  name: 'read',
  description: 'load SKILL.md body + metadata for a named skill',
  whenToUse: 'a task in front of you matches a skill that is already loaded — read it BEFORE you start improvising, not after. Reach for it the moment you are about to do something a skill covers: adopting a documented workflow that fits the task at hand, following a methodology before writing a spec or a plan, picking up the house conventions for a tool or framework, replaying a runbook for an operation you have run before. Takes the crtr skill name as a positional (a crtr identifier, never a file path — do not cat or find SKILL.md off disk) and returns the SKILL.md body plus its resolution metadata; add --no-body to just confirm a skill exists or locate it. Reach for `crtr skill find` first when you do not yet know which skill applies.',
  help: {
    name: 'skill read',
    summary: 'load SKILL.md body and resolution metadata for a named skill',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Skill identifier. Forms: <name>, <plugin>/<name>, <scope>/<name>, <scope>/<plugin>/<name>.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Narrows resolution when name is ambiguous.' },
      { kind: 'flag', name: 'plugin', type: 'string', required: false, constraint: 'Narrows resolution to a specific plugin.' },
      { kind: 'flag', name: 'frontmatter', type: 'bool', required: false, constraint: 'When present, includes YAML frontmatter in the output content.' },
      { kind: 'flag', name: 'no-body', type: 'bool', required: false, constraint: 'When present, omits the body — returns resolution metadata only. Use to confirm a skill exists or locate it without loading SKILL.md.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name, or category id when the name resolved to a group.' },
      { name: 'kind', type: 'string', required: false, constraint: '"category" when the name resolved to a group rather than a single skill.' },
      { name: 'count', type: 'integer', required: false, constraint: 'Number of skills in the category. Present when kind is "category".' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Plugin the skill belongs to. Omitted for category reads.' },
      { name: 'scope', type: 'string', required: false, constraint: 'Scope the skill was resolved from. Omitted for category reads.' },
      { name: 'path', type: 'string', required: false, constraint: 'Absolute path to SKILL.md. Omitted for category reads.' },
      { name: 'content', type: 'string', required: false, constraint: 'SKILL.md body or category index. Omitted when --no-body is set.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Hints at variant flags or next commands. Omitted when --no-body is set.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = input['name'] as string;
    const scopeStr = input['scope'] as string | undefined;
    const pluginFilter = input['plugin'] as string | undefined;
    const includeFrontmatter = input['frontmatter'] as boolean;
    const noBody = input['noBody'] as boolean;

    const resolveOpts: { scope?: Scope; pluginFilter?: string } = {};
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') resolveOpts.scope = resolved;
    }
    if (pluginFilter !== undefined) resolveOpts.pluginFilter = pluginFilter;

    let skillObj: Awaited<ReturnType<typeof resolveSkill>> | undefined;
    let notFoundErr: unknown;
    try {
      skillObj = resolveSkill(nameRaw, resolveOpts);
    } catch (e) {
      if (e instanceof CrtrError && e.code === 'not_found') {
        notFoundErr = e;
      } else {
        throw e;
      }
    }

    if (skillObj === undefined) {
      const cat = resolveCategory(nameRaw, resolveOpts);
      if (cat !== null) {
        if (noBody) return { name: cat.id, kind: 'category', count: cat.skills.length };
        return {
          name: cat.id,
          kind: 'category',
          count: cat.skills.length,
          content: buildCategoryIndex(cat),
          follow_up: 'Read a listed skill with `crtr skill read <id>`.',
        };
      }
      throw notFoundErr;
    }

    const out: Record<string, unknown> = {
      name: skillObj.name,
      plugin: skillObj.plugin,
      scope: skillObj.scope,
      path: skillObj.path,
    };

    if (noBody) return out;

    const rawContent = readText(skillObj.path);
    const rawBody = includeFrontmatter ? rawContent : parseFrontmatter(rawContent).body;
    out['content'] = appendNeighbors(skillObj, rawBody);
    out['follow_up'] = 'Add --no-body to skip the body and return path/scope/plugin only. Add --frontmatter to include YAML frontmatter in content.';
    return out;
  },
});
