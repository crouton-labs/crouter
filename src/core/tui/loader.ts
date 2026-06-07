// loader.ts — resolve + dynamically import view modules across scopes.
//
// A view = a directory containing `view.mjs` (the entry). Resolution order in
// resolveView, first hit wins: project → user → builtin (see scope.ts viewsDir).
// loadView does a plain `import(pathToFileURL(entry).href)` — no transpile, no
// bundle (the published binary is `node dist/cli.js` with no esbuild/tsx) — then
// validates the module is a usable ViewModule, throwing a guided error if not.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Scope } from '../../types.js';
import { viewsDir } from '../scope.js';
import type { ViewModule } from './contract.js';

export interface ResolvedView {
  id: string;
  dir: string;
  entry: string;
  scope: 'project' | 'user' | 'builtin';
}

const SCOPE_ORDER: Array<Extract<Scope, 'project' | 'user' | 'builtin'>> = ['project', 'user', 'builtin'];

/** Scope search project→user→builtin; first hit wins. null if no view dir holds
 *  a `<name>/view.mjs`. */
export function resolveView(name: string): ResolvedView | null {
  for (const scope of SCOPE_ORDER) {
    const root = viewsDir(scope);
    if (!root) continue;
    const dir = join(root, name);
    const entry = join(dir, 'view.mjs');
    if (existsSync(entry)) return { id: name, dir, entry, scope };
  }
  return null;
}

/** Enumerate every resolvable view across scopes (first scope wins per id) —
 *  backs `view list` / `view pick`. */
export function listViews(): ResolvedView[] {
  const seen = new Set<string>();
  const out: ResolvedView[] = [];
  for (const scope of SCOPE_ORDER) {
    const root = viewsDir(scope);
    if (!root || !existsSync(root)) continue;
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names.sort()) {
      if (seen.has(name)) continue; // first scope wins
      const dir = join(root, name);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      const entry = join(dir, 'view.mjs');
      if (!existsSync(entry)) continue;
      seen.add(name);
      out.push({ id: name, dir, entry, scope });
    }
  }
  return out;
}

/** Dynamic-import a resolved view and validate it's a usable ViewModule. Throws
 *  a guided error (with the entry path) if the module is malformed. */
export async function loadView(r: ResolvedView): Promise<ViewModule> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(r.entry).href)) as Record<string, unknown>;
  } catch (e) {
    throw guided(r, `failed to import the module: ${e instanceof Error ? e.message : String(e)}`);
  }
  const candidate = (mod['default'] ?? mod['view']) as Partial<ViewModule> | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw guided(r, 'no default export (or named `view`) that is a ViewModule object');
  }
  const m = candidate.manifest;
  if (!m || typeof m.id !== 'string' || typeof m.title !== 'string') {
    throw guided(r, 'manifest.id and manifest.title must be strings');
  }
  if (typeof candidate.init !== 'function') throw guided(r, 'init() is required');
  if (typeof candidate.render !== 'function') throw guided(r, 'render() is required');
  if (typeof candidate.dump !== 'function') throw guided(r, 'dump() is required');
  return candidate as ViewModule;
}

function guided(r: ResolvedView, problem: string): Error {
  return new Error(
    `invalid view "${r.id}" (${r.scope}) at ${r.entry}: ${problem}.\n` +
    'A view.mjs must `export default` a ViewModule with { manifest: { id, title }, init(), render(), dump() }.',
  );
}
