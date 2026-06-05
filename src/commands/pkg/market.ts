import { defineBranch } from '../../core/command.js';
import { marketManageBranch } from './market-manage.js';
import { marketInspectBranch } from './market-inspect.js';

export const marketBranch = defineBranch({
  name: 'market',
  description: 'manage marketplace sources and install from them',
  whenToUse: 'using curated plugin collections instead of raw git URLs — register a marketplace, browse its index of plugins, then install them by name. Use `pkg plugin` instead when you already have a specific git URL or local plugin to install directly, or when inspecting and toggling plugins that are already installed',
  help: {
    name: 'pkg market',
    summary: 'manage and browse plugin marketplaces',
    model: 'Marketplaces are git repos containing a .crouter-marketplace/marketplace.json index of plugins.',
  },
  children: [marketManageBranch, marketInspectBranch],
});
