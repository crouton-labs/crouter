import { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  SCHEMA_VERSION,
  SCOPE_SKILL_PLUGIN,
  SKILL_ENTRY_FILE,
  SKILLS_DIR,
  SKILL_TYPES,
  isSkillType,
} from '../types.js';
import type { Scope, SkillType } from '../types.js';
import { skillConfigKey } from '../types.js';
import { CrtrError, notFound, usage, general } from '../core/errors.js';
import {
  out,
  hint,
  info,
  jsonOut,
  handleError,
} from '../core/output.js';
import {
  listScopes,
  requireScopeRoot,
  resolveScopeArg,
  projectScopeRoot,
  scopeSkillsDir,
} from '../core/scope.js';
import {
  resolveSkill,
  listAllSkills,
  listInstalledPlugins,
  findPluginByName,
  parseSkillQualifier,
  listSkillSiblings,
  listSkillChildren,
} from '../core/resolver.js';
import type { Skill } from '../types.js';
import { updateConfig, ensureScopeInitialized } from '../core/config.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { ensureDir, pathExists, readText, walkFiles } from '../core/fs-utils.js';
import { skillPrompt, skillCreatePrompt, skillTemplatePrompt } from '../prompts/skill.js';

const KNOWN_VERBS = new Set([
  'list',
  'show',
  'path',
  'grep',
  'new',
  'create',
  'template',
  'where',
  'enable',
  'disable',
  'search',
]);

const AUTHORING_GUIDE_SKILL = 'authoring-skills';

function buildShowFooter(skillPath: string): string {
  return (
    `crtr: edit this skill directly at ${skillPath} — ` +
    `for SKILL.md authoring guidance run \`crtr skill ${AUTHORING_GUIDE_SKILL}\``
  );
}

function wrapSkill(name: string, path: string, content: string): string {
  return `<skill name="${name}" path="${path}">\n${content.endsWith('\n') ? content : content + '\n'}</skill>`;
}

function formatNeighborQualifier(s: Skill): string {
  return s.plugin === SCOPE_SKILL_PLUGIN ? `${s.scope}:${s.name}` : `${s.plugin}/${s.name}`;
}

function buildNeighborsSection(skill: Skill): string | null {
  const siblings = listSkillSiblings(skill);
  const children = listSkillChildren(skill);
  if (siblings.length === 0 && children.length === 0) return null;

  const lines: string[] = [
    '## Neighbors',
    '*Auto-discovered from filesystem. Use `--no-neighbors` to suppress.*',
    '',
  ];
  if (siblings.length > 0) {
    lines.push('**Siblings:**');
    for (const s of siblings) {
      const desc = s.frontmatter.description !== undefined ? s.frontmatter.description : '';
      lines.push(`- \`${formatNeighborQualifier(s)}\`${desc ? ` — ${desc}` : ''}`);
    }
    if (children.length > 0) lines.push('');
  }
  if (children.length > 0) {
    lines.push('**Nested:**');
    for (const s of children) {
      const desc = s.frontmatter.description !== undefined ? s.frontmatter.description : '';
      lines.push(`- \`${formatNeighborQualifier(s)}\`${desc ? ` — ${desc}` : ''}`);
    }
  }
  return lines.join('\n');
}

function appendNeighbors(skill: Skill, body: string, suppress: boolean): string {
  if (suppress) return body;
  const section = buildNeighborsSection(skill);
  if (section === null) return body;
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  return body + sep + `<neighbors>\n${section}\n</neighbors>\n`;
}

