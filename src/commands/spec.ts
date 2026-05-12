import { Command } from 'commander';
import { registerArtifactCommand } from '../core/artifact.js';
import { specPrompt } from '../prompts/spec.js';

export function registerSpecCommand(program: Command): void {
  registerArtifactCommand(program, {
    command: 'spec',
    kind: 'specs',
    promptFn: specPrompt,
  });
}
