import { defineLeaf } from '../../core/command.js';
import { updateState } from '../../core/config.js';
import { projectScopeRoot } from '../../core/scope.js';
import { selfCheck, selfUpdate, contentCheck, contentUpdate } from '../../core/self-update.js';
import { nowIso } from '../../core/fs-utils.js';
import { readPackageVersion } from './shared.js';
import type { Scope } from '../../types.js';

export const sysUpdateLeaf = defineLeaf({
  name: 'update',
  help: {
    name: 'sys update',
    summary: 'update the crtr binary and/or installed plugins and marketplaces',
    params: [
      { kind: 'flag', name: 'target', type: 'enum', choices: ['self', 'content', 'all'], required: false, constraint: "What to update. Default: all." },
      { kind: 'flag', name: 'check', type: 'bool', required: false, constraint: 'Check for updates without applying them (bounded, blocking).' },
    ],
    output: [
      { name: 'target', type: 'string', required: false, constraint: 'Present when applying updates: self | content | all.' },
      { name: 'status', type: 'string', required: false, constraint: 'done | failed when applying updates.' },
      { name: 'error', type: 'string', required: false, constraint: 'Failure message when status is failed.' },
      { name: 'updates', type: 'object[]', required: false, constraint: 'Present when --check. Each: {name, current, latest, up_to_date, unreachable, kind}.' },
      { name: 'up_to_date', type: 'boolean', required: false, constraint: 'Present when --check. True when all items are up to date.' },
    ],
    outputKind: 'object',
    effects: [
      '--check — read-only, bounded network calls.',
      'Default (no --check) — launches a background job; returns job handle immediately.',
    ],
  },
  run: async (input) => {
    const target = input['target'] as string | undefined;
    const check = input['check'] as boolean;
    const resolvedTarget = target !== undefined ? target : 'all';

    if (check) {
      // Bounded blocking path: collect check results and return
      const updates: Array<{
        name: string;
        kind: string;
        current: string | null;
        latest: string | null;
        up_to_date: boolean;
        unreachable: boolean;
      }> = [];

      if (resolvedTarget === 'self' || resolvedTarget === 'all') {
        const r = selfCheck();
        if (r !== null) {
          updates.push({
            name: '@crouton-kit/crouter',
            kind: 'self',
            current: r.current,
            latest: r.latest,
            up_to_date: r.current === r.latest,
            unreachable: false,
          });
        } else {
          updates.push({
            name: '@crouton-kit/crouter',
            kind: 'self',
            current: null,
            latest: null,
            up_to_date: true,
            unreachable: true,
          });
        }
      }

      if (resolvedTarget === 'content' || resolvedTarget === 'all') {
        const entries = contentCheck();
        for (const e of entries) {
          updates.push({
            name: e.name,
            kind: e.kind,
            current: e.current,
            latest: e.latest,
            up_to_date: e.up_to_date,
            unreachable: e.unreachable,
          });
        }
      }

      const up_to_date = updates.every((u) => u.up_to_date || u.unreachable);
      return { updates: updates as unknown as Record<string, unknown>[], up_to_date };
    }

    // Apply path — run synchronously (selfUpdate/contentUpdate are sync spawns).
    try {
      if (resolvedTarget === 'self' || resolvedTarget === 'all') {
        selfUpdate();
        const scopes: Scope[] = ['user'];
        if (projectScopeRoot()) scopes.unshift('project');
        for (const scope of scopes) {
          updateState(scope, (s) => {
            s.last_self_check = nowIso();
          });
        }
      }

      if (resolvedTarget === 'content' || resolvedTarget === 'all') {
        contentUpdate();
      }

      return { target: resolvedTarget, status: 'done' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { target: resolvedTarget, status: 'failed', error: msg };
    }
  },
});

export const sysVersionLeaf = defineLeaf({
  name: 'version',
  help: {
    name: 'sys version',
    summary: 'print the installed crtr version',
    params: [],
    output: [
      { name: 'version', type: 'string', required: true, constraint: 'Semver string from package.json.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (_input) => {
    return { version: readPackageVersion() };
  },
});
