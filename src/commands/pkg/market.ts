import { defineBranch } from '../../core/command.js';
import { marketManageBranch } from './market-manage.js';
import { marketInspectBranch } from './market-inspect.js';

export const marketBranch = defineBranch({
  name: 'market',
  help: {
    name: 'pkg market',
    summary: 'manage and browse plugin marketplaces',
    model: 'Marketplaces are git repos containing a .crouter-marketplace/marketplace.json index of plugins.',
    children: [
      { name: 'manage', desc: 'add, remove, update, install', useWhen: 'changing marketplace or marketplace-sourced plugin state' },
      { name: 'inspect', desc: 'list or browse marketplaces', useWhen: 'reading marketplace metadata' },
    ],
  },
  children: [marketManageBranch, marketInspectBranch],
});
