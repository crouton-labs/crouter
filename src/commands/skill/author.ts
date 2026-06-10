import { dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { defineLeaf, defineBranch } from '../../core/command.js';
import { usage, general, notFound } from '../../core/errors.js';
import { SKILL_TYPES, isSkillType } from '../../types.js';
import type { Scope } from '../../types.js';
import {
  parseSkillQualifier,
  findPluginByName,
} from '../../core/resolver.js';
import {
  resolveScopeArg,
  requireScopeRoot,
  scopeMemoryDir,
  pluginMemoryDir,
} from '../../core/scope.js';
import { ensureScopeInitialized } from '../../core/config.js';
import { ensureDir, pathExists } from '../../core/fs-utils.js';
import { skillCreatePrompt, skillTemplatePrompt } from '../../prompts/skill.js';
import { memoryFilePath, serializeMemoryDoc } from '../memory/shared.js';
import { VALID_TYPES, resolveWriteScope } from './shared.js';

export const authorGuide = defineLeaf({
  name: 'guide',
  description: 'load authoring workflow + skeleton for a type',
  whenToUse: 'REQUIRED reading before you author a new skill OR edit an existing one — it carries the SKILL.md format, the description-drives-discovery rule (when-to-use lives in the frontmatter description, never the body), the voice constraints, and the per-type workflow. Editing an existing skill counts: read this first, because the format and voice rules govern every change, not just new files.',
  help: {
    name: 'skill author guide',
    summary: 'load the skill authoring workflow — two stages: omit type to pick one, pass type for its full skeleton',
    params: [
      { kind: 'flag', name: 'type', type: 'enum', choices: [...VALID_TYPES], required: false, constraint: 'OMIT to receive the template-picker guide first; pass on the second call for that type\'s full workflow + skeleton.' },
      { kind: 'flag', name: 'topic', type: 'string', required: false, constraint: 'Optional topic context injected into the guide.' },
    ],
    output: [
      { name: 'guide', type: 'string', required: true, constraint: 'Stage 1 (no type): the template-picker workflow. Stage 2 (type given): that type\'s authoring workflow + skeleton.' },
      { name: 'type', type: 'string | null', required: true, constraint: 'Echo of the requested type, or null on the picker stage.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const type = input['type'] as string | undefined;
    const topic = input['topic'] as string | undefined;
    const topicArg = topic !== undefined ? topic : '';

    // Progressive disclosure: no type → template picker (stage 1);
    // type given → that type's full workflow + skeleton (stage 2).
    if (type === undefined) {
      return { guide: skillCreatePrompt(topicArg), type: null };
    }
    return { guide: skillTemplatePrompt(type, topicArg), type };
  },
});

export const authorScaffold = defineLeaf({
  name: 'scaffold',
  description: 'create an empty skill substrate doc stub',
  whenToUse: 'creating the empty `kind: skill` substrate doc at a `<plugin>/<skill>` qualifier (or a bare `<skill>` name for a scope-owned doc) before you fill in content — it writes the frontmatter and file, then points you at the authoring guide.',
  help: {
    name: 'skill author scaffold',
    summary: 'create an empty kind:skill substrate doc stub at the given qualifier',
    params: [
      { kind: 'positional', name: 'qualifier', required: true, constraint: 'Skill identifier: <plugin>/<skill> to scaffold into a plugin\'s memory/, or a bare <skill> for the scope-owned memory/.' },
      { kind: 'flag', name: 'type', type: 'enum', choices: [...VALID_TYPES], required: false, constraint: 'One of: playbook, primer, reference, runbook, freeform. Drives the follow-up authoring guide only — not stored on the substrate doc.' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Read-routing line written to the doc\'s when-and-why-to-read frontmatter.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded substrate doc.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call to load the authoring guide.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a `kind: skill` substrate doc stub under the resolved memory/ dir (scope-owned, or the named plugin\'s).',
      'Writes substrate frontmatter: kind:skill, when-and-why-to-read (from --description if given), system-prompt-visibility:name, file-read-visibility:none.',
    ],
  },
  run: async (input) => {
    const qualifier = input['qualifier'] as string;
    const typeStr = input['type'] as string | undefined;
    const description = input['description'] as string | undefined;
    const scopeStr = input['scope'] as string | undefined;

    const parsed = parseSkillQualifier(qualifier);
    if (parsed.segments.length === 0) {
      throw usage('skill name required in qualifier');
    }
    // For scaffold, the qualifier is always <plugin>/<skill>. If it's a single segment,
    // treat it as a scope-direct skill name. Otherwise first segment is the plugin.
    const pluginName = parsed.segments.length > 1 ? parsed.segments[0] : undefined;
    const skillName = parsed.segments.length > 1
      ? parsed.segments.slice(1).join('/')
      : parsed.segments[0];

    if (typeStr !== undefined && !isSkillType(typeStr)) {
      throw usage(`unknown skill type: ${typeStr} / valid: ${SKILL_TYPES.join(' | ')}`);
    }
    const skillType = typeStr !== undefined && isSkillType(typeStr) ? typeStr : undefined;

    // Resolve the memory/ dir to scaffold into: the named plugin's, or the
    // scope-owned one. One substrate, one author path.
    let memoryDir: string;
    if (pluginName === undefined) {
      const scope = resolveWriteScope(scopeStr);
      const scopeRootPath = requireScopeRoot(scope);
      ensureScopeInitialized(scope, scopeRootPath);
      const dir = scopeMemoryDir(scope);
      if (!dir) {
        throw general(`no memory dir for scope ${scope}`);
      }
      memoryDir = dir;
    } else {
      const scopeForLookup = scopeStr !== undefined
        ? (() => {
            const r = resolveScopeArg(scopeStr);
            return r !== 'all' ? (r as Scope) : undefined;
          })()
        : undefined;

      const plugin = scopeForLookup !== undefined
        ? findPluginByName(pluginName, scopeForLookup)
        : findPluginByName(pluginName);

      if (!plugin) {
        throw notFound(`plugin not found: ${pluginName}`);
      }
      memoryDir = pluginMemoryDir(plugin);
    }

    const skillFile = memoryFilePath(memoryDir, skillName);
    if (pathExists(skillFile)) {
      throw general(`skill already exists: ${skillFile}`);
    }
    ensureDir(dirname(skillFile));

    // Catalog-default substrate frontmatter (design §1.5): a name-rung,
    // file-read-none skill doc. --description becomes the read-routing line.
    const frontmatter: Record<string, unknown> = { kind: 'skill' };
    if (description !== undefined) frontmatter['when-and-why-to-read'] = description;
    frontmatter['system-prompt-visibility'] = 'name';
    frontmatter['file-read-visibility'] = 'none';
    writeFileSync(skillFile, serializeMemoryDoc(frontmatter, ''), 'utf8');

    const typeHint = skillType !== undefined ? `--type ${skillType} ` : '';
    const follow_up = `crtr skill author guide ${typeHint}--topic "${skillName}"`;

    return { path: skillFile, follow_up };
  },
});

export const authorBranch = defineBranch({
  name: 'author',
  description: 'create and scaffold skills',
  whenToUse: 'you have a reusable workflow, methodology, or hard-won convention worth capturing so future agents adopt it instead of re-deriving it — author carries you from picking a template through scaffolding the file. Reach for it when a task just taught you a repeatable procedure, when the same guidance keeps getting re-explained across sessions, or when the house conventions for a tool deserve to be written down once. Always start with `crtr skill author guide` — required reading before you author OR edit any skill (the SKILL.md format, the description-vs-body rule, and the voice constraints all live there) — then use `crtr skill author scaffold` to stub the SKILL.md file.',
  help: {
    name: 'skill author',
    summary: 'create and scaffold new skills',
  },
  children: [authorGuide, authorScaffold],
});
