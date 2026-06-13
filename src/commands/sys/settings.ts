import { defineLeaf } from '../../core/command.js';
import type { LeafDef } from '../../core/command.js';
import { viewRunLeaf } from '../view-run.js';

export const sysSettingsLeaf: LeafDef = defineLeaf({
  name: 'settings',
  description: 'open the model ladders settings view',
  whenToUse: 'you want to open the built-in model ladders settings view in tmux — the same interactive surface as `crtr view run settings`. Use this from `crtr sys` when you want the settings opener beside the rest of system config.',
  help: {
    name: 'sys settings',
    summary: 'open the built-in model ladders settings view',
    inputNote: 'No input parameters.',
    output: [],
    outputKind: 'object',
    effects: ['Hosts the built-in `settings` view via `crtr view run settings`, preserving the same tmux and non-TTY behavior.'],
  },
  run: async () => viewRunLeaf.run({ name: 'settings' }),
});
