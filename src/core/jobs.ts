// Job / long-running-operation infrastructure.
//
// Files are the single source of truth. No in-memory registry. An agent picks
// up a job by id across processes. Crashes recover by reading files.
//
// Layout: ${XDG_STATE_HOME or ~/.local/state}/crtr/jobs/<job_id>/
//   meta.json    — written atomically on create; updated atomically on terminal transition.
//   log.jsonl    — append-only event log.
//   result.json  — written atomically; its APPEARANCE is the only completion signal.

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { notFound, general } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TerminalStatus = 'done' | 'failed' | 'canceled';
type JobState = 'live' | TerminalStatus;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface JobMeta {
  job_id: string;
  kind: string;
  created_at: string;
  pid?: number;
  pane_id?: string;
  cwd: string;
  status: JobState;
}

interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  data?: object;
}

interface ResultFile {
  status: TerminalStatus;
  result: object;
  written_at: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function jobsRoot(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = (xdg !== undefined && xdg !== '') ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'crtr', 'jobs');
}

function jobDir(jobId: string): string {
  return join(jobsRoot(), jobId);
}

function metaPath(jobId: string): string {
  return join(jobDir(jobId), 'meta.json');
}

function logPath(jobId: string): string {
  return join(jobDir(jobId), 'log.jsonl');
}

function resultPath(jobId: string): string {
  return join(jobDir(jobId), 'result.json');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rnd = randomBytes(4).toString('hex');
  return `${ts}-${rnd}`;
}

function ensureJobsRoot(): void {
  mkdirSync(jobsRoot(), { recursive: true });
}

function readMeta(jobId: string): JobMeta {
  const p = metaPath(jobId);
  if (!existsSync(p)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as JobMeta;
  } catch {
    throw general(`failed to parse meta.json for job ${jobId}`, { job_id: jobId });
  }
}

function writeMeta(jobId: string, meta: JobMeta): void {
  const dir = jobDir(jobId);
  const tmp = join(dir, '.meta.tmp');
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, metaPath(jobId));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Allocate a new job directory and write meta.json atomically.
 * Returns the job_id and the absolute directory path.
 */
export function createJob(
  kind: string,
  opts: { cwd: string; pid?: number },
): { jobId: string; dir: string } {
  ensureJobsRoot();
  const jobId = generateJobId();
  const dir = jobDir(jobId);
  mkdirSync(dir, { recursive: true });

  const meta: JobMeta = {
    job_id: jobId,
    kind,
    created_at: new Date().toISOString(),
    cwd: opts.cwd,
    status: 'live',
  };
  if (opts.pid !== undefined) {
    meta.pid = opts.pid;
  }

  writeMeta(jobId, meta);
  return { jobId, dir };
}

/**
 * Record the tmux pane hosting a detached worker so `cancelJob` can kill it.
 */
export function recordJobPane(jobId: string, paneId: string): void {
  const meta = readMeta(jobId);
  meta.pane_id = paneId;
  writeMeta(jobId, meta);
}

/**
 * Append one event line to log.jsonl. Does NOT throw if jobId doesn't exist —
 * a crashed writer should not further corrupt state; use a guard at the call site.
 */
export function appendEvent(
  jobId: string,
  event: { level: LogLevel; event: string; message: string; data?: object },
): void {
  const p = logPath(jobId);
  const line: LogEvent = {
    ts: new Date().toISOString(),
    level: event.level,
    event: event.event,
    message: event.message,
  };
  if (event.data !== undefined) {
    line.data = event.data;
  }
  appendFileSync(p, JSON.stringify(line) + '\n', 'utf8');
}

/**
 * Atomically write result.json and update meta.json status.
 * result.json's appearance is the ONLY completion signal — never inferred from
 * log content.
 */
export function writeResult(
  jobId: string,
  result: object,
  terminalStatus: TerminalStatus,
): void {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  const payload: ResultFile = {
    status: terminalStatus,
    result,
    written_at: new Date().toISOString(),
  };

  // Atomic write: tmp + rename within same directory (same fs, rename is atomic).
  const tmp = join(dir, '.result.tmp');
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, resultPath(jobId));

  // Update meta status.
  const meta = readMeta(jobId);
  meta.status = terminalStatus;
  writeMeta(jobId, meta);
}

/**
 * Read result.json. If it doesn't exist and waitMs is given, block via fs.watch
 * until result.json appears or the timeout elapses.
 *
 * Race safety: registers the watcher THEN re-stats. If result.json appeared
 * between the first stat and the watch registration, the re-stat catches it
 * before the watcher has a chance to miss it.
 */
