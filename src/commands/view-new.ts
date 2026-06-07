// `crtr view new <name>` — scaffold a runnable view.mjs into a scope dir.
//
// Writes <viewsDir(scope)>/<name>/view.mjs from the stub in prompts/view.ts
// (mkdir -p first). Refuses if a view of that name already resolves. The
// scaffolded view runs as-is via `crtr view run <name>`. Mirrors how skill
// authoring scaffolds (resolve scope → ensure dir → write → point at how to run).

import { mkdirSync, existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { usage } from '../core/errors.js';
import { resolveView } from '../core/tui/loader.js';
import { viewsDir, projectScopeRoot, ensureProjectScopeRoot } from '../core/scope.js';
import { viewScaffold } from '../prompts/view.js';
import type { Scope } from '../types.js';

export const viewNewLeaf: LeafDef = defineLeaf({
  name: 'new',
  description: 'scaffold a runnable view.mjs stub into a scope dir',
  whenToUse: 'you want to author a new view — this writes a minimal, runnable view.mjs (with the contract + draw/host API documented inline) into the user or project scope, ready to open immediately with `crtr view run <name>` and to edit from there. Reach for it to start a new TUI surface rather than hand-writing the module',
  help: {
    name: 'view new',
    summary: 'scaffold <viewsDir(scope)>/<name>/view.mjs from the stub; refuses if the name already resolves',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'View id / directory name. Must not already resolve as a view.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Where to scaffold. Default: project if available, else user.' },
      { kind: 'flag', name: 'title', type: 'string', required: false, constraint: 'Manifest title (header + picker). Default: the name.' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Manifest description (picker + `view list`). Default: empty.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded view.mjs.' },
      { name: 'scope', type: 'string', required: true, constraint: 'The scope it was written to (user|project).' },
      { name: 'run', type: 'string', required: true, constraint: 'The command to run the new view.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates the view directory and view.mjs stub at the resolved location (mkdir -p).',
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
        `view already exists: ${name} (${existing.scope}) at ${existing.entry}. ` +
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
    const entry = join(dir, 'view.mjs');
    if (existsSync(entry)) {
      throw usage(`view file already exists: ${entry}`);
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(entry, viewScaffold({ id: name, title, description }), 'utf8');

    return { path: entry, scope, run: `crtr view run ${name}` };
  },
});
