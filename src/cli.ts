#!/usr/bin/env node

import { runCli } from './core/command.js';
import { buildRoot } from './build-root.js';
import { maybeBootRoot } from './core/runtime/front-door.js';
import { maybeAutoUpdate } from './core/auto-update.js';
import { ensureBootSkill, ensureOfficialMarketplace, ensureProjectScope, ensureSlashCommands } from './core/bootstrap.js';

// The full command tree is assembled in build-root.ts (shared with the
// listing-completeness test). Root owns only the tagline; every subtree
// declares its own representation.
const root = buildRoot();

// The front door: bare `crtr` (or `crtr [dir] ["prompt"]`) boots a resident
// root node and execs pi in this terminal. Recognized subcommands fall through
// to the normal dispatcher. Must run before anything that assumes a subcommand.
if (maybeBootRoot(root, process.argv)) {
  // bootRoot exec'd pi inline and exited; unreachable.
}

ensureOfficialMarketplace(process.argv);
ensureBootSkill(process.argv);
ensureSlashCommands(root, process.argv);
ensureProjectScope(process.argv);
maybeAutoUpdate(process.argv);

runCli(root, process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crtr: ${msg}\n`);
  process.exit(1);
});
