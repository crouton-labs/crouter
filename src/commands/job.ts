// `crtr job` subtree — spawn/worker model backed by jobs.ts persistence.
//
// Sub-branches: start {prompt,fork,planner,implementer,reviewer},
//               read {list,status,logs,result}, submit, _fail, cancel.
//
// Terminal-write contract:
//   Worker calls `crtr job submit` → jobs.writeResult(jobId, result, 'done').
//   If claude exits without submitting, the wrapper shell calls `crtr job _fail`
//   → jobs.writeResult(jobId, {}, 'failed') IF result.json does not yet exist.
//   `job read result` watches result.json appearance as the sole completion signal.
//
// `job read logs` is the only JSONL leaf.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { emitLine } from '../core/io.js';
import { InputError } from '../core/io.js';
import {
  createJob,
  writeMarkdownResult,
  readResult as jobsReadResult,
  jobStatus,
  listJobs,
  readLog,
  cancelJob,
  appendEvent,
} from '../core/jobs.js';
import { spawnAgent, spawnAndDetach, scheduleKillCurrentPane, isInTmux } from '../core/spawn.js';
import { readConfig } from '../core/config.js';
import { planHandoffPrompt, implementHandoffPrompt, reviewerHandoffPrompt } from '../prompts/agent.js';
import { paginate } from '../core/pagination.js';
import { existsSync } from 'node:fs';

const WAIT_BUDGET_MS = 10 * 60 * 1000;
const FOLLOW_POLL_MS = 1000;
const DEFAULT_KILL_SECS = 2;

function followUpResult(jobId: string): string {
  return `crtr job read result ${jobId} --wait`;
}

function resolveMaxPanes(): number {
  const cfg = readConfig('user');
  return cfg.max_panes_per_window;
}

function assertTmux(): void {
  if (!isInTmux()) {
    throw new InputError({
      error: 'not_in_tmux',
      message: 'crtr job start requires tmux (TMUX env var not set).',
      next: 'Run inside a tmux session.',
    });
  }
}

// ---------------------------------------------------------------------------
// start sub-branch
// ---------------------------------------------------------------------------

