import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import {
  writeMarkdownResult,
  readResult as jobsReadResult,
  appendEvent,
  writeTelemetry,
  readTelemetry,
  cancelJob,
  recordJobFlags,
} from '../../core/jobs.js';
import { scheduleKillCurrentPane } from '../../core/spawn.js';
import { DEFAULT_KILL_SECS } from './shared.js';

// ---------------------------------------------------------------------------
// telemetry — push token/cost metadata onto a job record
// ---------------------------------------------------------------------------

export const jobTelemetry = defineLeaf({
  name: 'telemetry',
  help: {
    name: 'job telemetry',
    summary: 'write or merge telemetry (tokens/cost/model) onto a job record',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id to update.' },
      { kind: 'flag', name: 'tokens-in', type: 'int', required: false, constraint: 'Input token count.' },
      { kind: 'flag', name: 'tokens-out', type: 'int', required: false, constraint: 'Output token count.' },
      { kind: 'flag', name: 'cost-usd', type: 'string', required: false, constraint: 'Floating-point cost in USD, e.g. 0.0042.' },
      { kind: 'flag', name: 'model', type: 'string', required: false, constraint: 'Model identifier string.' },
      { kind: 'flag', name: 'host-session-id', type: 'string', required: false, constraint: 'Host agent session id (join key to the host\'s session graph).' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Echo of input.' },
      { name: 'updated_at', type: 'string', required: true, constraint: 'ISO 8601 timestamp of the write.' },
    ],
    outputKind: 'object',
    effects: [
      'Writes/merges <job_dir>/telemetry.json (host-agnostic; the session read model joins it).',
    ],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;

    // Build patch from only the defined (non-undefined) flags.
    const patch: {
      tokens_in?: number;
      tokens_out?: number;
      cost_usd?: number;
      model?: string;
      host_session_id?: string;
    } = {};

    if (typeof input['tokensIn'] === 'number') patch.tokens_in = input['tokensIn'] as number;
    if (typeof input['tokensOut'] === 'number') patch.tokens_out = input['tokensOut'] as number;
    if (typeof input['costUsd'] === 'string' && input['costUsd'] !== '') {
      const v = parseFloat(input['costUsd'] as string);
      if (isNaN(v)) {
        throw new InputError({
          error: 'invalid_field',
          message: `--cost-usd must be a number, got: ${input['costUsd'] as string}`,
          field: 'cost-usd',
          next: 'Pass a numeric value like 0.0042.',
        });
      }
      patch.cost_usd = v;
    }
    if (typeof input['model'] === 'string') patch.model = input['model'] as string;
    if (typeof input['hostSessionId'] === 'string') patch.host_session_id = input['hostSessionId'] as string;

    if (Object.keys(patch).length === 0) {
      throw new InputError({
        error: 'empty_telemetry',
        message: 'at least one telemetry field is required',
        next: 'Pass one or more of: --tokens-in, --tokens-out, --cost-usd, --model, --host-session-id.',
      });
    }

    writeTelemetry(jobId, patch);
    // Read back the updated_at from the sidecar to return the authoritative timestamp.
    // writeTelemetry just wrote it so it exists — but be defensive.
    let updatedAt = new Date().toISOString();
    try {
      const rec = readTelemetry(jobId);
      if (rec !== null) updatedAt = rec.updated_at;
    } catch { /* noop */ }

    return { job_id: jobId, updated_at: updatedAt };
  },
});

// ---------------------------------------------------------------------------
// submit — called by the worker inside its pane (or by any producer that
// writes a result programmatically)
// ---------------------------------------------------------------------------

export const jobSubmit = defineLeaf({
  name: 'submit',
  help: {
    name: 'job submit',
    summary: 'deliver a markdown result back to a job record (called by workers, or any producer writing the terminal value)',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id injected as $CRTR_JOB_ID in the spawned pane.' },
      { kind: 'stdin', name: 'body', required: false, constraint: 'Markdown body of the result, piped on stdin. Required when --status is done (the default). When --status failed or superseded, stdin is optional; --reason carries the explanation.' },
      { kind: 'flag', name: 'status', type: 'enum', choices: ['done', 'failed', 'superseded'], required: false, default: 'done', constraint: 'Terminal status to record. Default: done. Use superseded for a stepped-down agent.' },
      { kind: 'flag', name: 'reason', type: 'string', required: false, constraint: 'Short failure reason. Required when --status failed; ignored otherwise.' },
      { kind: 'flag', name: 'no-forward', type: 'bool', required: false, constraint: 'When present, set meta.forward=false before writing — the result is written but no completion notice is delivered to report_to parents.' },
      { kind: 'flag', name: 'kill-pane', type: 'bool', required: false, constraint: `When present, schedule the current tmux pane to close ${DEFAULT_KILL_SECS}s after submission so the spawned worker does not linger after delivering its result.` },
    ],
    output: [
      { name: 'submitted', type: 'boolean', required: true, constraint: 'Always true on success.' },
      { name: 'pane_kill_scheduled', type: 'boolean', required: true, constraint: 'True when --kill-pane is set and a tmux pane kill was scheduled. False otherwise (--kill-pane not set, not in tmux, or TMUX_PANE unset).' },
    ],
    outputKind: 'object',
    effects: [
      'Writes <jobdir>/result.md atomically (YAML frontmatter + body), marking the job done, failed, or superseded.',
      'Updates meta.json status to match.',
      'When --no-forward is set, sets meta.forward=false before writing so no completion notice is delivered to report_to parents.',
      `When --kill-pane is set, schedules \`tmux kill-pane\` on $TMUX_PANE after ${DEFAULT_KILL_SECS}s (detached; submit still returns cleanly).`,
    ],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const status = (typeof input['status'] === 'string' ? input['status'] : 'done') as 'done' | 'failed' | 'superseded';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const reason = typeof input['reason'] === 'string' ? input['reason'] : '';
    const killPane = input['killPane'] === true;
    const noForward = input['noForward'] === true;

    if (noForward) {
      recordJobFlags(jobId, { forward: false });
    }

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
    appendEvent(jobId, {
      level: status === 'failed' ? 'error' : 'info',
      event: 'worker_finished',
      message: status === 'failed' ? `worker failed: ${reason}` : 'worker submitted result',
    });
    const paneKillScheduled = killPane ? scheduleKillCurrentPane(DEFAULT_KILL_SECS) : false;
    return { submitted: true, pane_kill_scheduled: paneKillScheduled };
  },
});

// ---------------------------------------------------------------------------
// _fail — called by the wrapper shell if claude exits without submitting
// ---------------------------------------------------------------------------

export const jobFail = defineLeaf({
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
      appendEvent(jobId, {
        level: 'error',
        event: 'worker_finished',
        message: 'worker exited without submitting',
      });
      return { recorded: true };
    } catch {
      return { recorded: false };
    }
  },
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export const jobCancel = defineLeaf({
  name: 'cancel',
  help: {
    name: 'job cancel',
    summary: 'send a best-effort cancellation signal to a running job',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a producer (e.g. `crtr agent new *`).' },
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
