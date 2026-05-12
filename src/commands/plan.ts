import { Command } from 'commander';
import { artifactPath, registerArtifactCommand } from '../core/artifact.js';
import { planPrompt } from '../prompts/plan.js';
import { planReviewPrompt } from '../prompts/review.js';

export function registerPlanCommand(program: Command): void {
  registerArtifactCommand(program, {
    command: 'plan',
    kind: 'plans',
    promptFn: planPrompt,
    oversizeWarnLines: 250,
    reviewer: {
      extraSaveOptions: [
        {
          flag: '--spec <name>',
          description: 'name of the spec this plan implements (enables alignment check)',
          key: 'spec',
        },
      ],
      buildPrompt: (planPath, opts) => {
        const specName = opts.spec;
        const specPath = specName === undefined ? null : artifactPath('specs', specName);
        return planReviewPrompt(planPath, specPath);
      },
    },
  });
}