const startPrompt = defineLeaf({
  name: 'prompt',
  help: {
    name: 'job start prompt',
    summary: 'spawn a fresh Claude agent with a prompt; returns a job handle immediately',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'Prompt text sent to the spawned agent.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory for the spawned agent. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `job read status`, `job read logs`, `job read result`, `job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a Claude agent in a sibling tmux pane.',
      'Creates a job entry at $XDG_STATE_HOME/crtr/jobs/<job_id>/.',
      'On completion, result writes atomically to result.json.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const prompt = input['prompt'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    const { jobId } = createJob('prompt', { cwd });

    const promptWithSubmit = `${prompt}

---
When your task is complete, submit your result (markdown body piped on stdin):
\`\`\`bash
crtr job submit ${jobId} <<'MD'
<your result as markdown>
MD
\`\`\`
If you cannot complete the task, submit a failure with a reason (no stdin needed):
\`\`\`bash
crtr job submit ${jobId} --status failed --reason "<why>"
\`\`\``;

    const result = spawnAgent({
      prompt: promptWithSubmit,
      cwd,
      jobId,
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({
        error: 'not_in_tmux',
        message: result.message,
        next: 'Run inside a tmux session.',
      });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({
        error: 'spawn_failed',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const paneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `pane ${paneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

const startFork = defineLeaf({
  name: 'fork',
  help: {
    name: 'job start fork',
    summary: 'fork the current Claude session into a sibling pane; returns a job handle immediately',
    params: [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `job read *` and `job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
      'Spawns a forked Claude session in a sibling tmux pane.',
      'Creates a job entry and result sidecar as with `job start prompt`.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const parentSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (parentSessionId === undefined || parentSessionId === '') {
      throw new InputError({
        error: 'missing_session_id',
        message: 'crtr job start fork requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
        next: 'Run this command from within a Claude Code session.',
      });
    }

    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    const { jobId } = createJob('fork', { cwd });

    const promptWithSubmit = `Fork of session ${parentSessionId}

---
When your task is complete, submit your result (markdown body piped on stdin):
\`\`\`bash
crtr job submit ${jobId} <<'MD'
<your result as markdown>
MD
\`\`\`
If you cannot complete the task, submit a failure with a reason (no stdin needed):
\`\`\`bash
crtr job submit ${jobId} --status failed --reason "<why>"
\`\`\``;

    const result = spawnAgent({
      prompt: promptWithSubmit,
      cwd,
      jobId,
      fork: { sessionId: parentSessionId },
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({
        error: 'not_in_tmux',
        message: result.message,
        next: 'Run inside a tmux session.',
      });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({
        error: 'spawn_failed',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const forkPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `forked pane ${forkPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

const startPlanner = defineLeaf({
  name: 'planner',
  help: {
    name: 'job start planner',
    summary: 'launch a planning agent for an approved spec; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'spec_path', type: 'path', required: true, constraint: 'Absolute path to the spec file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `job read *` and `job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a planner agent in a sibling tmux pane.',
      'Closes the originating pane after a short delay.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const specPath = input['spec_path'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(specPath)) {
      throw new InputError({
        error: 'not_found',
        message: `spec not found: ${specPath}`,
        field: 'spec_path',
        next: 'Provide an absolute path to an existing spec file.',
      });
    }

    const { jobId } = createJob('planner', { cwd });

    const result = spawnAndDetach({
      prompt: planHandoffPrompt(specPath, jobId),
      cwd,
      jobId,
      placement: 'split-h',
      killAfterSeconds: DEFAULT_KILL_SECS,
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({
        error: 'not_in_tmux',
        message: result.message,
        next: 'Run inside a tmux session.',
      });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({
        error: 'spawn_failed',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const plannerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `planner pane ${plannerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

const startImplementer = defineLeaf({
  name: 'implementer',
  help: {
    name: 'job start implementer',
    summary: 'launch an implementation agent for an approved plan; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'plan_path', type: 'path', required: true, constraint: 'Absolute path to the plan file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `job read *` and `job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns an implementer agent in a sibling tmux pane.',
      'Closes the originating pane after a short delay.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const planPath = input['plan_path'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(planPath)) {
      throw new InputError({
        error: 'not_found',
        message: `plan not found: ${planPath}`,
        field: 'plan_path',
        next: 'Provide an absolute path to an existing plan file.',
      });
    }

    const { jobId } = createJob('implementer', { cwd });

    const result = spawnAndDetach({
      prompt: implementHandoffPrompt(planPath, jobId),
      cwd,
      jobId,
      placement: 'split-h',
      killAfterSeconds: DEFAULT_KILL_SECS,
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({
        error: 'not_in_tmux',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({
        error: 'spawn_failed',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const implPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `implementer pane ${implPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

const startReviewer = defineLeaf({
  name: 'reviewer',
  help: {
    name: 'job start reviewer',
    summary: 'launch a reviewer agent for a plan or spec artifact; the originating pane stays alive to collect the verdict',
    params: [
      { kind: 'positional', name: 'artifact_path', type: 'path', required: true, constraint: 'Absolute path to the artifact to review.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: ['plan', 'spec'], required: true, constraint: 'Artifact kind to review.' },
      { kind: 'flag', name: 'spec-path', type: 'path', required: false, constraint: 'Absolute path to the spec, for plan reviews. Omit for spec reviews.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `job read *` and `job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a reviewer agent in a sibling tmux pane.',
      'The originating pane stays alive — wait on the result and act on the verdict.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const artifactPath = input['artifact_path'] as string;
    const artifactKind = input['kind'] as 'plan' | 'spec';
    const specPath = typeof input['specPath'] === 'string' ? input['specPath'] : undefined;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(artifactPath)) {
      throw new InputError({
        error: 'not_found',
        message: `artifact not found: ${artifactPath}`,
        field: 'artifact_path',
        next: 'Provide an absolute path to an existing artifact file.',
      });
    }

    const { jobId } = createJob('reviewer', { cwd });

    // The reviewer is a subordinate the caller waits on (verdict → revise or
    // hand off), NOT a handoff successor. Use spawnAgent so the originating
    // pane (planner/orchestrator) stays alive to collect the result; do not
    // self-kill the caller the way planner/implementer handoffs do.
    const result = spawnAgent({
      prompt: reviewerHandoffPrompt(artifactPath, artifactKind, specPath !== undefined ? specPath : null, jobId),
      cwd,
      jobId,
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({
        error: 'not_in_tmux',
        message: result.message,
        next: 'Run inside a tmux session.',
      });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({
        error: 'spawn_failed',
        message: result.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const reviewerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `reviewer pane ${reviewerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

const startBranch = defineBranch({
  name: 'start',
  help: {
    name: 'job start',
    summary: 'spawn agent workers; all return a job handle immediately',
    children: [
      { name: 'prompt', desc: 'fresh agent with a prompt', useWhen: 'spawning a general-purpose agent' },
      { name: 'fork', desc: 'fork current session into a sibling pane', useWhen: 'branching the current session\'s context into a new agent' },
      { name: 'planner', desc: 'planning agent for a spec', useWhen: 'handing off spec → plan decomposition' },
      { name: 'implementer', desc: 'implementation agent for a plan', useWhen: 'handing off plan → code implementation' },
      { name: 'reviewer', desc: 'review agent for a plan or spec', useWhen: 'launching a review of a plan or spec artifact' },
    ],
  },
  children: [startPrompt, startFork, startPlanner, startImplementer, startReviewer],
});

// ---------------------------------------------------------------------------
// read sub-branch
// ---------------------------------------------------------------------------

const readList = defineLeaf({
  name: 'list',
  help: {
    name: 'job read list',
    summary: 'paginated list of jobs, sorted by created_at ascending',
    params: [
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 20, constraint: 'Default 20, max 100.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from next_cursor. Omit on first call.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {job_id, kind, state, created_at}. Sorted by created_at ascending.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Total count of all jobs.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const limit = typeof input['limit'] === 'number' ? input['limit'] : 20;
    const cursor = typeof input['cursor'] === 'string' ? input['cursor'] : undefined;

    const all = listJobs();
    const page = paginate(all, { limit, cursor }, {
      defaultLimit: 20,
      maxLimit: 100,
      keyOf: (item) => item.created_at,
      total: 'count',
    });

    return {
      items: page.items,
      next_cursor: page.next_cursor,
      total: page.total,
    };
  },
});

const readStatus = defineLeaf({
  name: 'status',
  help: {
    name: 'job read status',
    summary: 'read the current status of a job',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a `job start *` call.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Echo of input.' },
      { name: 'state', type: 'string', required: true, constraint: 'One of: live, done, failed, canceled.' },
      { name: 'age_s', type: 'number', required: true, constraint: 'Seconds since job creation.' },
      { name: 'last_event', type: 'object | null', required: true, constraint: 'Most recent log event {event, ts}, or null if no events yet.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const status = jobStatus(jobId);
    return {
      job_id: jobId,
      state: status.state,
      age_s: status.age_s,
      last_event: status.last_event,
    };
  },
});

const readLogs = defineLeaf({
  name: 'logs',
  help: {
    name: 'job read logs',
    summary: 'read log events from a job; emits JSONL — one event object per line',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a `job start *` call.' },
      { kind: 'flag', name: 'since', type: 'string', required: false, constraint: 'ISO 8601 timestamp. Only emit events at or after this time.' },
      { kind: 'flag', name: 'until', type: 'string', required: false, constraint: 'ISO 8601 timestamp. Only emit events before this time.' },
      { kind: 'flag', name: 'level', type: 'enum', choices: ['debug', 'info', 'warn', 'error'], required: false, default: 'info', constraint: 'Minimum severity. Default: info.' },
      { kind: 'flag', name: 'follow', type: 'bool', required: false, constraint: 'When present, stream new events until the job reaches a terminal state, then stop.' },
    ],
    output: [
      {
        name: '<event line>',
        type: 'object',
        required: true,
        constraint: 'Each JSONL line is: {ts:string, level:"debug"|"info"|"warn"|"error", event:string, message:string, data?:object}. Emitted one per line.',
      },
    ],
    outputKind: 'jsonl',
    effects: ['None. Read-only.'],
  },
  run: async (input): Promise<void> => {
    const jobId = input['job_id'] as string;
    const since = typeof input['since'] === 'string' ? input['since'] : undefined;
    const until = typeof input['until'] === 'string' ? input['until'] : undefined;
    const level = (typeof input['level'] === 'string' ? input['level'] : 'info') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error';
    const follow = input['follow'] === true;

    const minLevel = level;

    // Emit all existing events.
    const events = readLog(jobId, { sinceTs: since, untilTs: until, minLevel });
    for (const ev of events) {
      emitLine(ev as Record<string, unknown>);
    }

    if (!follow) return;

    // Follow: poll for new events until the job reaches a terminal state.
    // Track the latest emitted timestamp to avoid re-emitting.
    let lastTs: string = until !== undefined ? until : new Date(0).toISOString();
    // Update lastTs from emitted events.
    for (const ev of events) {
      const e = ev as Record<string, unknown>;
      if (typeof e['ts'] === 'string' && e['ts'] > lastTs) {
        lastTs = e['ts'];
      }
    }

    const terminalStates = new Set(['done', 'failed', 'canceled']);

    await new Promise<void>((resolve) => {
      const poll = (): void => {
        // Check terminal state first.
        const status = jobStatus(jobId);
        // Emit any new events since lastTs.
        const newEvents = readLog(jobId, { sinceTs: lastTs !== new Date(0).toISOString() ? lastTs : undefined, minLevel });
        for (const ev of newEvents) {
          const e = ev as Record<string, unknown>;
          if (typeof e['ts'] === 'string' && e['ts'] > lastTs) {
            emitLine(e);
            lastTs = e['ts'];
          }
        }

        if (terminalStates.has(status.state)) {
          resolve();
          return;
        }

        setTimeout(poll, FOLLOW_POLL_MS);
      };

      setTimeout(poll, FOLLOW_POLL_MS);
    });
  },
});

const readResult = defineLeaf({
  name: 'result',
  help: {
    name: 'job read result',
    summary: 'read the final result of a completed job',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a `job start *` call.' },
      { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: 'When present, blocks until a result file appears (up to 10 min).' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Echo of input.' },
      { name: 'status', type: 'string', required: true, constraint: 'One of: done, failed, canceled, timeout.' },
      { name: 'result_md', type: 'string', required: false, constraint: 'Markdown body submitted by an agent via `crtr job submit`. Present when the job used the agent submit path.' },
      { name: 'result', type: 'object', required: false, constraint: 'Structured object submitted by a programmatic caller (human/sys). Present when the job used the programmatic submit path.' },
      { name: 'reason', type: 'string', required: false, constraint: 'Failure reason from frontmatter when status is failed and the agent submit path was used.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const wait = input['wait'] === true;

    const r = await jobsReadResult(jobId, { waitMs: wait ? WAIT_BUDGET_MS : 0 });

    const out: Record<string, unknown> = { job_id: jobId, status: r.status };
    if (r.result !== undefined) {
      out['result'] = r.result;
    }
    if (r.result_md !== undefined) {
      out['result_md'] = r.result_md;
    }
    if (r.reason !== undefined) {
      out['reason'] = r.reason;
    }
    return out;
  },
});

const readBranch = defineBranch({
  name: 'read',
  help: {
    name: 'job read',
    summary: 'read job status, logs, or results',
    children: [
      { name: 'list', desc: 'paginated job list', useWhen: 'enumerating jobs' },
      { name: 'status', desc: 'current state and age', useWhen: 'checking if a job is still live' },
      { name: 'logs', desc: 'stream JSONL log events', useWhen: 'monitoring progress or debugging a job' },
      { name: 'result', desc: 'read final result', useWhen: 'collecting the output of a completed job' },
    ],
  },
  children: [readList, readStatus, readLogs, readResult],
});

// ---------------------------------------------------------------------------
// submit — called by the worker inside its pane
// ---------------------------------------------------------------------------

const jobSubmit = defineLeaf({
  name: 'submit',
  help: {
    name: 'job submit',
    summary: 'inside a crtr-spawned pane, deliver the markdown result back to the job record',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id injected as $CRTR_JOB_ID in the spawned pane.' },
      { kind: 'stdin', name: 'body', required: false, constraint: 'Markdown body of the result, piped on stdin. Required when --status is done (the default). When --status failed, stdin is optional; --reason carries the explanation.' },
      { kind: 'flag', name: 'status', type: 'enum', choices: ['done', 'failed'], required: false, default: 'done', constraint: 'Terminal status to record. Default: done.' },
      { kind: 'flag', name: 'reason', type: 'string', required: false, constraint: 'Short failure reason. Required when --status failed; ignored otherwise.' },
      { kind: 'flag', name: 'kill-pane', type: 'bool', required: false, constraint: `When present, schedule the current tmux pane to close ${DEFAULT_KILL_SECS}s after submission so the spawned worker does not linger. Reviewer agents should pass this; planner/implementer handoffs already self-kill on spawn.` },
    ],
    output: [
      { name: 'submitted', type: 'boolean', required: true, constraint: 'Always true on success.' },
      { name: 'pane_kill_scheduled', type: 'boolean', required: true, constraint: 'True when --kill-pane is set and a tmux pane kill was scheduled. False otherwise (--kill-pane not set, not in tmux, or TMUX_PANE unset).' },
    ],
    outputKind: 'object',
    effects: [
      'Writes <jobdir>/result.md atomically (YAML frontmatter + body), marking the job done or failed.',
      'Updates meta.json status to match.',
      `When --kill-pane is set, schedules \`tmux kill-pane\` on $TMUX_PANE after ${DEFAULT_KILL_SECS}s (detached; submit still returns cleanly).`,
    ],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const status = (typeof input['status'] === 'string' ? input['status'] : 'done') as 'done' | 'failed';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const reason = typeof input['reason'] === 'string' ? input['reason'] : '';
    const killPane = input['killPane'] === true;

    if (status === 'done' && body.trim() === '') {
      throw new InputError({
        error: 'invalid_field',
        message: '--status done requires a markdown body on stdin.',
        field: 'body',
        next: `Pipe the markdown result on stdin, e.g. \`crtr job submit ${jobId} <<'MD' ... MD\`. For failures, use \`--status failed --reason "<why>"\`.`,
      });
    }
    if (status === 'failed' && reason.trim() === '') {
      throw new InputError({
        error: 'invalid_field',
        message: '--status failed requires --reason "<text>".',
        field: 'reason',
        next: 'Pass --reason explaining why the task could not complete.',
      });
    }

    writeMarkdownResult(jobId, body, status, status === 'failed' ? reason : undefined);
    const paneKillScheduled = killPane ? scheduleKillCurrentPane(DEFAULT_KILL_SECS) : false;
    return { submitted: true, pane_kill_scheduled: paneKillScheduled };
  },
});

// ---------------------------------------------------------------------------
// _fail — called by the wrapper shell if claude exits without submitting
// ---------------------------------------------------------------------------

const jobFail = defineLeaf({
  name: '_fail',
  help: {
    name: 'job _fail',
    summary: 'internal: mark a job failed if it has not already been submitted (called by wrapper shell)',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id. If a result file already exists, this is a no-op.' },
    ],
    output: [
      { name: 'recorded', type: 'boolean', required: true, constraint: 'True if failure was recorded; false if a result file already existed (no-op).' },
    ],
    outputKind: 'object',
    effects: [
      'Writes result.md with status "failed" and a reason if no result file is present.',
      'Updates meta.json status to failed.',
    ],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    // No-op if a result file already exists (worker submitted successfully).
    try {
      const existing = await jobsReadResult(jobId, { waitMs: 0 });
      if (existing.status !== 'timeout') {
        return { recorded: false };
      }
    } catch {
      // job dir not found — still try to write to surface the failure
    }
    try {
      writeMarkdownResult(jobId, '', 'failed', 'worker exited without submitting');
      return { recorded: true };
    } catch {
      return { recorded: false };
    }
  },
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

const jobCancel = defineLeaf({
  name: 'cancel',
  help: {
    name: 'job cancel',
    summary: 'send a best-effort cancellation signal to a running job',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a `job start *` call.' },
    ],
    output: [
      { name: 'canceled', type: 'boolean', required: true, constraint: 'True if a signal was delivered or the job was already terminal; false if the job was not live.' },
    ],
    outputKind: 'object',
    effects: ['Best-effort: delivers SIGTERM to the worker process and marks meta.json canceled.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const result = cancelJob(jobId);
    return { canceled: result.canceled };
  },
});

// ---------------------------------------------------------------------------
// root branch
// ---------------------------------------------------------------------------

export function registerJob(): BranchDef {
  return defineBranch({
    name: 'job',
    help: {
      name: 'job',
      summary: 'spawn, monitor, and collect results from running agent workers',
      model: 'Jobs are running or completed agent workers. Status: live | done | failed | canceled.',
      children: [
        { name: 'start', desc: 'spawn agent workers', useWhen: 'launching a new agent job' },
        { name: 'read', desc: 'read status, logs, or results', useWhen: 'monitoring or collecting from a running or completed job' },
        { name: 'submit', desc: 'deliver result from inside a spawned pane', useWhen: 'worker is ready to return its output' },
        { name: '_fail', desc: 'internal: mark job failed on unsubmitted exit', useWhen: 'called by the wrapper shell, not manually' },
        { name: 'cancel', desc: 'best-effort cancel a live job', useWhen: 'stopping a job that is no longer needed' },
      ],
    },
    children: [startBranch, readBranch, jobSubmit, jobFail, jobCancel],
  });
}
