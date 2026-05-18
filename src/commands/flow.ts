// `crtr flow` umbrella — groups the spec → plan → debug development process.
// registerSpec/registerPlan are unchanged (each still defineBranch{name}); they
// nest under `flow` here instead of registering at root. registerDebug is a
// leaf — `crtr flow debug` spawns directly and `-h` prints FLOW_DEBUG_GUIDE.
import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { registerSpec } from './spec.js';
import { registerPlan } from './plan.js';
import { registerDebug } from './debug.js';

export function registerFlow(): BranchDef {
  return defineBranch({
    name: 'flow',
    help: {
      name: 'flow',
      summary: 'the spec → plan → debug development process',
      model:
        'spec captures requirements; plan decomposes them; debug root-causes failures reproduce-first.',
      children: [
        { name: 'spec', desc: 'create, read, list specifications', useWhen: 'capturing requirements before planning' },
        { name: 'plan', desc: 'create, read, list plans', useWhen: 'shaping or inspecting work' },
        { name: 'debug', desc: 'reproduce-first root-cause workflow', useWhen: 'a bug, test failure, or unexpected behavior needs root-causing' },
      ],
    },
    children: [registerSpec(), registerPlan(), registerDebug()],
  });
}
