#!/usr/bin/env node

import { defineRoot, runCli } from './core/command.js';
import { registerAgent } from './commands/agent.js';
import { registerSkill } from './commands/skill.js';
import { registerJob } from './commands/job.js';
import { registerPkg } from './commands/pkg.js';
import { registerHuman } from './commands/human.js';
import { registerSys } from './commands/sys.js';
import { registerPush, registerFeed } from './commands/push.js';
import { registerNode } from './commands/node.js';
import { registerDaemon } from './commands/daemon.js';
import { registerRevive } from './commands/revive.js';
import { registerDashboard } from './commands/dashboard.js';
import { registerAttention } from './commands/attention.js';
import { maybeBootRoot } from './core/runtime/front-door.js';
import { maybeAutoUpdate } from './core/auto-update.js';
import { ensureBootSkill, ensureOfficialMarketplace, ensureProjectScope, ensureSlashCommands } from './core/bootstrap.js';

// Root owns only the tagline and globals. Every subtree's concept line,
// selection rubric, and any dynamic block it contributes to root -h are
// declared on the subtree itself (its rootEntry) and assembled here by
// defineRoot. Add a subtree to this list and it appears at root; nothing about
// it is restated here.
const root = defineRoot({
  tagline: 'crtr: agentic planning runtime.',
  globals: [
    { name: '-h', desc: 'print help for any node — append to any subcommand path' },
  ],
  subtrees: [
    registerAgent(),
    registerSkill(),
    registerPkg(),
    registerJob(),
    registerHuman(),
    registerSys(),
    registerPush(),
    registerFeed(),
    registerNode(),
    registerDaemon(),
    registerRevive(),
    registerDashboard(),
    registerAttention(),
  ],
});

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
