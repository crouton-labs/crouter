import { defineBranch } from '../../core/command.js';
import { pluginManageBranch } from './plugin-manage.js';
import { pluginInspectBranch } from './plugin-inspect.js';

export const pluginBranch = defineBranch({
  name: 'plugin',
  description: 'install and manage plugins',
  whenToUse: 'working with individual plugins directly — installing one from a git URL, inspecting or showing what a plugin provides, or enabling, disabling, removing, and updating an installed plugin. Use `pkg market` instead when you want a curated collection: browsing a marketplace index and installing plugins by name from it rather than handling raw git URLs yourself',
  help: {
    name: 'pkg plugin',
    summary: 'install and manage plugins that extend crtr with skills',
    model: 'Plugins are git repos or local directories containing a .crouter-plugin/plugin.json manifest and a skills/ directory.',
  },
  children: [pluginManageBranch, pluginInspectBranch],
});
