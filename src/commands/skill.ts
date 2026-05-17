// `crtr skill` subtree handlers — P3 implementation.
// Sub-branches: find {list, search, grep}, read {show, where}, author {guide, scaffold}, state {enable, disable}.

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { reqStr, str, bool, int } from '../core/io.js';
import { usage, general, notFound } from '../core/errors.js';
import {
  SCOPE_SKILL_PLUGIN,
  SKILL_ENTRY_FILE,
  SKILLS_DIR,
  SKILL_TYPES,
  isSkillType,
  skillConfigKey,
} from '../types.js';
import type { Scope } from '../types.js';
import {
  resolveSkill,
  listAllSkills,
  listInstalledPlugins,
  findPluginByName,
  parseSkillQualifier,
  listSkillSiblings,
  listSkillChildren,
} from '../core/resolver.js';
import {
  listScopes,
  resolveScopeArg,
  requireScopeRoot,
  scopeSkillsDir,
  projectScopeRoot,
} from '../core/scope.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { updateConfig, ensureScopeInitialized } from '../core/config.js';
import { paginate } from '../core/pagination.js';
import { ensureDir, pathExists, readText, walkFiles } from '../core/fs-utils.js';
import { skillCreatePrompt, skillTemplatePrompt } from '../prompts/skill.js';
import type { Skill } from '../types.js';

// ---------------------------------------------------------------------------
// Neighbors section (ported from old impl)
// ---------------------------------------------------------------------------

function formatNeighborQualifier(s: Skill): string {
  return s.plugin === SCOPE_SKILL_PLUGIN
    ? `${s.scope}:${s.name}`
    : `${s.plugin}/${s.name}`;
}

function formatNeighborKeywords(s: Skill): string {
  const kw = s.frontmatter.keywords;
  if (!kw || kw.length === 0) return '';
  return ` — [${kw.join(', ')}]`;
}

function buildNeighborsSection(skill: Skill): string | null {
  const siblings = listSkillSiblings(skill);
  const children = listSkillChildren(skill);
  if (siblings.length === 0 && children.length === 0) return null;

  const lines: string[] = [
    '## Neighbors',
    '*Auto-discovered from filesystem. Run `crtr skill read show <name>` for full description + body.*',
    '',
  ];
  if (siblings.length > 0) {
    lines.push('**Siblings:**');
    for (const s of siblings) {
      lines.push(`- \`${formatNeighborQualifier(s)}\`${formatNeighborKeywords(s)}`);
    }
    if (children.length > 0) lines.push('');
  }
  if (children.length > 0) {
    lines.push('**Nested:**');
    for (const s of children) {
      lines.push(`- \`${formatNeighborQualifier(s)}\`${formatNeighborKeywords(s)}`);
    }
  }
  return lines.join('\n');
}

function appendNeighbors(skill: Skill, body: string): string {
  const section = buildNeighborsSection(skill);
  if (section === null) return body;
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  return body + sep + `<neighbors>\n${section}\n</neighbors>\n`;
}

// ---------------------------------------------------------------------------
// Resolve scope for enable/disable/scaffold
// ---------------------------------------------------------------------------

function resolveWriteScope(scopeStr: string | undefined): Scope {
  if (scopeStr !== undefined) {
    const resolved = resolveScopeArg(scopeStr);
    if (resolved === 'all') {
      throw usage('scope must be user or project, not all');
    }
    return resolved;
  }
  return projectScopeRoot() !== null ? 'project' : 'user';
}

// ---------------------------------------------------------------------------
// find sub-branch
// ---------------------------------------------------------------------------