const SKILL_IDENTIFIER_HELP =
  'Skill identifier forms (accepted by show, path, where, enable, disable):\n' +
  '  <name>                       bare name — resolves scope-root first, then plugins\n' +
  '  <plugin>:<name>              explicit plugin (canonical)\n' +
  '  <scope>:<name>               scope-root skill in a specific scope (user|project)\n' +
  '  <scope>:<plugin>/<name>      fully qualified — matches `skill list` / `skill search` output\n' +
  '  <plugin>/<name>              shorthand for <plugin>:<name> when unambiguous';

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill [nameOrVerb] [rest...]')
    .description('manage and inspect skills')
    .option('--frontmatter', 'include YAML frontmatter in the printed body')
    .addHelpText('after', '\n' + SKILL_IDENTIFIER_HELP)
    .action(
      async (
        nameOrVerb: string | undefined,
        _rest: string[],
        opts: { frontmatter?: boolean },
      ) => {
        if (nameOrVerb === undefined) {
          out(skillPrompt());
          return;
        }
        if (!KNOWN_VERBS.has(nameOrVerb)) {
          try {
            const skillObj = resolveSkill(nameOrVerb);
            const content = readText(skillObj.path);
            const rawBody = opts.frontmatter ? content : parseFrontmatter(content).body;
            const body = appendNeighbors(skillObj, rawBody, false);
            out(wrapSkill(skillObj.name, skillObj.path, body));
            hint(buildShowFooter(skillObj.path));
          } catch (e) {
            handleError(e);
          }
        }
      },
    );

  // list
  skill
    .command('list')
    .description('list installed skills (disabled hidden unless -a)')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--plugin <name>', 'filter by plugin name')
    .option('-a, --all', 'include disabled skills')
    .option('--json', 'emit JSON')
    .addHelpText(
      'after',
      '\nOutput format: <scope>:<plugin>/<name> — paste this identifier into ' +
        '`crtr skill show` to read the skill.',
    )
    .action(
      async (opts: {
        scope?: string;
        plugin?: string;
        all?: boolean;
        json?: boolean;
      }) => {
        try {
          const scopes = listScopes(opts.scope);
          const skills = scopes
            .flatMap((s: Scope) => listAllSkills(s))
            .filter((sk) => {
              if (opts.plugin !== undefined && sk.plugin !== opts.plugin) return false;
              if (!opts.all && !sk.enabled) return false;
              return true;
            });

          if (opts.json) {
            jsonOut({
              skills: skills.map((sk) => ({
                name: sk.name,
                plugin: sk.plugin,
                scope: sk.scope,
                path: sk.path,
                description: sk.frontmatter.description,
                enabled: sk.enabled,
                disabled_in: sk.disabledIn,
              })),
            });
            return;
          }

          for (const sk of skills) {
            const desc = sk.frontmatter.description !== undefined ? sk.frontmatter.description : '';
            const marker = sk.enabled ? '' : ` [disabled${sk.disabledIn ? `@${sk.disabledIn}` : ''}]`;
            const qualified =
              sk.plugin === SCOPE_SKILL_PLUGIN
                ? `${sk.scope}:${sk.name}`
                : `${sk.scope}:${sk.plugin}/${sk.name}`;
            out(`${qualified}${marker}${desc ? `  — ${desc}` : ''}`);
          }
        } catch (e) {
          handleError(e, { json: opts.json });
        }
      },
    );

  // show
  skill
    .command('show <name>')
    .description('print SKILL.md body to stdout (default verb)')
    .option('--scope <scope>', 'user|project')
    .option('--plugin <name>', 'filter by plugin name')
    .option('--frontmatter', 'include YAML frontmatter in the printed body')
    .option('--no-neighbors', 'suppress the auto-appended ## Neighbors section')
    .option('--json', 'emit JSON')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  crtr skill show rules                              # bare name\n' +
        '  crtr skill show claude-authoring:rules             # plugin:name (canonical)\n' +
        '  crtr skill show user:claude-authoring/rules        # scope:plugin/name (matches search/list output)\n' +
        '  crtr skill show claude-authoring/rules             # plugin/name shorthand\n\n' +
        SKILL_IDENTIFIER_HELP,
    )
    .action(
      async (
        name: string,
        opts: {
          scope?: string;
          plugin?: string;
          frontmatter?: boolean;
          neighbors?: boolean;
          json?: boolean;
        },
      ) => {
      try {
        const scopeArg = resolveScopeArg(opts.scope);
        const resolveOpts = scopeArg !== 'all' ? { scope: scopeArg as Scope } : {};
        if (opts.plugin !== undefined) {
          Object.assign(resolveOpts, { pluginFilter: opts.plugin });
        }
        const skillObj = resolveSkill(name, resolveOpts);
        const content = readText(skillObj.path);
        const rawBody = opts.frontmatter ? content : parseFrontmatter(content).body;
        const suppressNeighbors = opts.neighbors === false;
        const body = appendNeighbors(skillObj, rawBody, suppressNeighbors);

        if (opts.json) {
          jsonOut({
            name: skillObj.name,
            plugin: skillObj.plugin,
            scope: skillObj.scope,
            path: skillObj.path,
            content,
            authoring_guide_command: `crtr skill ${AUTHORING_GUIDE_SKILL}`,
          });
          return;
        }

        out(wrapSkill(skillObj.name, skillObj.path, body));
        hint(buildShowFooter(skillObj.path));
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    },
  );

  // path
  skill
    .command('path <name>')
    .description('print absolute path to SKILL.md')
    .option('--scope <scope>', 'user|project')
    .option('--plugin <name>', 'filter by plugin name')
    .action(async (name: string, opts: { scope?: string; plugin?: string }) => {
      try {
        const scopeArg = resolveScopeArg(opts.scope);
        const resolveOpts = scopeArg !== 'all' ? { scope: scopeArg as Scope } : {};
        if (opts.plugin !== undefined) {
          Object.assign(resolveOpts, { pluginFilter: opts.plugin });
        }
        const skillObj = resolveSkill(name, resolveOpts);
        out(skillObj.path);
      } catch (e) {
        handleError(e);
      }
    });

  // grep
  skill
    .command('grep <pattern>')
    .description('search skill file contents for a regex pattern')
    .option('--scope <scope>', 'user|project|all')
    .option('--plugin <name>', 'filter by plugin name')
    .option('--json', 'emit JSON')
    .action(async (pattern: string, opts: { scope?: string; plugin?: string; json?: boolean }) => {
      try {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch {
          throw usage(`invalid regex pattern: ${pattern}`);
        }

        const scopes = listScopes(opts.scope);

        const skillsDirs: string[] = [];
        for (const s of scopes) {
          if (opts.plugin === undefined || opts.plugin === SCOPE_SKILL_PLUGIN) {
            const root = scopeSkillsDir(s);
            if (root) skillsDirs.push(root);
          }
          for (const plugin of listInstalledPlugins(s)) {
            if (!plugin.enabled) continue;
            if (opts.plugin !== undefined && plugin.name !== opts.plugin) continue;
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

        if (opts.json) {
          jsonOut({ matches: matchLines });
          return;
        }

        for (const m of matchLines) {
          out(`${m.path}:${m.line}: ${m.text}`);
        }
      } catch (e) {
        handleError(e, { json: opts.json });
      }
    });

  // new
  skill
    .command('new <qualifier>')
    .description('scaffold a new skill — <name> (scope-direct) or <plugin>:<name>')
    .option('--scope <scope>', 'user|project (default: project then user)')
    .option('--description <text>', 'skill description for frontmatter')
    .option(
      '--type <type>',
      `skill type for frontmatter — one of: ${SKILL_TYPES.join(' | ')}`,
    )
    .action(
      async (
        qualifier: string,
        opts: { scope?: string; description?: string; type?: string },
      ) => {
      try {
        const { plugin: pluginName, name: skillName } = parseSkillQualifier(qualifier);
        if (!skillName) {
          throw usage('skill name required');
        }

        let skillType: SkillType | undefined;
        if (opts.type !== undefined) {
          if (!isSkillType(opts.type)) {
            throw usage(
              `unknown skill type: ${opts.type} / valid: ${SKILL_TYPES.join(' | ')}`,
            );
          }
          skillType = opts.type;
        }

        const scopeArg = opts.scope !== undefined ? resolveScopeArg(opts.scope) : undefined;

        // Scope-direct: no plugin qualifier, or explicit `_:` sentinel
        if (pluginName === undefined || pluginName === SCOPE_SKILL_PLUGIN) {
          let scope: Scope;
          if (scopeArg !== undefined && scopeArg !== 'all') {
            scope = scopeArg as Scope;
          } else {
            scope = projectScopeRoot() !== null ? 'project' : 'user';
          }
          const scopeRootPath = requireScopeRoot(scope);
          ensureScopeInitialized(scope, scopeRootPath);

          const skillsRoot = scopeSkillsDir(scope);
          if (!skillsRoot) {
            throw general(`no skills dir for scope ${scope}`);
          }
          const skillDir = join(skillsRoot, ...skillName.split('/'));
          const skillFile = join(skillDir, SKILL_ENTRY_FILE);
          if (pathExists(skillFile)) {
            throw general(`skill already exists: ${skillFile}`);
          }
          ensureDir(skillDir);
          const fm = serializeFrontmatter({
            name: skillName,
            description: opts.description,
            type: skillType,
          });
          writeFileSync(skillFile, fm, 'utf8');

          out(skillFile);
          hint(
            `crtr: scaffolded ${scope}-scope skill ${skillName} — edit directly, then ` +
              `\`crtr skill ${AUTHORING_GUIDE_SKILL}\` for SKILL.md authoring guidance`,
          );
          return;
        }

        let plugin;
        if (scopeArg !== undefined && scopeArg !== 'all') {
          plugin = findPluginByName(pluginName, scopeArg as Scope);
        } else {
          plugin = findPluginByName(pluginName);
        }

        if (!plugin) {
          throw notFound(`plugin not found: ${pluginName}`);
        }

        const skillDir = join(plugin.root, SKILLS_DIR, ...skillName.split('/'));
        const skillFile = join(skillDir, SKILL_ENTRY_FILE);

        if (pathExists(skillFile)) {
          throw general(`skill already exists: ${skillFile}`);
        }

        ensureDir(skillDir);

        const fm = serializeFrontmatter({
          name: skillName,
          description: opts.description,
          type: skillType,
        });

        writeFileSync(skillFile, fm, 'utf8');

        out(skillFile);
        hint(
          `crtr: scaffolded ${skillFile} — edit directly, then ` +
            `\`crtr skill ${AUTHORING_GUIDE_SKILL}\` for SKILL.md authoring guidance`,
        );
      } catch (e) {
        handleError(e);
      }
    });

  // create — pick a template type
  skill
    .command('create [topic...]')
    .description(`pick a template type for a new skill (${SKILL_TYPES.join(' | ')})`)
    .action(async (topic: string[]) => {
      const arg = topic && topic.length > 0 ? topic.join(' ') : '';
      out(skillCreatePrompt(arg));
    });

  // template — full workflow + skeleton for one template type
  skill
    .command('template <type> [topic...]')
    .description(`full workflow + skeleton for a template type (${SKILL_TYPES.join(' | ')})`)
    .action(async (type: string, topic: string[]) => {
      const arg = topic && topic.length > 0 ? topic.join(' ') : '';
      out(skillTemplatePrompt(type, arg));
    });

  // where
  skill
    .command('where <name>')
    .description('show resolution info as JSON')
    .option('--scope <scope>', 'user|project')
    .option('--plugin <name>', 'filter by plugin name')
    .action(async (name: string, opts: { scope?: string; plugin?: string }) => {
      try {
        const scopeArg = resolveScopeArg(opts.scope);
        const resolveOpts = scopeArg !== 'all' ? { scope: scopeArg as Scope } : {};
        if (opts.plugin !== undefined) {
          Object.assign(resolveOpts, { pluginFilter: opts.plugin });
        }
        const skillObj = resolveSkill(name, resolveOpts);
        jsonOut({
          name: skillObj.name,
          plugin: skillObj.plugin,
          scope: skillObj.scope,
          path: skillObj.path,
        });
      } catch (e) {
        handleError(e);
      }
    });

  // enable
  skill
    .command('enable <name>')
    .description('enable a skill (clears any disable in the chosen scope)')
    .option('--scope <scope>', 'user|project (default: project if available, else user)')
    .action(async (name: string, opts: { scope?: string }) => {
      try {
        await toggleSkill(name, true, opts.scope);
      } catch (e) {
        handleError(e);
      }
    });

  // disable
  skill
    .command('disable <name>')
    .description('disable a skill (hides from list and agent discovery)')
    .option('--scope <scope>', 'user|project (default: project if available, else user)')
    .action(async (name: string, opts: { scope?: string }) => {
      try {
        await toggleSkill(name, false, opts.scope);
      } catch (e) {
        handleError(e);
      }
    });

  // search
  skill
    .command('search <query>')
    .description('search skills by name, description, and keywords')
    .option('--scope <scope>', 'user|project|all (default: all)')
    .option('--plugin <name>', 'filter by plugin name')
    .option('-a, --all', 'include disabled skills')
    .option('--body', 'also search SKILL.md body')
    .option('--json', 'emit JSON')
    .addHelpText(
      'after',
      '\nOutput columns (tab-separated): <scope>:<plugin>/<name>  <matched-fields>  <description>\n' +
        'The identifier is pasteable into `crtr skill show`.',
    )
    .action(
      async (
        query: string,
        opts: {
          scope?: string;
          plugin?: string;
          all?: boolean;
          body?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const needle = query.toLowerCase();
          const scopes = listScopes(opts.scope);
          const candidates = scopes
            .flatMap((s: Scope) => listAllSkills(s))
            .filter((sk) => {
              if (opts.plugin !== undefined && sk.plugin !== opts.plugin) return false;
              if (!opts.all && !sk.enabled) return false;
              return true;
            });

          interface Hit {
            skill: typeof candidates[number];
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
            if (opts.body) {
              const text = readText(sk.path).toLowerCase();
              if (text.includes(needle)) {
                score += 1;
                matched.push('body');
              }
            }
            if (score > 0) hits.push({ skill: sk, score, matched });
          }
          hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

          if (opts.json) {
            jsonOut({
              query,
              hits: hits.map((h) => ({
                name: h.skill.name,
                plugin: h.skill.plugin,
                scope: h.skill.scope,
                path: h.skill.path,
                description: h.skill.frontmatter.description,
                keywords: h.skill.frontmatter.keywords,
                enabled: h.skill.enabled,
                score: h.score,
                matched: h.matched,
              })),
            });
            return;
          }

          for (const h of hits) {
            const desc =
              h.skill.frontmatter.description !== undefined
                ? h.skill.frontmatter.description
                : '';
            const marker = h.skill.enabled ? '' : ' [disabled]';
            const qualified =
              h.skill.plugin === SCOPE_SKILL_PLUGIN
                ? `${h.skill.scope}:${h.skill.name}`
                : `${h.skill.scope}:${h.skill.plugin}/${h.skill.name}`;
            out(`${qualified}${marker}\t${h.matched.join(',')}\t${desc}`);
          }
        } catch (e) {
          handleError(e, { json: opts.json });
        }
      },
    );
}

async function toggleSkill(
  name: string,
  enabled: boolean,
  scopeArgRaw: string | undefined,
): Promise<void> {
  let scope: Scope;
  if (scopeArgRaw !== undefined) {
    const resolved = resolveScopeArg(scopeArgRaw);
    if (resolved === 'all') throw usage('--scope must be user or project for enable/disable');
    scope = resolved;
  } else {
    scope = projectScopeRoot() !== null ? 'project' : 'user';
  }

  const skillObj = resolveSkill(name);
  const key = skillConfigKey(skillObj.plugin, skillObj.name);

  const scopeRootPath = requireScopeRoot(scope);
  ensureScopeInitialized(scope, scopeRootPath);

  updateConfig(scope, (cfg) => {
    cfg.skills[key] = { enabled };
  });

  info(
    `${enabled ? 'enabled' : 'disabled'} ${skillObj.plugin}:${skillObj.name} in ${scope} scope`,
  );
}
