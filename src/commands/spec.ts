import { Command } from 'commander';
import { registerArtifactCommand } from '../core/artifact.js';
import { specPrompt } from '../prompts/spec.js';
import { specReviewPrompt } from '../prompts/review.js';

export function registerSpecCommand(program: Command): void {
  registerArtifactCommand(program, {
    command: 'spec',
    kind: 'specs',
    promptFn: specPrompt,
    reviewer: {
      buildPrompt: (specPath) => specReviewPrompt(specPath),
    },
  });
}
