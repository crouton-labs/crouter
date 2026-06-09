import { defineRoot } from './core/command.js';
import type { RootDef } from './core/command.js';
import { registerSkill } from './commands/skill.js';
import { registerMemory } from './commands/memory.js';
import { registerPkg } from './commands/pkg.js';
import { registerHuman } from './commands/human.js';
import { registerSys } from './commands/sys.js';
import { registerPush, registerFeed } from './commands/push.js';
import { registerNode } from './commands/node.js';
import { registerCanvas } from './commands/canvas.js';
import { registerView } from './commands/view.js';

/** Assemble the full crtr command tree. Root owns only the tagline; every
 *  subtree declares its own root representation via its rootEntry, and every
 *  branch assembles its child listing from the child defs (each child owns its
 *  description/whenToUse/tier). No globals: -h is taught by each child's
 *  whenToUse CTA and the capability-discovery rule in the root footer, so a
 *  standalone "-h: print help" stub would be redundant. */
export function buildRoot(): RootDef {
  return defineRoot({
    tagline: 'crtr: agentic planning runtime.',
    globals: [],
    subtrees: [
      registerSkill(),
      registerMemory(),
      registerPkg(),
      registerHuman(),
      registerSys(),
      registerNode(),
      registerPush(),
      registerFeed(),
      registerCanvas(),
      registerView(),
    ],
  });
}
