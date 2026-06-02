import { defineBranch, defineLeaf } from '../../core/command.js';
import { emitLine, writeStdout } from '../../core/io.js';
import {
  readResult as jobsReadResult,
  markCollected,
  jobStatus,
  listJobs,
  readLog,
  livePanes,
} from '../../core/jobs.js';
import { reapDeadSessions } from '../../core/sessions.js';
import { paginate } from '../../core/pagination.js';
import { WAIT_BUDGET_MS, FOLLOW_POLL_MS } from './shared.js';

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

    // Best-effort: reap dead sessions on the same tmux query used by listJobs.
    try { reapDeadSessions(livePanes()); } catch { /* ignore */ }

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
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a producer (e.g. `crtr agent new *`).' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Echo of input.' },
      { name: 'state', type: 'string', required: true, constraint: 'One of: live, done, failed, canceled, closed (worker pane closed with no submitted result), superseded (stepped-down agent).' },
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
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a producer (e.g. `crtr agent new *`).' },
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

    const terminalStates = new Set(['done', 'failed', 'canceled', 'closed', 'superseded']);

    await new Promise<void>((resolve) => {
      const poll = (): void => {
        const status = jobStatus(jobId);
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
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Job id from a producer (e.g. `crtr agent new *`).' },
      { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: 'When present, blocks until a result file appears (up to 10 min).' },
      { kind: 'flag', name: 'json', type: 'bool', required: false, constraint: 'Emit the full structured object as JSON. By default, when a markdown result body exists it is printed raw (no JSON wrapper).' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Echo of input.' },
      { name: 'status', type: 'string', required: true, constraint: 'One of: done, failed, canceled, closed, superseded, timeout. closed = the worker pane went away before submitting a result. superseded = stepped-down agent.' },
      { name: 'result_md', type: 'string', required: false, constraint: 'Markdown body submitted by an agent via `crtr job submit`. Present when the job used the agent submit path.' },
      { name: 'result', type: 'object', required: false, constraint: 'Structured object submitted by a programmatic caller (human/sys). Present when the job used the programmatic submit path.' },
      { name: 'reason', type: 'string', required: false, constraint: 'Short explanation from frontmatter. Present when status is failed (agent-reported error) or closed (worker pane closed before submitting).' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const wait = input['wait'] === true;
    const asJson = input['json'] === true;

    const r = await jobsReadResult(jobId, { waitMs: wait ? WAIT_BUDGET_MS : 0 });

    const payload: Record<string, unknown> = { job_id: jobId, status: r.status };
    if (r.result !== undefined) {
      payload['result'] = r.result;
    }
    if (r.result_md !== undefined) {
      payload['result_md'] = r.result_md;
    }
    if (r.reason !== undefined) {
      payload['reason'] = r.reason;
    }

    // Default: print the markdown body raw when present. --json overrides.
    const body =
      !asJson && r.result_md !== undefined
        ? r.result_md.endsWith('\n')
          ? r.result_md
          : r.result_md + '\n'
        : JSON.stringify(payload, null, 2) + '\n';

    // Write the result and learn whether the caller actually received it. We ack
    // collection (suppressing the parent's redundant push notice) ONLY on
    // confirmed delivery of a terminal result. A canceled/abandoned `--wait`
    // either never reaches here (process killed) or fails to flush (consumer
    // gone) — in both cases we leave NO tombstone, so the watcher still delivers
    // the notice. Bias-to-deliver: a redundant notice beats a lost completion.
    const delivered = await writeStdout(body);
    if (delivered && r.status !== 'timeout') {
      markCollected(jobId);
    }
    return undefined;
  },
});

export const readBranch = defineBranch({
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
