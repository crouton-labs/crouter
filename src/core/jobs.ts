// Job / long-running-operation infrastructure.
//
// Files are the single source of truth. No in-memory registry. An agent picks
// up a job by id across processes. Crashes recover by reading files.
//
// Layout: ${XDG_STATE_HOME or ~/.local/state}/crtr/jobs/<job_id>/
//   meta.json    — written atomically on create; updated atomically on terminal transition.
//   log.jsonl    — append-only event log.
//   result.md    — agent submissions (markdown body + YAML frontmatter). Written atomically.
//   result.json  — programmatic submissions (structured object). Written atomically.
// Either result file's APPEARANCE is the completion signal. Exactly one is written per job.

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

interface JsonResultFile {
  status: TerminalStatus;
  result: object;
  written_at: string;
}

interface MarkdownResultFrontmatter {
  status: TerminalStatus;
  written_at: string;
  reason?: string;
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

function resultJsonPath(jobId: string): string {
  return join(jobDir(jobId), 'result.json');
}

function resultMdPath(jobId: string): string {
  return join(jobDir(jobId), 'result.md');
}

/** Path of whichever result file currently exists, or null if neither does. */
function existingResultPath(jobId: string): string | null {
  const md = resultMdPath(jobId);
  if (existsSync(md)) return md;
  const js = resultJsonPath(jobId);
  if (existsSync(js)) return js;
  return null;
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
 * Atomically write result.json (structured object) and update meta.json status.
 * Used by programmatic callers (human, sys) that produce object results.
 * The result file's appearance is the completion signal — never inferred from log content.
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

  const payload: JsonResultFile = {
    status: terminalStatus,
    result,
    written_at: new Date().toISOString(),
  };

  const tmp = join(dir, '.result.tmp');
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, resultJsonPath(jobId));

  const meta = readMeta(jobId);
  meta.status = terminalStatus;
  writeMeta(jobId, meta);
}

/**
 * Atomically write result.md (YAML frontmatter + markdown body) and update meta.json status.
 * Used by `crtr job submit` for agent-driven markdown results.
 */
export function writeMarkdownResult(
  jobId: string,
  body: string,
  terminalStatus: TerminalStatus,
  reason?: string,
): void {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  const fm: MarkdownResultFrontmatter = {
    status: terminalStatus,
    written_at: new Date().toISOString(),
  };
  if (reason !== undefined && reason !== '') {
    fm.reason = reason;
  }

  const content = `${renderFrontmatter(fm)}${body}`;
  const tmp = join(dir, '.result.tmp');
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, resultMdPath(jobId));

  const meta = readMeta(jobId);
  meta.status = terminalStatus;
  writeMeta(jobId, meta);
}

/**
 * Render a small fixed-shape frontmatter block. We control writer and reader,
 * so a 3-key hand-rolled emitter is plenty — no YAML dep, no escaping surprises.
 * Values are plain strings; we double-quote `reason` to survive newlines/colons.
 */
function renderFrontmatter(fm: MarkdownResultFrontmatter): string {
  const lines = ['---', `status: ${fm.status}`, `written_at: ${fm.written_at}`];
  if (fm.reason !== undefined) {
    const escaped = fm.reason.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    lines.push(`reason: "${escaped}"`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Parse the small fixed-shape frontmatter we emit. Tolerant of trailing
 * whitespace; returns `{ frontmatter, body }`. Throws if the document does not
 * start with `---\n` or no closing `---` is found.
 */
function parseMarkdownResult(raw: string): { frontmatter: MarkdownResultFrontmatter; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    throw new Error('result.md missing opening --- delimiter');
  }
  const afterOpen = raw.indexOf('\n') + 1;
  const closeIdx = raw.indexOf('\n---', afterOpen);
  if (closeIdx === -1) {
    throw new Error('result.md missing closing --- delimiter');
  }
  const fmBlock = raw.slice(afterOpen, closeIdx);
  // Body starts after the closing `---` line.
  const afterCloseLine = raw.indexOf('\n', closeIdx + 1);
  const body = afterCloseLine === -1 ? '' : raw.slice(afterCloseLine + 1);

  const fm: Partial<MarkdownResultFrontmatter> = {};
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m === null) continue;
    const key = m[1];
    if (m[2] === undefined) continue;
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (key === 'status') {
      fm.status = val as TerminalStatus;
    } else if (key === 'written_at') {
      fm.written_at = val;
    } else if (key === 'reason') {
      fm.reason = val;
    }
  }
  if (fm.status === undefined || fm.written_at === undefined) {
    throw new Error('result.md frontmatter missing status or written_at');
  }
  return { frontmatter: fm as MarkdownResultFrontmatter, body };
}

