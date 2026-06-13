import { defineRoot } from './core/command.js';
import type { RootDef, BranchDef } from './core/command.js';

const TAGLINE = 'crtr: agentic planning runtime.';

/** Lazy registry: subtree name → dynamic importer that builds its BranchDef.
 *  The whole point is that each `import()` only compiles that one subtree's
 *  module graph. The hot path (`crtr node focus …`, `crtr feed`, …) dispatches
 *  into a single leaf, so it must load ONE subtree — not the attach-TUI
 *  (babel/highlight.js), the web/vite command, and every other subtree it never
 *  touches. `crtr` cold-start is dominated by Node module loading; keeping the
 *  other 11 subtrees off the path is the biggest, lowest-risk win.
 *
 *  Naming note: `push` and `feed` are two subtrees from one module — importing
 *  it once yields both registers. */
const SUBTREE_LOADERS: Record<string, () => Promise<BranchDef>> = {
  memory: async () => (await import('./commands/memory.js')).registerMemory(),
  pkg: async () => (await import('./commands/pkg.js')).registerPkg(),
  human: async () => (await import('./commands/human.js')).registerHuman(),
  sys: async () => (await import('./commands/sys.js')).registerSys(),
  node: async () => (await import('./commands/node.js')).registerNode(),
  push: async () => (await import('./commands/push.js')).registerPush(),
  feed: async () => (await import('./commands/push.js')).registerFeed(),
  canvas: async () => (await import('./commands/canvas.js')).registerCanvas(),
  view: async () => (await import('./commands/view.js')).registerView(),
  attach: async () => (await import('./clients/attach/attach-cmd.js')).registerAttach(),
  workspace: async () => (await import('./commands/workspace.js')).registerWorkspace(),
  web: async () => (await import('./clients/web/web-cmd.js')).registerWeb(),
};

/** Every shipped subtree name. Cheap (no module loading) — the front-door
 *  recursion guard and the dispatcher's first-token routing need only names. */
export const SUBTREE_NAMES: string[] = Object.keys(SUBTREE_LOADERS);

/** Build a root that contains only the subtree `first` dispatches into.
 *  Returns the FULL root when `first` is not a recognized subtree — bare `crtr`,
 *  `-h`/`--help`, `--version`, and any unknown leading token all need the
 *  complete tree (root -h lists every subtree; the unknown-path error names
 *  every valid child). This keeps every help/error surface byte-identical while
 *  the common leaf-dispatch path loads exactly one subtree. */
export async function resolveRoot(first: string | undefined): Promise<RootDef> {
  const loader = first !== undefined ? SUBTREE_LOADERS[first] : undefined;
  if (loader !== undefined) {
    return defineRoot({ tagline: TAGLINE, globals: [], subtrees: [await loader()] });
  }
  return buildRoot();
}

/** Assemble the full crtr command tree (all subtrees). Used for root -h, the
 *  unknown-path error, bare-root boot, and the listing-completeness test. Root
 *  owns only the tagline; every subtree declares its own root representation via
 *  its rootEntry. */
export async function buildRoot(): Promise<RootDef> {
  const subtrees = await Promise.all(SUBTREE_NAMES.map((n) => SUBTREE_LOADERS[n]()));
  return defineRoot({ tagline: TAGLINE, globals: [], subtrees });
}
