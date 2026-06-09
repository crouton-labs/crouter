// memory/ — durable per-scope document stores for substrate docs.
//
// Three scopes, each a `memory/` directory of substrate documents (.md files
// with typed frontmatter — kind, when, why, system-prompt-visibility, gate).
// The old MEMORY.md index files and pointer-line seeding are removed; the
// inventory is now computed by `crtr memory list` from frontmatter.
//
// Scopes:
//   user-global  <crtrHome>/memory/                    — who the human is, how
//     they like to work; loaded into every orchestrator everywhere.
//   project      <crtrHome>/projects/<key>/memory/      — facts bound to one
//     repo; loaded into orchestrators whose cwd resolves to that project. <key>
//     is the git-repo-root (walked up from the cwd), else the cwd, mangled.
//   node-local   <crtrHome>/nodes/<id>/context/memory/  — substrate docs specific
//     to this node's goal; dies with the node.

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { contextDir, crtrHome } from '../canvas/index.js';
import { mangleCwd } from '../artifact.js';

// ---------------------------------------------------------------------------
// node-local store — <crtrHome>/nodes/<id>/context/memory/
// ---------------------------------------------------------------------------

/** The node-local memory directory in a node's context dir — holds substrate
 *  docs (.md files with kind/when/why frontmatter). */
export function memoryDir(nodeId: string): string {
  return join(contextDir(nodeId), 'memory');
}

// ---------------------------------------------------------------------------
// user-global store — <crtrHome>/memory/
// ---------------------------------------------------------------------------

/** The user-global memory directory — one per machine, key-less, loaded into
 *  every orchestrator everywhere. */
export function userMemoryDir(): string {
  return join(crtrHome(), 'memory');
}

// ---------------------------------------------------------------------------
// project store — <crtrHome>/projects/<key>/memory/
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
