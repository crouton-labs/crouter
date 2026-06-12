// `crtr view new <name>` — scaffold a runnable dual-target view into a scope dir.
//
// Writes the four contract files (core.mjs + tui.mjs + web.jsx + text.mjs) under
// <viewsDir(scope)>/<name>/ from the stubs in prompts/view.ts (mkdir -p first).
// Refuses if a view of that name already resolves. The scaffold runs as-is via
// `crtr view run <name>` (TUI) and `crtr view serve <name>` (web). Mirrors how
// skill authoring scaffolds (resolve scope → ensure dir → write → point at run).

import { mkdirSync, existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { usage } from '../core/errors.js';
import { resolveView, findViewDir } from '../core/view/loader.js';
import { viewsDir, projectScopeRoot, ensureProjectScopeRoot } from '../core/scope.js';
import { viewScaffold } from '../prompts/view.js';
import type { Scope } from '../types.js';

export const viewNewLeaf: LeafDef = defineLeaf({
  name: 'new',
  description: 'scaffold a runnable dual-target view directory into a scope dir',
  whenToUse: 'you want to author a new view — this writes the four contract files (core.mjs + tui.mjs + web.jsx + text.mjs, with the contract documented inline) into the user or project scope, ready to open immediately with `crtr view run <name>` (TUI) or `crtr view serve <name>` (web) and to edit from there. Reach for it to start a new view rather than hand-writing the directory',
  help: {
    name: 'view new',
    summary: 'scaffold <viewsDir(scope)>/<name>/{core,tui,text}.mjs + web.jsx from the stubs; refuses if the name already resolves',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'View id / directory name. Must not already resolve as a view.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Where to scaffold. Default: project if available, else user.' },
      { kind: 'flag', name: 'title', type: 'string', required: false, constraint: 'Manifest title (header + picker). Default: the name.' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Manifest description (picker + `view list`). Default: empty.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded view directory.' },
      { name: 'files', type: 'array', required: true, constraint: 'The filenames written into the view directory.' },
      { name: 'scope', type: 'string', required: true, constraint: 'The scope it was written to (user|project).' },
      { name: 'run', type: 'string', required: true, constraint: 'The command to run the new view.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates the view directory and the four contract files (core.mjs + tui.mjs + web.jsx + text.mjs) at the resolved location (mkdir -p).',
      'Initializes the project scope dir if --scope project is chosen and none exists yet.',
    ],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const scopeArg = input['scope'] as string | undefined;
    const title = (input['title'] as string | undefined) ?? name;
    const description = (input['description'] as string | undefined) ?? '';

    // Default scope: project if a project scope exists, else user.
    const scope: Scope = scopeArg === 'project' || scopeArg === 'user'
      ? scopeArg
      : (projectScopeRoot() !== null ? 'project' : 'user');

    // Refuse if a view of this name already resolves (any scope wins).
    const existing = resolveView(name);
    if (existing !== null) {
      throw usage(
        `view already exists: ${name} (${existing.scope}) at ${existing.dir}. ` +
        `Pick another name, or edit it directly.`,
      );
    }

    // Ensure the project scope root exists before computing its views dir.
    if (scope === 'project') ensureProjectScopeRoot();
    const baseDir = viewsDir(scope);
    if (baseDir === null) {
      throw usage(`no ${scope} scope available to scaffold into — try --scope user.`);
    }

    const dir = join(baseDir, name);
    if (findViewDir(name) !== null || existsSync(join(dir, 'core.mjs'))) {
      throw usage(`view directory already exists: ${dir}`);
    }

    mkdirSync(dir, { recursive: true });
    const files = viewScaffold({ id: name, title, description });
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(dir, filename), content, 'utf8');
    }

    return { path: dir, files: Object.keys(files), scope, run: `crtr view run ${name}` };
  },
});
