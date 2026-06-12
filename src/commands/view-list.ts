// `crtr view list` — enumerate every resolvable view across scopes.
//
// Lists id · title · description · scope. Loads each view's core.mjs to read its
// manifest title/description; a malformed view is shown with an error marker (it
// never crashes the listing). Plain text — pipeable as-is. The raw array is
// available behind --json for tooling.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { listViews, loadCore } from '../core/view/loader.js';

interface ViewRow {
  id: string;
  title: string;
  description: string;
  scope: string;
  error?: string;
}

export const viewListLeaf: LeafDef = defineLeaf({
  name: 'list',
  description: 'enumerate available views (id · title · description · scope)',
  whenToUse: 'you want to see which views exist before running one — a flat roster across project, user, and builtin scopes. Pipeable plain text; pass --json for the raw array. Use `crtr view run <id>` to open one, `crtr view new <name>` to scaffold one',
  help: {
    name: 'view list',
    summary: 'list every resolvable view (id, title, description, scope); pipeable plain text',
    inputNote: 'No input parameters.',
    output: [
      { name: 'views', type: 'array', required: true, constraint: 'One entry per view: { id, title, description, scope, error? }.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const rows: ViewRow[] = [];
    for (const r of listViews()) {
      try {
        const core = await loadCore(r);
        rows.push({
          id: r.id,
          title: core.manifest.title,
          description: core.manifest.description ?? '',
          scope: r.scope,
        });
      } catch (e) {
        // Tolerate a malformed view — show it with an error marker, don't crash.
        rows.push({
          id: r.id,
          title: '(failed to load)',
          description: '',
          scope: r.scope,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { views: rows };
  },
  render: (result) => {
    const rows = (result['views'] as ViewRow[] | undefined) ?? [];
    if (rows.length === 0) {
      return 'No views found. Scaffold one with `crtr view new <name>`.';
    }
    const idW = Math.max(...rows.map((r) => r.id.length), 2);
    const titleW = Math.max(...rows.map((r) => r.title.length), 5);
    const lines = rows.map((r) => {
      const id = r.id.padEnd(idW);
      const title = r.title.padEnd(titleW);
      if (r.error !== undefined) {
        return `${id}  ${title}  [${r.scope}]  ⚠ ${r.error}`;
      }
      const desc = r.description !== '' ? `  ${r.description}` : '';
      return `${id}  ${title}  [${r.scope}]${desc}`;
    });
    return lines.join('\n');
  },
});
