#!/usr/bin/env node

import { defineRoot, runCli } from './core/command.js';
import { registerAgent } from './commands/agent.js';
import { registerSkill } from './commands/skill.js';
import { registerJob } from './commands/job.js';
import { registerPkg } from './commands/pkg.js';
import { registerHuman } from './commands/human.js';
import { registerSys } from './commands/sys.js';
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
  ],
});

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
