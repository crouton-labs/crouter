import { join } from 'node:path';
import { defineLeaf, defineBranch } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { SCOPE_SKILL_PLUGIN, SKILLS_DIR } from '../../types.js';
import type { Skill } from '../../types.js';
import { listScopes, scopeSkillsDir } from '../../core/scope.js';
import { listAllSkills, listInstalledPlugins } from '../../core/resolver.js';
import { paginate } from '../../core/pagination.js';
import { walkFiles, readText } from '../../core/fs-utils.js';

export const findList = defineLeaf({
  name: 'list',
  description: 'paginated list of installed skills',
  whenToUse: 'browse the whole catalog of installed skills, paginated, when you want to see everything that is available rather than hunt for a particular topic. Use `crtr skill find search` instead when you already have a topic or keyword in mind.',
  help: {
    name: 'skill find list',
    summary: 'paginated list of installed skills',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
      { kind: 'flag', name: 'include-disabled', type: 'bool', required: false, constraint: 'When present, includes disabled skills.' },
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 50, constraint: 'Max 200.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
      { kind: 'flag', name: 'full', type: 'bool', required: false, constraint: 'When present, includes each skill\'s description in items. Off by default to keep enumerations cheap; pair with --plugin or --limit to bound cost.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {name, plugin, scope, enabled, disabled_in?}. With --full, each item also includes description. Sorted by scope then plugin then name ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Exact when cheap; null otherwise.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands for drilling into an item or refining the list.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeStr = input['scope'] as string | undefined;
    const pluginFilter = input['plugin'] as string | undefined;
    const includeDisabled = input['includeDisabled'] as boolean;
    const limitRaw = input['limit'] as number;
    const limit = Math.min(Math.max(1, limitRaw), 200);
    const cursor = input['cursor'] as string | undefined;
    const full = input['full'] as boolean;

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

    const keyOf = (sk: Skill) => `${sk.scope}/${sk.plugin}/${sk.name}`;
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
      items: result.items.map((sk) => {
        const base: Record<string, unknown> = {
          name: sk.name,
          plugin: sk.plugin,
          scope: sk.scope,
          enabled: sk.enabled,
          disabled_in: sk.disabledIn !== undefined ? sk.disabledIn : null,
        };
        if (full) {
          base['description'] = sk.frontmatter.description !== undefined ? sk.frontmatter.description : null;
        }
        return base;
      }),
      next_cursor: result.next_cursor,
      total: result.total,
      follow_up: 'Use `crtr skill read <name>` for the full SKILL.md body. Run `crtr skill find list -h` for filters and verbosity.',
    };
  },
});

export const findSearch = defineLeaf({
  name: 'search',
  description: 'keyword search across name/description/keywords',
  whenToUse: 'you have a topic, keyword, or problem in mind but not the exact skill name — search ranks installed skills by how well your terms match their name, description, and keywords. Reach for it to answer questions like is there a skill for writing tests, anything on prompt design, do we have a debugging workflow. Use `crtr skill find list` instead to browse the whole catalog when you have no particular topic in mind, and `crtr skill find grep` when you need an exact regex or literal-string match across skill bodies rather than a ranked topic match.',
  help: {
    name: 'skill find search',
    summary: 'search skills by name, description, and keywords',
    params: [
      { kind: 'positional', name: 'query', required: true, constraint: 'Whitespace-separated terms matched case-insensitively against name, description, and keywords; skills matching more terms rank higher.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
      { kind: 'flag', name: 'include-disabled', type: 'bool', required: false, constraint: 'When present, includes disabled skills.' },
      { kind: 'flag', name: 'search-body', type: 'bool', required: false, constraint: 'When present, also searches inside SKILL.md body text.' },
    ],
    output: [
      { name: 'query', type: 'string', required: true, constraint: 'Echo of the input query.' },
      { name: 'hits', type: 'object[]', required: true, constraint: 'Each: {name, plugin, scope, score, description}. Sorted by score descending. description is the frontmatter line — the discriminator for picking which hit to read in full.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands for drilling into a hit or refining the search.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const query = input['query'] as string;
    const scopeStr = input['scope'] as string | undefined;
    const pluginFilter = input['plugin'] as string | undefined;
    const includeDisabled = input['includeDisabled'] as boolean;
    const searchBody = input['searchBody'] as boolean;

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) throw usage('query must contain at least one non-whitespace term');

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
      const matchedSet = new Set<string>();
      let score = 0;
      const nameLc = sk.name.toLowerCase();
      const descLc = sk.frontmatter.description !== undefined ? sk.frontmatter.description.toLowerCase() : null;
      const kwsLc = sk.frontmatter.keywords !== undefined ? sk.frontmatter.keywords.map((k) => k.toLowerCase()) : null;
      const bodyLc = searchBody ? readText(sk.path).toLowerCase() : null;

      for (const term of terms) {
        if (nameLc.includes(term)) {
          score += 10;
          matchedSet.add('name');
        }
        if (descLc !== null && descLc.includes(term)) {
          score += 4;
          matchedSet.add('description');
        }
        if (kwsLc !== null && kwsLc.some((k) => k.includes(term))) {
          score += 6;
          matchedSet.add('keywords');
        }
        if (bodyLc !== null && bodyLc.includes(term)) {
          score += 1;
          matchedSet.add('body');
        }
      }

      if (score > 0) hits.push({ skill: sk, score, matched: Array.from(matchedSet) });
    }

    hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    return {
      query,
      hits: hits.map((h) => ({
        name: h.skill.name,
        plugin: h.skill.plugin,
        scope: h.skill.scope,
        score: h.score,
        description: h.skill.frontmatter.description !== undefined ? h.skill.frontmatter.description : null,
      })),
      follow_up: 'Use `crtr skill read <name>` for the full SKILL.md body. Run `crtr skill find search -h` for filters.',
    };
  },
});

export const findGrep = defineLeaf({
  name: 'grep',
  description: 'regex search across SKILL.md bodies',
  whenToUse: 'you need to find which skills contain a specific literal string or regex pattern in their SKILL.md body — an exact text match, not a ranked topic search: locating every skill that mentions a command name, a flag, or an exact phrase. Use `crtr skill find search` instead when you want skills matched by topic or keyword rather than exact body text.',
  help: {
    name: 'skill find grep',
    summary: 'search skill file contents for a regex pattern',
    params: [
      { kind: 'positional', name: 'pattern', required: true, constraint: 'ECMAScript regex. Applied to each line of every SKILL.md file.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'plugin', type: 'string', required: false, constraint: 'Filter to a single plugin name.' },
    ],
    output: [
      { name: 'matches', type: 'object[]', required: true, constraint: 'Each: {path, line, text}. path is absolute. Sorted by path then line ascending.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const pattern = input['pattern'] as string;
    const scopeStr = input['scope'] as string | undefined;
    const pluginFilter = input['plugin'] as string | undefined;

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

export const findBranch = defineBranch({
  name: 'find',
  description: 'list, search, or grep skills',
  whenToUse: 'you do not yet know which skill applies and need to discover what is installed — list to browse the whole catalog, search to rank skills by topic or keyword, grep to match exact text inside skill bodies.',
  help: {
    name: 'skill find',
    summary: 'discover skills by listing, keyword search, or body grep',
  },
  children: [findList, findSearch, findGrep],
});