const findList = defineLeaf({
  name: 'list',
  help: {
    name: 'skill find list',
    summary: 'paginated list of installed skills',
    input: [
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project, all. Default: all.' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
      { name: 'include_disabled', type: 'boolean', required: false, constraint: 'Default false. When true, includes disabled skills.' },
      { name: 'limit', type: 'integer', required: false, constraint: 'Default 50, max 200.' },
      { name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {name, plugin, scope, path, description?, enabled, disabled_in?}. Sorted by scope then plugin then name ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Exact when cheap; null otherwise.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeStr = str(input, 'scope');
    const pluginFilter = str(input, 'plugin');
    const includeDisabled = bool(input, 'include_disabled', false);
    const limit = int(input, 'limit', { default: 50, min: 1, max: 200 });
    const cursor = str(input, 'cursor');

    const scopes = listScopes(scopeStr);
    const skills = scopes
      .flatMap((s) => listAllSkills(s))
      .filter((sk) => {
        if (pluginFilter !== undefined && sk.plugin !== pluginFilter) return false;
        if (!includeDisabled && !sk.enabled) return false;
        return true;
      });

    // Sort by scope then plugin then name ascending
    const scopeOrder: Record<string, number> = { project: 0, user: 1, builtin: 2 };
    skills.sort((a, b) => {
      const so = (scopeOrder[a.scope] !== undefined ? scopeOrder[a.scope] : 3) -
                 (scopeOrder[b.scope] !== undefined ? scopeOrder[b.scope] : 3);
      if (so !== 0) return so;
      const po = a.plugin.localeCompare(b.plugin);
      if (po !== 0) return po;
      return a.name.localeCompare(b.name);
    });

    const keyOf = (sk: Skill) => `${sk.scope}:${sk.plugin}/${sk.name}`;
    const params: { limit?: number; cursor?: string } = {};
    if (limit !== undefined) params.limit = limit;
    if (cursor !== undefined) params.cursor = cursor;

    const result = paginate(skills, params, {
      defaultLimit: 50,
      maxLimit: 200,
      keyOf,
      total: 'count',
    });

    return {
      items: result.items.map((sk) => ({
        name: sk.name,
        plugin: sk.plugin,
        scope: sk.scope,
        path: sk.path,
        description: sk.frontmatter.description !== undefined ? sk.frontmatter.description : null,
        enabled: sk.enabled,
        disabled_in: sk.disabledIn !== undefined ? sk.disabledIn : null,
      })),
      next_cursor: result.next_cursor,
      total: result.total,
    };
  },
});

const findSearch = defineLeaf({
  name: 'search',
  help: {
    name: 'skill find search',
    summary: 'search skills by name, description, and keywords',
    input: [
      { name: 'query', type: 'string', required: true, constraint: 'Search terms matched against name, description, and keywords fields.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project, all. Default: all.' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
      { name: 'include_disabled', type: 'boolean', required: false, constraint: 'Default false.' },
      { name: 'body', type: 'boolean', required: false, constraint: 'Default false. When true, also searches SKILL.md body text.' },
    ],
    output: [
      { name: 'query', type: 'string', required: true, constraint: 'Echo of the input query.' },
      { name: 'hits', type: 'object[]', required: true, constraint: 'Each: {name, plugin, scope, path, description?, keywords?, enabled, score, matched}. Sorted by score descending.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const query = reqStr(input, 'query');
    const scopeStr = str(input, 'scope');
    const pluginFilter = str(input, 'plugin');
    const includeDisabled = bool(input, 'include_disabled', false);
    const searchBody = bool(input, 'body', false);

    const needle = query.toLowerCase();
    const scopes = listScopes(scopeStr);
    const candidates = scopes
      .flatMap((s) => listAllSkills(s))
      .filter((sk) => {
        if (pluginFilter !== undefined && sk.plugin !== pluginFilter) return false;
        if (!includeDisabled && !sk.enabled) return false;
        return true;
      });

    interface Hit {
      skill: Skill;
      score: number;
      matched: string[];
    }

    const hits: Hit[] = [];
    for (const sk of candidates) {
      const matched: string[] = [];
      let score = 0;
      if (sk.name.toLowerCase().includes(needle)) {
        score += 10;
        matched.push('name');
      }
      const desc = sk.frontmatter.description;
      if (desc !== undefined && desc.toLowerCase().includes(needle)) {
        score += 4;
        matched.push('description');
      }
      const kws = sk.frontmatter.keywords;
      if (kws && kws.some((k) => k.toLowerCase().includes(needle))) {
        score += 6;
        matched.push('keywords');
      }
      if (searchBody) {
        const text = readText(sk.path).toLowerCase();
        if (text.includes(needle)) {
          score += 1;
          matched.push('body');
        }
      }
      if (score > 0) hits.push({ skill: sk, score, matched });
    }

    hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    return {
      query,
      hits: hits.map((h) => ({
        name: h.skill.name,
        plugin: h.skill.plugin,
        scope: h.skill.scope,
        path: h.skill.path,
        description: h.skill.frontmatter.description !== undefined ? h.skill.frontmatter.description : null,
        keywords: h.skill.frontmatter.keywords !== undefined ? h.skill.frontmatter.keywords : null,
        enabled: h.skill.enabled,
        score: h.score,
        matched: h.matched,
      })),
    };
  },
});

const findGrep = defineLeaf({
  name: 'grep',
  help: {
    name: 'skill find grep',
    summary: 'search skill file contents for a regex pattern',
    input: [
      { name: 'pattern', type: 'string', required: true, constraint: 'ECMAScript regex. Applied to each line of every SKILL.md file.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project, all. Default: all.' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
    ],
    output: [
      { name: 'matches', type: 'object[]', required: true, constraint: 'Each: {path, line, text}. path is absolute. Sorted by path then line ascending.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const pattern = reqStr(input, 'pattern');
    const scopeStr = str(input, 'scope');
    const pluginFilter = str(input, 'plugin');

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw usage(`invalid regex pattern: ${pattern}`);
    }

    const scopes = listScopes(scopeStr);
    const skillsDirs: string[] = [];
    for (const s of scopes) {
      if (pluginFilter === undefined || pluginFilter === SCOPE_SKILL_PLUGIN) {
        const root = scopeSkillsDir(s);
        if (root) skillsDirs.push(root);
      }
      for (const plugin of listInstalledPlugins(s)) {
        if (!plugin.enabled) continue;
        if (pluginFilter !== undefined && plugin.name !== pluginFilter) continue;
        skillsDirs.push(join(plugin.root, SKILLS_DIR));
      }
    }

    const matchLines: Array<{ path: string; line: number; text: string }> = [];
    for (const skillsDir of skillsDirs) {
      const files = walkFiles(skillsDir);
      for (const file of files) {
        const content = readText(file);
        const lines = content.split('\n');
        lines.forEach((lineText, idx) => {
          if (regex.test(lineText)) {
            matchLines.push({ path: file, line: idx + 1, text: lineText });
          }
        });
      }
    }

    // Sort by path then line ascending
    matchLines.sort((a, b) => {
      const pc = a.path.localeCompare(b.path);
      return pc !== 0 ? pc : a.line - b.line;
    });

    return { matches: matchLines };
  },
});

const findBranch = defineBranch({
  name: 'find',
  help: {
    name: 'skill find',
    summary: 'discover skills by listing, keyword search, or body grep',
    children: [
      { name: 'list', desc: 'paginated list of installed skills', useWhen: 'enumerating all available skills' },
      { name: 'search', desc: 'keyword search across name/description/keywords', useWhen: 'looking for skills matching a topic' },
      { name: 'grep', desc: 'regex search across SKILL.md bodies', useWhen: 'finding skills containing specific text or patterns' },
    ],
  },
  children: [findList, findSearch, findGrep],
});

// ---------------------------------------------------------------------------
// read sub-branch
// ---------------------------------------------------------------------------

const readShow = defineLeaf({
  name: 'show',
  help: {
    name: 'skill read show',
    summary: 'print SKILL.md body for a named skill',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Skill identifier. Forms: <name>, <plugin>:<name>, <scope>:<name>, <scope>:<plugin>/<name>.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Narrows resolution when name is ambiguous.' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Narrows resolution to a specific plugin.' },
      { name: 'frontmatter', type: 'boolean', required: false, constraint: 'Default false. When true, includes YAML frontmatter in the body.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'plugin', type: 'string', required: true, constraint: 'Plugin the skill belongs to.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the skill was resolved from.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to SKILL.md.' },
      { name: 'content', type: 'string', required: true, constraint: 'SKILL.md body (with or without frontmatter per the `frontmatter` input field).' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = reqStr(input, 'name');
    const scopeStr = str(input, 'scope');
    const pluginFilter = str(input, 'plugin');
    const includeFrontmatter = bool(input, 'frontmatter', false);

    const resolveOpts: { scope?: Scope; pluginFilter?: string } = {};
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') resolveOpts.scope = resolved;
    }
    if (pluginFilter !== undefined) resolveOpts.pluginFilter = pluginFilter;

    const skillObj = resolveSkill(nameRaw, resolveOpts);
    const rawContent = readText(skillObj.path);
    const rawBody = includeFrontmatter ? rawContent : parseFrontmatter(rawContent).body;
    const content = appendNeighbors(skillObj, rawBody);

    return {
      name: skillObj.name,
      plugin: skillObj.plugin,
      scope: skillObj.scope,
      path: skillObj.path,
      content,
    };
  },
});

const readWhere = defineLeaf({
  name: 'where',
  help: {
    name: 'skill read where',
    summary: 'show resolution metadata for a named skill without reading its body',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Skill identifier. Same forms as skill read show.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project.' },
      { name: 'plugin', type: 'string', required: false, constraint: 'Narrows resolution to a specific plugin.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'plugin', type: 'string', required: true, constraint: 'Plugin the skill belongs to.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the skill was resolved from.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to SKILL.md.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = reqStr(input, 'name');
    const scopeStr = str(input, 'scope');
    const pluginFilter = str(input, 'plugin');

    const resolveOpts: { scope?: Scope; pluginFilter?: string } = {};
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') resolveOpts.scope = resolved;
    }
    if (pluginFilter !== undefined) resolveOpts.pluginFilter = pluginFilter;

    const skillObj = resolveSkill(nameRaw, resolveOpts);

    return {
      name: skillObj.name,
      plugin: skillObj.plugin,
      scope: skillObj.scope,
      path: skillObj.path,
    };
  },
});

const readBranch = defineBranch({
  name: 'read',
  help: {
    name: 'skill read',
    summary: 'read skill content or resolve its location',
    children: [
      { name: 'show', desc: 'print SKILL.md body', useWhen: 'loading skill content to act on it' },
      { name: 'where', desc: 'show resolution metadata only', useWhen: 'verifying which skill resolves and from where, without loading its body' },
    ],
  },
  children: [readShow, readWhere],
});

// ---------------------------------------------------------------------------
// author sub-branch
// ---------------------------------------------------------------------------

const VALID_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'] as const;

const authorGuide = defineLeaf({
  name: 'guide',
  help: {
    name: 'skill author guide',
    summary: 'load the skill authoring workflow — two stages: omit type to pick one, pass type for its full skeleton',
    input: [
      { name: 'type', type: 'string', required: false, constraint: 'One of: playbook, primer, reference, runbook, freeform. OMIT to receive the template-picker guide first; pass it on the second call for that type\'s full workflow + skeleton.' },
      { name: 'topic', type: 'string', required: false, constraint: 'Optional topic context injected into the guide.' },
    ],
    output: [
      { name: 'guide', type: 'string', required: true, constraint: 'Stage 1 (no type): the template-picker workflow. Stage 2 (type given): that type\'s authoring workflow + skeleton.' },
      { name: 'type', type: 'string | null', required: true, constraint: 'Echo of the requested type, or null on the picker stage.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const type = str(input, 'type', { enum: VALID_TYPES });
    const topic = str(input, 'topic');
    const topicArg = topic !== undefined ? topic : '';

    // Progressive disclosure: no type → template picker (stage 1);
    // type given → that type's full workflow + skeleton (stage 2).
    if (type === undefined) {
      return { guide: skillCreatePrompt(topicArg), type: null };
    }
    return { guide: skillTemplatePrompt(type, topicArg), type };
  },
});

const authorScaffold = defineLeaf({
  name: 'scaffold',
  help: {
    name: 'skill author scaffold',
    summary: 'create an empty SKILL.md stub at the given qualifier',
    input: [
      { name: 'qualifier', type: 'string', required: true, constraint: 'Skill identifier in <name> or <plugin>:<name> form.' },
      { name: 'type', type: 'string', required: false, constraint: 'One of: playbook, primer, reference, runbook, freeform.' },
      { name: 'description', type: 'string', required: false, constraint: 'Short description written to frontmatter.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
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
    const qualifier = reqStr(input, 'qualifier');
    const typeStr = str(input, 'type', { enum: VALID_TYPES });
    const description = str(input, 'description');
    const scopeStr = str(input, 'scope');

    const { plugin: pluginName, name: skillName } = parseSkillQualifier(qualifier);
    if (!skillName) {
      throw usage('skill name required in qualifier');
    }

    if (typeStr !== undefined && !isSkillType(typeStr)) {
      throw usage(`unknown skill type: ${typeStr} / valid: ${SKILL_TYPES.join(' | ')}`);
    }
    const skillType = typeStr !== undefined && isSkillType(typeStr) ? typeStr : undefined;

    let skillFile: string;

    // Scope-direct: no plugin qualifier, or explicit `_:` sentinel
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

    const typeHint = skillType !== undefined ? skillType : '<type>';
    const follow_up = `{"type":"${typeHint}","topic":"${skillName}"} | crtr skill author guide`;

    return { path: skillFile, follow_up };
  },
});

const authorBranch = defineBranch({
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

// ---------------------------------------------------------------------------
// state sub-branch
// ---------------------------------------------------------------------------

async function toggleSkill(
  input: Record<string, unknown>,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  const nameRaw = reqStr(input, 'name');
  const scopeStr = str(input, 'scope');
  const scope = resolveWriteScope(scopeStr);

  const skillObj = resolveSkill(nameRaw);
  const key = skillConfigKey(skillObj.plugin, skillObj.name);

  const scopeRootPath = requireScopeRoot(scope);
  ensureScopeInitialized(scope, scopeRootPath);

  updateConfig(scope, (cfg) => {
    cfg.skills[key] = { enabled };
  });

  return { name: skillObj.name, scope, enabled };
}

const stateEnable = defineLeaf({
  name: 'enable',
  help: {
    name: 'skill state enable',
    summary: 'enable a skill in the given scope',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Skill identifier. Same forms as skill read show.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope where the enable was applied.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always true.' },
    ],
    outputKind: 'object',
    effects: ['Writes the skill enable flag to config.json in the target scope.'],
  },
  run: async (input) => toggleSkill(input, true),
});

const stateDisable = defineLeaf({
  name: 'disable',
  help: {
    name: 'skill state disable',
    summary: 'disable a skill in the given scope, hiding it from list and agent discovery',
    input: [
      { name: 'name', type: 'string', required: true, constraint: 'Skill identifier. Same forms as skill read show.' },
      { name: 'scope', type: 'string', required: false, constraint: 'One of: user, project. Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope where the disable was applied.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always false.' },
    ],
    outputKind: 'object',
    effects: ['Writes the skill disable flag to config.json in the target scope.'],
  },
  run: async (input) => toggleSkill(input, false),
});

const stateBranch = defineBranch({
  name: 'state',
  help: {
    name: 'skill state',
    summary: 'enable or disable skills',
    children: [
      { name: 'enable', desc: 'enable a skill', useWhen: 'making a previously disabled skill available again' },
      { name: 'disable', desc: 'disable a skill', useWhen: 'hiding a skill from list and agent discovery without removing it' },
    ],
  },
  children: [stateEnable, stateDisable],
});

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function registerSkill(): BranchDef {
  return defineBranch({
    name: 'skill',
    help: {
      name: 'skill',
      summary: 'discover, read, author, and manage skill state',
      children: [
        { name: 'find', desc: 'list, search, or grep skills', useWhen: 'discovering what skills are available' },
        { name: 'read', desc: 'read skill content or resolve location', useWhen: 'loading a skill to act on it' },
        { name: 'author', desc: 'create and scaffold skills', useWhen: 'writing a new skill' },
        { name: 'state', desc: 'enable or disable skills', useWhen: 'toggling skill visibility' },
      ],
    },
    children: [findBranch, readBranch, authorBranch, stateBranch],
  });
}
