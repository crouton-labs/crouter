import { defineLeaf } from '../../core/command.js';
import { updateState } from '../../core/config.js';
import { projectScopeRoot } from '../../core/scope.js';
import { createJob, appendEvent, writeResult } from '../../core/jobs.js';
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
      { name: 'job_id', type: 'string', required: false, constraint: 'Present when applying updates. Poll with `crtr job read result JOB_ID --wait`.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Instruction for retrieving the job result.' },
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

    // Long-running apply path: create a job, run in background, return handle
    const cwd = process.cwd();
    const { jobId } = createJob('sys-update', { cwd, pid: process.pid });

    // Run update asynchronously without awaiting in the main path
    void (async () => {
      try {
        if (resolvedTarget === 'self' || resolvedTarget === 'all') {
          appendEvent(jobId, { level: 'info', event: 'self-update:start', message: 'running npm install -g @crouton-kit/crouter@latest' });
          selfUpdate();
          const scopes: Scope[] = ['user'];
          if (projectScopeRoot()) scopes.unshift('project');
          for (const scope of scopes) {
            updateState(scope, (s) => {
              s.last_self_check = nowIso();
            });
          }
          appendEvent(jobId, { level: 'info', event: 'self-update:done', message: 'crtr binary updated' });
        }

        if (resolvedTarget === 'content' || resolvedTarget === 'all') {
          appendEvent(jobId, { level: 'info', event: 'content-update:start', message: 'pulling updates for marketplaces and plugins' });
          contentUpdate();
          appendEvent(jobId, { level: 'info', event: 'content-update:done', message: 'content updates complete' });
        }

        writeResult(jobId, { target: resolvedTarget, status: 'done' }, 'done');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendEvent(jobId, { level: 'error', event: 'update:error', message: msg });
        writeResult(jobId, { error: msg }, 'failed');
      }
    })();

    return {
      job_id: jobId,
      follow_up: `crtr job read result ${jobId} --wait`,
    };
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