/**
 * Read whichever result file exists (result.md or result.json). If neither
 * exists and waitMs is given, block via fs.watch until one appears or the
 * timeout elapses.
 *
 * Race safety: registers the watcher THEN re-stats. If a result file appeared
 * between the first stat and the watch registration, the re-stat catches it
 * before the watcher has a chance to miss it.
 *
 * Returns shape:
 *   - JSON path:     { status, result: object }
 *   - Markdown path: { status, result_md: string, reason?: string }
 *   - Timeout:       { status: 'timeout' }
 */
export interface ReadResultResponse {
  status: 'done' | 'failed' | 'canceled' | 'timeout';
  result?: object;
  result_md?: string;
  reason?: string;
}

export function readResult(
  jobId: string,
  opts: { waitMs?: number } = {},
): Promise<ReadResultResponse> {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  function parseAt(path: string): ReadResultResponse {
    const raw = readFileSync(path, 'utf8');
    if (path.endsWith('.md')) {
      const { frontmatter, body } = parseMarkdownResult(raw);
      const out: ReadResultResponse = { status: frontmatter.status, result_md: body };
      if (frontmatter.reason !== undefined) {
        out.reason = frontmatter.reason;
      }
      return out;
    }
    const parsed = JSON.parse(raw) as JsonResultFile;
    return { status: parsed.status, result: parsed.result };
  }

  const existing = existingResultPath(jobId);
  if (existing !== null) {
    return Promise.resolve(parseAt(existing));
  }

  if (opts.waitMs === undefined || opts.waitMs <= 0) {
    return Promise.resolve({ status: 'timeout' });
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (response: ReadResultResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher.close(); } catch { /* noop */ }
      resolve(response);
    };

    const watcher = watch(dir, (_event, name) => {
      if (name !== 'result.md' && name !== 'result.json') return;
      const path = existingResultPath(jobId);
      if (path !== null) {
        finish(parseAt(path));
      }
    });

    const path = existingResultPath(jobId);
    if (path !== null) {
      finish(parseAt(path));
      return;
    }

    const timer = setTimeout(() => {
      finish({ status: 'timeout' });
    }, opts.waitMs);
  });
}

/**
 * Derive job state from meta.json, the result file, and the tail of log.jsonl.
 * If a pid is recorded, is not alive, and no result file exists → 'failed'.
 */
export function jobStatus(jobId: string): {
  state: JobState;
  age_s: number;
  last_event: { event: string; ts: string } | null;
} {
  const meta = readMeta(jobId);
  const age_s = (Date.now() - new Date(meta.created_at).getTime()) / 1000;

  let state: JobState = meta.status;
  if (state === 'live') {
    const existing = existingResultPath(jobId);
    if (existing !== null) {
      // Result file present but meta not yet updated (rare); trust the file.
      try {
        if (existing.endsWith('.md')) {
          const { frontmatter } = parseMarkdownResult(readFileSync(existing, 'utf8'));
          state = frontmatter.status;
        } else {
          const r = JSON.parse(readFileSync(existing, 'utf8')) as JsonResultFile;
          state = r.status;
        }
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

      // Derive effective state (result file beats meta.status for live jobs).
      let state: JobState = meta.status;
      if (state === 'live') {
        const mdP = join(dir, 'result.md');
        const jsP = join(dir, 'result.json');
        try {
          if (existsSync(mdP)) {
            const { frontmatter } = parseMarkdownResult(readFileSync(mdP, 'utf8'));
            state = frontmatter.status;
          } else if (existsSync(jsP)) {
            const r = JSON.parse(readFileSync(jsP, 'utf8')) as JsonResultFile;
            state = r.status;
          }
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
