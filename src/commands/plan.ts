import { Command } from 'commander';
import { registerArtifactCommand } from '../core/artifact.js';
import { planPrompt } from '../prompts/plan.js';

export function registerPlanCommand(program: Command): void {
  registerArtifactCommand(program, {
    command: 'plan',
    kind: 'plans',
    promptFn: planPrompt,
  });
}
