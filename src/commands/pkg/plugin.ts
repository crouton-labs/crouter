import { defineBranch } from '../../core/command.js';
import { pluginManageBranch } from './plugin-manage.js';
import { pluginInspectBranch } from './plugin-inspect.js';

export const pluginBranch = defineBranch({
  name: 'plugin',
  help: {
    name: 'pkg plugin',
    summary: 'install and manage plugins that extend crtr with skills',
    model: 'Plugins are git repos or local directories containing a .crouter-plugin/plugin.json manifest and a skills/ directory.',
    children: [
      { name: 'manage', desc: 'install, remove, enable, disable, update', useWhen: 'changing plugin state' },
      { name: 'inspect', desc: 'list or show installed plugins', useWhen: 'reading plugin metadata' },
    ],
  },
  children: [pluginManageBranch, pluginInspectBranch],
});
