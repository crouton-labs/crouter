import { defineLeaf, defineBranch } from '../../core/command.js';
import { skillConfigKey } from '../../types.js';
import { resolveSkill } from '../../core/resolver.js';
import { requireScopeRoot } from '../../core/scope.js';
import { updateConfig, ensureScopeInitialized } from '../../core/config.js';
import { resolveWriteScope } from './shared.js';

async function toggleSkill(
  input: Record<string, unknown>,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  const nameRaw = input['name'] as string;
  const scopeStr = input['scope'] as string | undefined;
  const scope = resolveWriteScope(scopeStr);

  const skillObj = resolveSkill(nameRaw);
  const key = skillConfigKey(skillObj.plugin, skillObj.name);

  const scopeRootPath = requireScopeRoot(scope);
  ensureScopeInitialized(scope, scopeRootPath);

  updateConfig(scope, (cfg) => {
    cfg.skills[key] = { enabled };
  });

  return { name: skillObj.name, scope, enabled };
}

export const stateEnable = defineLeaf({
  name: 'enable',
  description: 'enable a skill',
  whenToUse: 're-enable a skill that was previously disabled, making it visible to list and agent discovery again in the target scope.',
  help: {
    name: 'skill state enable',
    summary: 'enable a skill in the given scope',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Skill identifier. Same forms as skill read.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope where the enable was applied.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always true.' },
    ],
    outputKind: 'object',
    effects: ['Writes the skill enable flag to config.json in the target scope.'],
  },
  run: async (input) => toggleSkill(input, true),
});

export const stateDisable = defineLeaf({
  name: 'disable',
  description: 'disable a skill',
  whenToUse: 'hide a skill from list and agent discovery without deleting it — writes a disable flag to config.json in the target scope; reverse it later with `crtr skill state enable`.',
  help: {
    name: 'skill state disable',
    summary: 'disable a skill in the given scope, hiding it from list and agent discovery',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Skill identifier. Same forms as skill read.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'Resolved skill name.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope where the disable was applied.' },
      { name: 'enabled', type: 'boolean', required: true, constraint: 'Always false.' },
    ],
    outputKind: 'object',
    effects: ['Writes the skill disable flag to config.json in the target scope.'],
  },
  run: async (input) => toggleSkill(input, false),
});

export const stateBranch = defineBranch({
  name: 'state',
  description: 'enable or disable skills',
  whenToUse: 'turn a skill on or off in a scope — disable to hide it from discovery without removing it, enable to bring it back.',
  help: {
    name: 'skill state',
    summary: 'enable or disable skills',
  },
  children: [stateEnable, stateDisable],
});
