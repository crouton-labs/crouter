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
  help: {
    name: 'skill state',
    summary: 'enable or disable skills',
    children: [
      { name: 'enable', desc: 'enable a skill', useWhen: 'making a previously disabled skill available again' },
      { name: 'disable', desc: 'disable a skill', useWhen: 'hiding a skill from list and agent discovery without removing it' },
    ],
  },
  children: [stateEnable, stateDisable],
});
