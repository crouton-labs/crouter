// `crtr pkg` subtree: replaces plugin.ts + marketplace.ts for the agent-first CLI.
// Sub-branches: plugin {manage {install,remove,enable,disable,update}, inspect {list,show}}
//               market {manage {add,remove,update,install}, inspect {list,browse}}

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { pluginBranch } from './pkg/plugin.js';
import { marketBranch } from './pkg/market.js';

export function registerPkg(): BranchDef {
  return defineBranch({
    name: 'pkg',
    rootEntry: {
      concept: 'plugins and marketplaces that supply skills',
      desc: 'manage plugins and marketplaces',
      useWhen: 'installing or browsing skill collections',
    },
    help: {
      name: 'pkg',
      summary: 'manage plugins and plugin marketplaces',
      children: [
        { name: 'plugin', desc: 'install and manage plugins', useWhen: 'working with individual plugins directly' },
        { name: 'market', desc: 'manage marketplace sources and install from them', useWhen: 'using curated plugin collections' },
      ],
    },
    children: [pluginBranch, marketBranch],
  });
}
