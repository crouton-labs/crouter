#!/usr/bin/env node

import { defineRoot, runCli } from './core/command.js';
import { registerAgent } from './commands/agent.js';
import { registerSkill } from './commands/skill.js';
import { registerPkg } from './commands/pkg.js';
import { registerJob } from './commands/job.js';
import { registerHuman } from './commands/human.js';
import { registerSys } from './commands/sys.js';
import { maybeAutoUpdate } from './core/auto-update.js';
import { ensureBootSkill, ensureOfficialMarketplace, ensureProjectScope } from './core/bootstrap.js';

const root = defineRoot({
  help: {
    tagline: 'crtr: agentic planning runtime.',
    concepts: [
      { name: 'agent', desc: 'agentic workflows: spec → plan → debug, and spawning workers' },
      { name: 'skill', desc: 'loadable SKILL.md document an agent reads to adopt a workflow' },
      { name: 'pkg',   desc: 'plugins and marketplaces that supply skills' },
      { name: 'job',   desc: 'producer-agnostic record of any ongoing task — its logs and result' },
      { name: 'human', desc: 'human-in-the-loop decisions, document review, and live display' },
      { name: 'sys',   desc: 'crtr configuration, diagnostics, and self-management' },
    ],
    subtrees: [
      { name: 'agent', desc: 'spec/plan/debug and spawn workers',          useWhen: 'capturing requirements, planning, debugging, or launching an agent worker' },
      { name: 'skill', desc: 'discover, read, author, and manage skills',  useWhen: 'working with SKILL.md documents' },
      { name: 'pkg',   desc: 'manage plugins and marketplaces',            useWhen: 'installing or browsing skill collections' },
      { name: 'job',   desc: 'monitor and collect from any ongoing task',  useWhen: 'reading status, logs, or result of a job started by any producer' },
      { name: 'human', desc: 'ask, approve, review, notify, show, inbox, list', useWhen: 'putting a decision or document in front of a person' },
      { name: 'sys',   desc: 'config, doctor, update, version',            useWhen: 'managing the crtr installation' },
    ],
    globals: [
      { name: '-h', desc: 'print help for any node — append to any subcommand path' },
    ],
  },
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
ensureProjectScope(process.argv);
maybeAutoUpdate(process.argv);

runCli(root, process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crtr: ${msg}\n`);
  process.exit(1);
});