export function readResult(
  jobId: string,
  opts: { waitMs?: number } = {},
): Promise<{ status: 'done' | 'failed' | 'canceled' | 'timeout'; result?: object }> {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  function parseResult(): { status: TerminalStatus; result: object } {
    const raw = readFileSync(resultPath(jobId), 'utf8');
    const parsed = JSON.parse(raw) as ResultFile;
    return { status: parsed.status, result: parsed.result };
  }

  // Fast path: result already present.
  if (existsSync(resultPath(jobId))) {
    const r = parseResult();
    return Promise.resolve({ status: r.status, result: r.result });
  }

  if (opts.waitMs === undefined || opts.waitMs <= 0) {
    return Promise.resolve({ status: 'timeout' });
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (status: 'done' | 'failed' | 'canceled' | 'timeout', result?: object): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher.close(); } catch { /* noop */ }
      resolve({ status, result });
    };

    // Register watcher first, then re-stat (race safety).
    const watcher = watch(dir, (_event, name) => {
      if (name === 'result.json' && existsSync(resultPath(jobId))) {
        const r = parseResult();
        finish(r.status, r.result);
      }
    });

    // Re-stat after watcher is registered to close the race window.
    if (existsSync(resultPath(jobId))) {
      const r = parseResult();
      finish(r.status, r.result);
      return;
    }

    const timer = setTimeout(() => {
      finish('timeout');
    }, opts.waitMs);
  });
}

/**
 * Derive job state from meta.json, result.json, and the tail of log.jsonl.
 * If a pid is recorded, is not alive, and no result.json exists → 'failed'.
 */
export function jobStatus(jobId: string): {
  state: JobState;
  age_s: number;
  last_event: { event: string; ts: string } | null;
} {
  const meta = readMeta(jobId);
  const age_s = (Date.now() - new Date(meta.created_at).getTime()) / 1000;

  // Derive effective state.
  let state: JobState = meta.status;
  if (state === 'live') {
    if (existsSync(resultPath(jobId))) {
      // result.json present but meta not yet updated (rare); trust the file.
      try {
        const r = JSON.parse(readFileSync(resultPath(jobId), 'utf8')) as ResultFile;
        state = r.status;
      } catch { /* leave as live */ }
    } else if (meta.pid !== undefined && !pidAlive(meta.pid)) {
      state = 'failed';
    }
  }

  // Tail of log for last_event.
  let last_event: { event: string; ts: string } | null = null;
  const lp = logPath(jobId);
  if (existsSync(lp)) {
    const lines = readFileSync(lp, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      try {
        const ev = JSON.parse(line) as LogEvent;
        last_event = { event: ev.event, ts: ev.ts };
        break;
      } catch { continue; }
    }
  }

  return { state, age_s, last_event };
}

/**
 * List all jobs sorted by created_at ascending. Pagination is applied by the
 * caller, not here.
 */
export function listJobs(): { job_id: string; kind: string; state: JobState; created_at: string }[] {
  const root = jobsRoot();
  if (!existsSync(root)) return [];

  const entries = readdirSync(root);
  const jobs: { job_id: string; kind: string; state: JobState; created_at: string }[] = [];

  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mp = join(dir, 'meta.json');
      if (!existsSync(mp)) continue;
      const meta = JSON.parse(readFileSync(mp, 'utf8')) as JobMeta;

      // Derive effective state (result.json beats meta.status for live jobs).
      let state: JobState = meta.status;
      if (state === 'live' && existsSync(join(dir, 'result.json'))) {
        try {
          const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as ResultFile;
          state = r.status;
        } catch { /* leave as live */ }
      }

      jobs.push({ job_id: meta.job_id, kind: meta.kind, state, created_at: meta.created_at });
    } catch { continue; }
  }

  jobs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return jobs;
}

/**
 * Read and filter log events. Ordering preserved. sinceTs/untilTs are ISO8601
 * strings; minLevel filters by severity rank (inclusive).
 */
export function readLog(
  jobId: string,
  opts: { sinceTs?: string; untilTs?: string; minLevel?: LogLevel } = {},
): object[] {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  const lp = logPath(jobId);
  if (!existsSync(lp)) return [];

  const raw = readFileSync(lp, 'utf8');
  const results: object[] = [];
  const minRank = opts.minLevel !== undefined ? LEVEL_RANK[opts.minLevel] : 0;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let ev: LogEvent;
    try {
      ev = JSON.parse(line) as LogEvent;
    } catch { continue; }

    if (opts.sinceTs !== undefined && ev.ts < opts.sinceTs) continue;
    if (opts.untilTs !== undefined && ev.ts >= opts.untilTs) continue;
    if (LEVEL_RANK[ev.level] < minRank) continue;

    results.push(ev);
  }

  return results;
}

/**
 * Best-effort cancel: send SIGTERM to the recorded pid (if any), mark meta
 * canceled. Success means the signal was delivered, not that execution stopped.
 */
export function cancelJob(jobId: string): { canceled: boolean } {
  const meta = readMeta(jobId);

  if (meta.status !== 'live') {
    // Already terminal — nothing to cancel.
    return { canceled: false };
  }

  let signaled = false;
  if (meta.pid !== undefined) {
    try {
      process.kill(meta.pid, 'SIGTERM');
      signaled = true;
    } catch { /* pid gone or unpermitted */ }
  }

  if (meta.pane_id !== undefined && meta.pane_id !== '') {
    const k = spawnSync('tmux', ['kill-pane', '-t', meta.pane_id], { encoding: 'utf8' });
    if (k.status === 0) signaled = true;
  }

  meta.status = 'canceled';
  writeMeta(jobId, meta);

  return { canceled: signaled };
}
