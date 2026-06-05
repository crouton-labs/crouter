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

/** Env marker set on every pi the front door boots. Its presence means we are
 *  already inside a front-door-booted root, so a nested front-door launch must
 *  be refused — otherwise a removed/renamed subcommand that a child pi re-runs
 *  (e.g. `crtr node -h`) fork-bombs pi until the machine must be rebooted. */
export const FRONT_DOOR_ENV = 'CRTR_FRONT_DOOR';

/** If this invocation is a front-door (root) launch, boot it and never return.
 *  Returns false when it's a recognized subcommand / help / unknown token (let
 *  the dispatcher handle it — for unknown tokens it errors cleanly). */
export function maybeBootRoot(root: RootDef, argv: string[]): boolean {
  const tokens = argv.slice(2);
  const first = tokens[0];

  // Recursion guard: never boot a root from inside a front-door-booted pi.
  // This is the hard backstop against fork bombs — even a future footgun where
  // a child re-invokes a removed subcommand cannot loop, because the second
  // boot is refused and falls through to the dispatcher.
  if (process.env[FRONT_DOOR_ENV]) return false;

  // `crtr -h` / `crtr --help` / `crtr --version` → dispatcher (root help).
  if (first === '-h' || first === '--help' || first === '--version' || first === '-v') {
    return false;
  }
  // A recognized subcommand → dispatcher.
  const subtreeNames = new Set(root.subtrees.map((s) => s.name));
  if (first !== undefined && subtreeNames.has(first)) return false;

  // The front door boots pi ONLY on an unambiguous "live here" signal:
  //   • bare `crtr`                  (no tokens)
  //   • `crtr <dir> [prompt]`        (first positional is an existing dir)
  //   • `crtr "multi word prompt"`   (first token contains whitespace)
  // Anything else — a bare word like `job`, or a leading flag — is treated as a
  // mistyped/removed subcommand and handed to the dispatcher, which errors with
  // "unknown subcommand: <token>". Booting pi for such tokens is what let the
  // renamed `agent`/`job` subcommands fork-bomb the front door.
  if (first !== undefined) {
    const looksLikePrompt = /\s/.test(first);
    const looksLikeDir = !first.startsWith('-') && isDir(resolvePath(first));
    if (!looksLikePrompt && !looksLikeDir) return false;
  }

  // Unambiguous front-door launch → boot a resident root inline (exec pi in
  // this terminal). Does not return.
  const args = parseRootArgs(tokens);
  bootRoot({ ...args });
  return true;
}
