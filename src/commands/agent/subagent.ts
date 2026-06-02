import { defineLeaf, defineBranch } from '../../core/command.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usage, general } from '../../core/errors.js';
import { listSubagents, resolveSubagent, subagentId, scopeAgentsDir } from '../../core/subagents.js';
import { resolveScopeArg, requireScopeRoot, projectScopeRoot } from '../../core/scope.js';
import { ensureScopeInitialized } from '../../core/config.js';
import { ensureDir, pathExists } from '../../core/fs-utils.js';
import type { Scope } from '../../types.js';
import { buildSubagentCatalog } from './shared.js';

// ---------------------------------------------------------------------------
// agent subagent (management branch: list / read / scaffold)
// ---------------------------------------------------------------------------

const subagentList = defineLeaf({
  name: 'list',
  help: {
    name: 'agent subagent list',
    summary: 'list defined subagents (markdown + frontmatter) discoverable from scope roots and plugins',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'full', type: 'bool', required: false, constraint: 'When present, includes each subagent\'s model and tools.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {id, name, plugin, scope, description}. With --full also {model, tools}. Sorted by name.' },
      { name: 'total', type: 'integer', required: true, constraint: 'Number of subagents returned.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Next commands for reading or spawning a subagent.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeStr = input['scope'] as string | undefined;
    const full = input['full'] === true;
    let scopeFilter: Scope | undefined;
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') scopeFilter = resolved;
    }
    const agents = listSubagents(scopeFilter);
    return {
      items: agents.map((a) => {
        const base: Record<string, unknown> = {
          id: subagentId(a),
          name: a.name,
          plugin: a.plugin,
          scope: a.scope,
          description: a.frontmatter.description !== undefined ? a.frontmatter.description : null,
        };
        if (full) {
          base['model'] = a.frontmatter.model !== undefined ? a.frontmatter.model : null;
          base['tools'] = a.frontmatter.tools !== undefined ? a.frontmatter.tools : null;
        }
        return base;
      }),
      total: agents.length,
      follow_up: 'Read one with `crtr agent subagent read <name>`; delegate with `crtr agent new --agent <name>`.',
    };
  },
});

const subagentRead = defineLeaf({
  name: 'read',
  help: {
    name: 'agent subagent read',
    summary: 'load a subagent\'s system prompt (markdown body) and metadata',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Subagent identifier: <name> or <plugin>/<name>.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Narrows resolution when the name is ambiguous.' },
      { kind: 'flag', name: 'no-body', type: 'bool', required: false, constraint: 'When present, omits the system prompt body — returns metadata only.' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'Resolved subagent id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Subagent name.' },
      { name: 'plugin', type: 'string', required: true, constraint: 'Plugin the subagent belongs to, or _ for a scope-root agent.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope it resolved from.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the .md file.' },
      { name: 'description', type: 'string', required: true, constraint: 'Frontmatter description.' },
      { name: 'model', type: 'string | null', required: true, constraint: 'Declared model, or null.' },
      { name: 'tools', type: 'string[] | null', required: true, constraint: 'Declared tool allow-list, or null.' },
      { name: 'system_prompt', type: 'string', required: false, constraint: 'Markdown body applied as the appended system prompt. Omitted with --no-body.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = input['name'] as string;
    const scopeStr = input['scope'] as string | undefined;
    const noBody = input['noBody'] === true;
    const resolveOpts: { scope?: Scope } = {};
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') resolveOpts.scope = resolved;
    }
    const sub = resolveSubagent(nameRaw, resolveOpts);
    const out: Record<string, unknown> = {
      id: subagentId(sub),
      name: sub.name,
      plugin: sub.plugin,
      scope: sub.scope,
      path: sub.path,
      description: sub.frontmatter.description !== undefined ? sub.frontmatter.description : '',
      model: sub.frontmatter.model !== undefined ? sub.frontmatter.model : null,
      tools: sub.frontmatter.tools !== undefined ? sub.frontmatter.tools : null,
    };
    if (!noBody) out['system_prompt'] = sub.systemPrompt;
    return out;
  },
});

const SUBAGENT_STUB = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n# model: claude-sonnet-4-5        # optional: model pattern/id passed via --model\n# tools: read, grep, find, ls, bash  # optional (pi): tool allow-list passed via --tools\n---\n\nYou are ${name}. Describe the persona, responsibilities, and output format here.\nThis markdown body is applied as the spawned agent's appended system prompt.\n`;

const subagentScaffold = defineLeaf({
  name: 'scaffold',
  help: {
    name: 'agent subagent scaffold',
    summary: 'create a subagent definition stub (markdown + frontmatter) under <scope>/agents',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Subagent name; also the filename stem (<name>.md).' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Short description written to frontmatter. Required for the subagent to appear in listings.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded .md file.' },
      { name: 'id', type: 'string', required: true, constraint: 'Resolved subagent id.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Next step to edit and use the subagent.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates `<scope-root>/agents/<name>.md` with a frontmatter + body stub.',
      'Fails if the file already exists.',
    ],
  },
  run: async (input) => {
    const name = (input['name'] as string).trim();
    if (name === '' || name.includes('/')) {
      throw usage('subagent name must be a non-empty single segment (no slashes)');
    }
    const description = typeof input['description'] === 'string' ? (input['description'] as string) : '';
    const scopeStr = input['scope'] as string | undefined;

    let scope: Scope;
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved === 'all') throw usage('scope must be user or project, not all');
      scope = resolved;
    } else {
      scope = projectScopeRoot() !== null ? 'project' : 'user';
    }

    const scopeRootPath = requireScopeRoot(scope);
    ensureScopeInitialized(scope, scopeRootPath);
    const dir = scopeAgentsDir(scope);
    if (dir === null) throw general(`no agents dir for scope ${scope}`);
    const filePath = join(dir, `${name}.md`);
    if (pathExists(filePath)) throw general(`subagent already exists: ${filePath}`);
    ensureDir(dir);
    writeFileSync(filePath, SUBAGENT_STUB(name, description), 'utf8');

    return {
      path: filePath,
      id: name,
      follow_up: `Edit ${filePath}, then delegate with \`crtr agent new --agent ${name}\`.`,
    };
  },
});

export const subagentBranch = defineBranch({
  name: 'subagent',
  help: {
    name: 'agent subagent',
    summary: 'define and inspect reusable subagent personas (markdown + frontmatter)',
    model:
      'A subagent is a markdown file with YAML frontmatter (name, description, optional model/tools) whose body becomes a spawned worker\'s appended system prompt — the same model as the pi subagent extension, surfaced through crtr. Files live under `<scope-root>/agents/*.md` (and plugins\' `agents/`). `list` enumerates them, `read` loads one\'s body + metadata, `scaffold` creates a stub. Spawn one with `crtr agent new --agent <name>`.',
    dynamicState: buildSubagentCatalog,
    children: [
      { name: 'list', desc: 'list defined subagents', useWhen: 'discovering which personas are available' },
      { name: 'read', desc: 'load a subagent\'s system prompt + metadata', useWhen: 'inspecting a persona before using or editing it' },
      { name: 'scaffold', desc: 'create a subagent stub under <scope>/agents', useWhen: 'defining a new subagent' },
    ],
  },
  children: [subagentList, subagentRead, subagentScaffold],
});
