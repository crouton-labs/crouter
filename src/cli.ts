#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerSkillCommands } from './commands/skill.js';
import { registerPluginCommands } from './commands/plugin.js';
import { registerMarketplaceCommands } from './commands/marketplace.js';
import { registerConfigCommands } from './commands/config.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerSpecCommand } from './commands/spec.js';
import { registerSubmitCommand } from './commands/submit.js';
import { registerHandoffCommand } from './commands/handoff.js';
import { maybeAutoUpdate } from './core/auto-update.js';
import { ensureBootSkill, ensureOfficialMarketplace } from './core/bootstrap.js';

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (typeof pkg.version === 'string') return pkg.version;
  return '0.0.0';
}

const program = new Command();

program
  .name('crtr')
  .description('crtr — fast access to skills, plugins, and marketplaces')
  .version(readPackageVersion(), '-v, --version');

registerSkillCommands(program);
registerPluginCommands(program);
registerMarketplaceCommands(program);
registerConfigCommands(program);
registerUpdateCommand(program);
registerDoctorCommand(program);
registerPlanCommand(program);
registerSpecCommand(program);
registerSubmitCommand(program);
registerHandoffCommand(program);

ensureOfficialMarketplace(process.argv);
ensureBootSkill(process.argv);
maybeAutoUpdate(process.argv);

program.parseAsync().catch((err) => {
  process.stderr.write(`crtr: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
