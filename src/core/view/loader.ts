// loader.ts — resolve + load dual-target (core.mjs) views across scopes.
//
// A view = a directory containing `core.mjs` (the portable core). Up to three
// presenter files sit beside it: `tui.mjs` (Node), `web.jsx`/`web.tsx` (browser,
// via Vite — NEVER Node-imported), `text.mjs` (Node, piped path). Targets are
// derived from which presenter files exist — no manifest field.
//
// Resolution order: project → user → builtin, first hit wins (scope.ts
// viewsDir). Node-side loads are plain `import(pathToFileURL())` — no
// transpile, no bundle.
//
// Legacy single-file `view.mjs` modules are handled by src/core/tui/loader.ts;
// commands try this loader first and fall back (temporary dual-load until the
// builtins are migrated and the old contract is deleted).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Scope } from '../../types.js';
import { viewsDir } from '../scope.js';
import { InputError } from '../io.js';
import type { ViewCore, TuiPresenter, TextPresenter } from './contract.js';

export interface ResolvedView {
  id: string;
  dir: string;
  scope: 'project' | 'user' | 'builtin';
  core: string;          // <dir>/core.mjs (required)
  tui: string | null;    // <dir>/tui.mjs
  web: string | null;    // <dir>/web.jsx (or web.tsx)
  text: string | null;   // <dir>/text.mjs
}

const SCOPE_ORDER: Array<Extract<Scope, 'project' | 'user' | 'builtin'>> = ['project', 'user', 'builtin'];

function probe(dir: string, scope: ResolvedView['scope'], id: string): ResolvedView | null {
  const core = join(dir, 'core.mjs');
  if (!existsSync(core)) return null;
  const tui = join(dir, 'tui.mjs');
  const webJsx = join(dir, 'web.jsx');
  const webTsx = join(dir, 'web.tsx');
  const text = join(dir, 'text.mjs');
  return {
    id, dir, scope, core,
    tui: existsSync(tui) ? tui : null,
    web: existsSync(webJsx) ? webJsx : existsSync(webTsx) ? webTsx : null,
    text: existsSync(text) ? text : null,
  };
}

/** Scope search project→user→builtin; first hit wins. null if no scope holds a
 *  `<name>/core.mjs`. */
export function resolveView(name: string): ResolvedView | null {
  for (const scope of SCOPE_ORDER) {
    const root = viewsDir(scope);
    if (!root) continue;
    const r = probe(join(root, name), scope, name);
    if (r) return r;
  }
  return null;
}

/** Enumerate every resolvable core-shaped view across scopes (first scope wins
 *  per id). Targets per view are derivable from the tui/web/text fields. */
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
      const r = probe(dir, scope, name);
      if (!r) continue;
      seen.add(name);
      out.push(r);
    }
  }
  return out;
}

/** Import + validate the portable core. Throws a guided error if malformed. */
export async function loadCore(r: ResolvedView): Promise<ViewCore> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(r.core).href)) as Record<string, unknown>;
  } catch (e) {
    throw guided(r, 'core.mjs', `failed to import: ${errText(e)}`);
  }
  const c = mod['default'] as Partial<ViewCore> | undefined;
  if (!c || typeof c !== 'object') throw guided(r, 'core.mjs', 'no default export that is a ViewCore object');
  const m = c.manifest;
  if (!m || typeof m.id !== 'string' || typeof m.title !== 'string') {
    throw guided(r, 'core.mjs', 'manifest.id and manifest.title must be strings');
  }
  if (typeof c.init !== 'function') throw guided(r, 'core.mjs', 'init() is required');
  if (!c.intents || typeof c.intents !== 'object') throw guided(r, 'core.mjs', 'intents must be an object of intent functions');
  return c as ViewCore;
}

/** Import + validate the TUI presenter. Call requireTui first. */
export async function loadTui(r: ResolvedView): Promise<TuiPresenter> {
  if (!r.tui) throw notTarget(r, 'tui');
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(r.tui).href)) as Record<string, unknown>;
  } catch (e) {
    throw guided(r, 'tui.mjs', `failed to import: ${errText(e)}`);
  }
  // Accept named exports { render, keymap } or a default-exported object.
  const candidate = (typeof mod['render'] === 'function' ? mod : mod['default']) as Partial<TuiPresenter> | undefined;
  if (!candidate || typeof candidate.render !== 'function') throw guided(r, 'tui.mjs', 'render(state, draw, content) is required');
  if (!Array.isArray(candidate.keymap)) throw guided(r, 'tui.mjs', 'keymap must be an array of key bindings');
  return candidate as TuiPresenter;
}

/** Import the text presenter if present; null otherwise (the host synthesizes a
 *  generic one-line dump when a view ships no text.mjs). */
export async function loadText(r: ResolvedView): Promise<TextPresenter | null> {
  if (!r.text) return null;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(r.text).href)) as Record<string, unknown>;
  } catch (e) {
    throw guided(r, 'text.mjs', `failed to import: ${errText(e)}`);
  }
  const candidate = (typeof mod['dump'] === 'function' ? mod : mod['default']) as Partial<TextPresenter> | undefined;
  if (!candidate || typeof candidate.dump !== 'function') throw guided(r, 'text.mjs', 'dump(state, ctx) is required');
  return candidate as TextPresenter;
}

/** Per-host presenter validation: `view run` requires a TUI presenter. */
export function requireTui(r: ResolvedView): void {
  if (!r.tui) {
    throw new InputError({
      error: 'view_web_only',
      message: `'${r.id}' is web-only — it ships no tui.mjs presenter`,
      next: `Run \`crtr view serve ${r.id}\` to open it in the browser.`,
    });
  }
}

/** Per-host presenter validation: `view serve` requires a web presenter. */
export function requireWeb(r: ResolvedView): void {
  if (!r.web) {
    throw new InputError({
      error: 'view_tui_only',
      message: `'${r.id}' is tui-only — it ships no web.jsx presenter`,
      next: `Run \`crtr view run ${r.id}\` to open it in a tmux pane.`,
    });
  }
}

function notTarget(r: ResolvedView, target: string): Error {
  return new Error(`view "${r.id}" has no ${target} presenter`);
}

function guided(r: ResolvedView, file: string, problem: string): Error {
  return new Error(
    `invalid view "${r.id}" (${r.scope}) at ${join(r.dir, file)}: ${problem}.\n` +
    'A dual-target view dir holds core.mjs (default export: { manifest: { id, title }, init(), intents }) ' +
    'plus optional tui.mjs (render + keymap), web.jsx, text.mjs (dump).',
  );
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
