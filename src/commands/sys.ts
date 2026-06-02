// `crtr sys` subtree: config {get,set,path}, doctor, update, version.
// Replaces old config.ts + doctor.ts + update.ts command files.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { configBranch } from './sys/config.js';
import { sysDoctorLeaf } from './sys/doctor.js';
import { sysUpdateLeaf, sysVersionLeaf } from './sys/update.js';

export function registerSys(): BranchDef {
  return defineBranch({
    name: 'sys',
    rootEntry: {
      concept: 'crtr configuration, diagnostics, and self-management',
      desc: 'config, doctor, update, version',
      useWhen: 'managing the crtr installation',
    },
    help: {
      name: 'sys',
      summary: 'crtr system configuration, diagnostics, and self-management',
      children: [
        { name: 'config', desc: 'read and write configuration', useWhen: 'inspecting or changing crtr settings' },
        { name: 'doctor', desc: 'diagnose installation health', useWhen: 'troubleshooting missing manifests or broken config' },
        { name: 'update', desc: 'update binary and content', useWhen: 'upgrading crtr or its installed plugins/marketplaces' },
        { name: 'version', desc: 'print installed version', useWhen: 'checking which version of crtr is installed' },
      ],
    },
    children: [configBranch, sysDoctorLeaf, sysUpdateLeaf, sysVersionLeaf],
  });
}
