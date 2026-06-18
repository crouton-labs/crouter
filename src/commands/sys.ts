// `crtr sys` subtree: config {get,set,path}, doctor, sync, update, version.
// Replaces old config.ts + doctor.ts + update.ts command files.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { configBranch } from './sys/config.js';
import { sysDoctorLeaf } from './sys/doctor.js';
import { sysFeedbackLeaf } from './sys/feedback.js';
import { sysSettingsLeaf } from './sys/settings.js';
import { sysSyspromptLeaf } from './sys/sysprompt.js';
import { promptReviewLeaf } from './sys/prompt-review.js';
import { sysPromptStudioLeaf } from './sys/promptstudio.js';
import { sysSyncLeaf } from './sys/sync.js';
import { sysUpdateLeaf, sysVersionLeaf } from './sys/update.js';

export function registerSys(): BranchDef {
  return defineBranch({
    name: 'sys',
    rootEntry: {
      concept: 'crtr configuration, diagnostics, and self-management',
      desc: 'config, settings, doctor, sysprompt, prompt-review, promptstudio, sync, update, version, feedback',
      useWhen: 'managing the crtr installation or opening built-in system views',
    },
    help: {
      name: 'sys',
      summary: 'crtr system configuration, settings, diagnostics, and self-management',
    },
    children: [configBranch, sysSettingsLeaf, sysDoctorLeaf, sysSyspromptLeaf, promptReviewLeaf, sysPromptStudioLeaf, sysFeedbackLeaf, sysUpdateLeaf, sysVersionLeaf, sysSyncLeaf],
  });
}
