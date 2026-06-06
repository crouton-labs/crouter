// MEMORY.md + memory/ — an orchestrator's persistent file-based memory.
//
// One layout, three scopes. Each store is a `memory/` directory of one-fact
// files (each with typed frontmatter and [[wikilinks]]) indexed by a single
// MEMORY.md that holds one pointer line per memory and NEVER any content — the
// architecture in examples/memory-instructions.md. The pointer lines are the
// load-bearing read: a node's <crtr-context> bearings block extracts every
// applicable store's pointer lines each brand-new chat (see canvas-context-intro
// + bearings), so the indexes must stay lean; the detail files load on demand
// mid-session.
//
// The three scopes differ only in WHERE they live and HOW LONG they outlast a
// node — the `type` taxonomy in each memory's frontmatter drives which store a
// fact lands in (the mapping lives in the orchestration kernel's "Your long-term
// memory"). ALL THREE live under the canvas home (crtrHome), all machine-local:
//
//   user-global  <crtrHome>/memory/                    — who the human is, how
//     they like to work; loaded into EVERY orchestrator everywhere.
//   project      <crtrHome>/projects/<key>/memory/      — facts bound to one
//     repo; loaded into orchestrators whose cwd resolves to that project. <key>
//     is the git-repo-root (walked up from the cwd), else the cwd, mangled.
//   node-local   <crtrHome>/nodes/<id>/context/memory/  — facts specific to this
//     node's goal; dies with the node.
//
// An ORCHESTRATOR-only artifact — the resident, multi-cycle nodes that survive
// refreshes and accumulate durable lessons/preferences; terminal workers are
// one-shot and get none. All three stores are seeded the moment a node becomes
// an orchestrator (promotion, or born one — where the roadmap is seeded too),
// guarded so a re-seed never clobbers an evolved memory.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { contextDir, crtrHome } from '../canvas/index.js';
import { mangleCwd } from '../artifact.js';

// ---------------------------------------------------------------------------
// Index template + generic store ops (shared by all three scopes).
// ---------------------------------------------------------------------------

/** Build the seed contents of a fresh MEMORY.md index. Deliberately tiny: the
 *  bearings block only ever extracts the pointer lines, so this prose never
 *  rides into context — it's only for a human/agent opening the file directly,
 *  and the how-to lives once in the orchestrator kernel ("Your long-term
 *  memory"), not here. `holds` is a short scope hint so the empty index still
 *  orients a fresh write. */
function indexTemplate(holds: string): string {
  return (
    '# memory index — one pointer line per memory (`- [Title](slug.md) — hook`); ' +
    `how-to in "Your long-term memory". Holds ${holds}.\n\n(no memories yet)\n`
  );
}

/** The node-local index template. Named export kept for callers/tests that
 *  assert the seeded node store verbatim. */
export const MEMORY_TEMPLATE = indexTemplate('your saved memories');
/** The user-global index template — framed around the human, not a goal. */
export const USER_MEMORY_TEMPLATE = indexTemplate(
  'your saved memories about the human — who they are and how they like to work',
);
/** The project index template — framed around the repo. */
export const PROJECT_MEMORY_TEMPLATE = indexTemplate('your saved memories about this project');

/** The MEMORY.md index path inside a memory `dir`. */
function indexPathOf(dir: string): string {
  return join(dir, 'MEMORY.md');
}

/** Seed `dir` + its MEMORY.md index with `template` IFF the index is absent.
 *  Idempotent and guarded so it never clobbers an evolved memory; creating the
 *  dir up front lets the node write detail files into it directly (no mkdir).
 *  Returns true when it seeded, false when an index already existed. */
function seedStore(dir: string, template: string): boolean {
  const idx = indexPathOf(dir);
  if (existsSync(idx)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(idx, template);
  return true;
}

/** Read a store's MEMORY.md index, or null when it doesn't exist. */
function readStore(dir: string): string | null {
  const idx = indexPathOf(dir);
  return existsSync(idx) ? readFileSync(idx, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// node-local store — <crtrHome>/nodes/<id>/context/memory/ (facts for this goal)
// ---------------------------------------------------------------------------

/** The node-local memory directory in a node's context dir — holds MEMORY.md
 *  (the index) and the one-fact detail files it points at. */
export function memoryDir(nodeId: string): string {
  return join(contextDir(nodeId), 'memory');
}

/** The node-local MEMORY.md index path (inside the memory dir). */
export function memoryPath(nodeId: string): string {
  return indexPathOf(memoryDir(nodeId));
}

/** Whether the node has a node-local memory store. This is ALSO the
 *  orchestrator gate: only orchestrators are ever seeded one, so a node with no
 *  node-local store is a terminal worker (no memory framing at all). */
export function hasMemory(nodeId: string): boolean {
  return existsSync(memoryPath(nodeId));
}

/** Read the node-local MEMORY.md index, or null when it doesn't exist. */
export function readMemory(nodeId: string): string | null {
  return readStore(memoryDir(nodeId));
}

/** Seed the node-local memory dir + index IF the node has none yet. */
export function seedMemory(nodeId: string): boolean {
  return seedStore(memoryDir(nodeId), MEMORY_TEMPLATE);
}

// ---------------------------------------------------------------------------
// user-global store — <crtrHome>/memory/ (who the human is, how they work)
// ---------------------------------------------------------------------------

/** The user-global memory directory — one per machine, key-less, loaded into
 *  every orchestrator everywhere. */
export function userMemoryDir(): string {
  return join(crtrHome(), 'memory');
}

/** The user-global MEMORY.md index path. */
export function userMemoryPath(): string {
  return indexPathOf(userMemoryDir());
}

export function hasUserMemory(): boolean {
  return existsSync(userMemoryPath());
}

/** Read the user-global MEMORY.md index, or null when it doesn't exist. */
export function readUserMemory(): string | null {
  return readStore(userMemoryDir());
}

/** Seed the user-global memory dir + index IF absent. */
export function seedUserMemory(): boolean {
  return seedStore(userMemoryDir(), USER_MEMORY_TEMPLATE);
}

// ---------------------------------------------------------------------------
// project store — <crtrHome>/projects/<key>/memory/ (facts bound to one repo)
// ---------------------------------------------------------------------------

/** The git repo root containing `cwd` — walk up for a `.git` entry — or null
 *  when `cwd` is not inside a repo. `.git` may be a dir (normal) or a file
 *  (worktree/submodule); existsSync catches both. */
function gitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

/** The project key for `cwd`: its git-repo-root when inside a repo, else the
 *  cwd itself, mangled into a flat directory name (reuses artifact mangleCwd).
 *  This keys the per-project memory store under <crtrHome>/projects/. */
export function projectKey(cwd: string): string {
  return mangleCwd(gitRoot(cwd) ?? cwd);
}

/** The project memory directory for `cwd`. */
export function projectMemoryDir(cwd: string): string {
  return join(crtrHome(), 'projects', projectKey(cwd), 'memory');
}

/** The project MEMORY.md index path for `cwd`. */
export function projectMemoryPath(cwd: string): string {
  return indexPathOf(projectMemoryDir(cwd));
}

export function hasProjectMemory(cwd: string): boolean {
  return existsSync(projectMemoryPath(cwd));
}

/** Read the project MEMORY.md index for `cwd`, or null when it doesn't exist. */
export function readProjectMemory(cwd: string): string | null {
  return readStore(projectMemoryDir(cwd));
}

/** Seed the project memory dir + index for `cwd` IF absent. */
export function seedProjectMemory(cwd: string): boolean {
  return seedStore(projectMemoryDir(cwd), PROJECT_MEMORY_TEMPLATE);
}
