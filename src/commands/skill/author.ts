import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { defineLeaf, defineBranch } from '../../core/command.js';
import { usage, general, notFound } from '../../core/errors.js';
import {
  SCOPE_SKILL_PLUGIN,
  SKILL_ENTRY_FILE,
  SKILLS_DIR,
  SKILL_TYPES,
  isSkillType,
} from '../../types.js';
import type { Scope } from '../../types.js';
import {
  parseSkillQualifier,
  findPluginByName,
} from '../../core/resolver.js';
import {
  resolveScopeArg,
  requireScopeRoot,
  scopeSkillsDir,
} from '../../core/scope.js';
import { serializeFrontmatter } from '../../core/frontmatter.js';
import { ensureScopeInitialized } from '../../core/config.js';
import { ensureDir, pathExists } from '../../core/fs-utils.js';
import { skillCreatePrompt, skillTemplatePrompt } from '../../prompts/skill.js';
import { VALID_TYPES, resolveWriteScope } from './shared.js';

export const authorGuide = defineLeaf({
  name: 'guide',
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
  help: {
    name: 'skill author scaffold',
    summary: 'create an empty SKILL.md stub at the given qualifier',
    params: [
      { kind: 'positional', name: 'qualifier', required: true, constraint: 'Skill identifier in <plugin>/<skill> form.' },
      { kind: 'flag', name: 'type', type: 'enum', choices: [...VALID_TYPES], required: false, constraint: 'One of: playbook, primer, reference, runbook, freeform.' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Short description written to frontmatter.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded SKILL.md.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call to load the authoring guide.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates the skill directory and SKILL.md stub at the resolved location.',
      'Writes frontmatter with name, description (if provided), and type (if provided).',
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

    let skillFile: string;

    // Scope-direct: no plugin qualifier, or explicit `_/` sentinel (internal only)
    if (pluginName === undefined || pluginName === SCOPE_SKILL_PLUGIN) {
      const scope = resolveWriteScope(scopeStr);
      const scopeRootPath = requireScopeRoot(scope);
      ensureScopeInitialized(scope, scopeRootPath);

      const skillsRoot = scopeSkillsDir(scope);
      if (!skillsRoot) {
        throw general(`no skills dir for scope ${scope}`);
      }
      const skillDir = join(skillsRoot, ...skillName.split('/'));
      skillFile = join(skillDir, SKILL_ENTRY_FILE);
      if (pathExists(skillFile)) {
        throw general(`skill already exists: ${skillFile}`);
      }
      ensureDir(skillDir);
      const fm = serializeFrontmatter({
        name: skillName,
        description,
        type: skillType,
      });
      writeFileSync(skillFile, fm, 'utf8');
    } else {
      // Plugin-scoped scaffold
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

      const skillDir = join(plugin.root, SKILLS_DIR, ...skillName.split('/'));
      skillFile = join(skillDir, SKILL_ENTRY_FILE);

      if (pathExists(skillFile)) {
        throw general(`skill already exists: ${skillFile}`);
      }

      ensureDir(skillDir);
      const fm = serializeFrontmatter({
        name: skillName,
        description,
        type: skillType,
      });
      writeFileSync(skillFile, fm, 'utf8');
    }

    const typeHint = skillType !== undefined ? `--type ${skillType} ` : '';
    const follow_up = `crtr skill author guide ${typeHint}--topic "${skillName}"`;

    return { path: skillFile, follow_up };
  },
});

export const authorBranch = defineBranch({
  name: 'author',
  help: {
    name: 'skill author',
    summary: 'create and scaffold new skills',
    children: [
      { name: 'guide', desc: 'load authoring workflow + skeleton for a type', useWhen: 'writing a new skill and need the template and instructions' },
      { name: 'scaffold', desc: 'create an empty SKILL.md stub', useWhen: 'initializing the file before writing content' },
    ],
  },
  children: [authorGuide, authorScaffold],
});
