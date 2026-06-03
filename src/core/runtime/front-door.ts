// The front door — bare `crtr` boots a resident root node.
//
//   crtr                         → boot a root in this terminal (no prompt)
//   crtr [dir]                   → root pinned to dir
//   crtr [dir] ["prompt"]        → root with a starter prompt
//   crtr --name NAME ...         → named root
//   crtr <subcommand> ...        → falls through to the normal dispatcher
//   crtr -h | --help             → root help (dispatcher)
//
// This is the only place that distinguishes "I want to live here" (root) from
// the subcommand surface. It runs before the dispatcher; if it boots, pi takes
// over the terminal and the process never returns.

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { RootDef } from './../command.js';
import { bootRoot } from './spawn.js';

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parse `[dir] [prompt]` positionals + `--name`/`--kind` flags out of the
 *  leftover tokens after the bare `crtr`. */
function parseRootArgs(tokens: string[]): {
  cwd: string;
  prompt?: string;
  name?: string;
  kind?: string;
} {
  let cwd = process.cwd();
  let name: string | undefined;
  let kind: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--name') {
      name = tokens[++i];
    } else if (t === '--kind') {
      kind = tokens[++i];
    } else if (t.startsWith('--')) {
      // ignore unknown flags for the front door
    } else {
      positionals.push(t);
    }
  }

  // First positional that is an existing dir → cwd; the rest → prompt.
  if (positionals.length > 0 && isDir(resolvePath(positionals[0]))) {
    cwd = resolvePath(positionals.shift() as string);
  }
  const prompt = positionals.length > 0 ? positionals.join(' ') : undefined;
  return { cwd, prompt, name, kind };
}

/** If this invocation is a front-door (root) launch, boot it and never return.
 *  Returns false when it's a recognized subcommand / help (let the dispatcher
 *  handle it). */
export function maybeBootRoot(root: RootDef, argv: string[]): boolean {
  const tokens = argv.slice(2);
  const first = tokens[0];

  // `crtr -h` / `crtr --help` / `crtr --version` → dispatcher (root help).
  if (first === '-h' || first === '--help' || first === '--version' || first === '-v') {
    return false;
  }
  // A recognized subcommand → dispatcher.
  const subtreeNames = new Set(root.subtrees.map((s) => s.name));
  if (first !== undefined && subtreeNames.has(first)) return false;

  // Otherwise: bare `crtr` or `crtr [dir] [prompt]` → boot a resident root
  // inline (exec pi in this terminal). Does not return.
  const args = parseRootArgs(tokens);
  bootRoot({ ...args, placement: 'inline' });
  return true;
}
