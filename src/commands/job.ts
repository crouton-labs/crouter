// `crtr job` subtree — universal monitoring registry for any ongoing task.
//
// Producers (agent spawns, future task systems) register jobs and write
// results; this subtree is the read/cancel/submit surface shared across all
// producers. Sub-branches: read {list, status, logs, result}, submit, _fail,
// cancel.
//
// Terminal-write contract:
//   Worker MAY call `crtr job submit` → writes result.md (done|failed).
//   If claude exits without submitting, the wrapper shell's `crtr job _fail`
//   marks it failed IF no result file exists yet.
//   If the worker's tmux pane is closed, SIGHUP skips `_fail`; the jobs layer
//   then reaps the job by detecting that its recorded pane has vanished.
//   `job read result` watches result file appearance and polls for pane death.
//
// `job read logs` is the only JSONL leaf.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { readBranch } from './job/read.js';
import { jobTelemetry, jobSubmit, jobFail, jobCancel } from './job/manage.js';
import { buildJobRootBlock } from './job/shared.js';

export { liveJobCount, buildJobRootBlock } from './job/shared.js';

export function registerJob(): BranchDef {
  return defineBranch({
    name: 'job',
    rootEntry: {
      concept: 'producer-agnostic record of any ongoing task — its logs and result',
      desc: 'monitor and collect from any ongoing task',
      useWhen: 'reading status, logs, or result of a job started by any producer',
      dynamicState: buildJobRootBlock,
    },
    help: {
      name: 'job',
      summary: 'monitor and collect results from any ongoing task',
      model:
        'A job is a producer-agnostic record of an ongoing task: state, logs, terminal result. Producers (`crtr agent new *`, future task systems) create jobs; this subtree is the shared read/cancel/submit surface. States: live | done | failed | canceled | closed (worker pane closed before submitting a result) | superseded (stepped-down agent).',
      children: [
        { name: 'read', desc: 'read status, logs, or results', useWhen: 'monitoring or collecting from a running or completed job' },
        { name: 'submit', desc: 'deliver result from inside a worker pane or any producer', useWhen: 'a worker is ready to return its output' },
        { name: 'telemetry', desc: 'push token/cost/model telemetry onto a job', useWhen: 'a worker wants to record tokens used, cost, or model name' },
        { name: '_fail', desc: 'internal: mark job failed on unsubmitted exit', useWhen: 'called by the wrapper shell, not manually' },
        { name: 'cancel', desc: 'best-effort cancel a live job', useWhen: 'stopping a job that is no longer needed' },
      ],
    },
    children: [readBranch, jobSubmit, jobTelemetry, jobFail, jobCancel],
  });
}
