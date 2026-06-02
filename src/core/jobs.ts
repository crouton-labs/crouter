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
//
// A worker is not required to submit. Besides an explicit submit, a job becomes
// terminal when (a) the wrapper shell's `crtr job _fail` runs on a clean exit,
// or (b) the hosting tmux pane is closed — which sends SIGHUP so (a) never runs.
// Case (b) is reaped here: when a live job's recorded pane is gone and no result
// exists, we write a `closed` result (terminal, but distinct from `failed`) so
// the job stops being a zombie without claiming an outcome we can't know.

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
import { appendNodeEvent, resolveNodeIdInSession } from './inbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// 'closed' = the worker's tmux pane went away before any result was submitted.
// It is terminal but distinct from 'failed' (a worker that ran and reported an
// error) — we simply don't know the outcome, so we don't claim it failed.
// 'superseded' = a stepped-down agent whose last-stop submit records this
// status (forward:false, superseded:true set by promotion).
type TerminalStatus = 'done' | 'failed' | 'canceled' | 'closed' | 'superseded';
type JobState = 'live' | TerminalStatus;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** How a completion notice should be delivered into a live pi parent session. */
type DeliveryHint = 'steer' | 'followUp';

interface JobMeta {
  job_id: string;
  kind: string;
  created_at: string;
  pid?: number;
  pane_id?: string;
  cwd: string;
  status: JobState;
  // Completion routing (R1). Persisted so ANY terminal-transition code path can
  // notify the parent without depending on the child's runtime env.
  report_to?: string[];
  session_id?: string;
  /** cwd NAMESPACE the session graph + inboxes live under (the spawner's cwd),
   *  which can differ from `cwd` (the child's working dir) when --cwd is used.
   *  Delivery must target this namespace so the parent's watcher (reading the
   *  same namespace) sees the notice (R1 cwd-identity). */
  session_cwd?: string;
  /** Display name + title carried in the completion notice. */
  name?: string;
  title?: string;
  /** Per-job delivery preference for the notice (R5). Default followUp. */
  delivery?: DeliveryHint;
  /** Set once the report_to parents have been notified (idempotency guard). */
  notified?: boolean;
  /** Set once a terminal result has been collected out-of-band (e.g. via
   *  `job read result --wait`). Idempotency guard for the `collected` tombstone
   *  written to the report_to inbox so the push watcher suppresses its notice. */
  collected?: boolean;
  // --- Phase 1: lifecycle fields ---
  /** 'worker' (ephemeral, finalizes on stop) | 'persistent' (stays live). Absent ⇒ 'worker'. */
  lifecycle?: 'worker' | 'persistent';
  /** True when this job roots its session graph. */
  root?: boolean;
  /** Absent/true ⇒ forward completion to report_to; false ⇒ suppress. */
  forward?: boolean;
  /** Set when this job was promoted away (stepped down). */
  superseded?: boolean;
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

/**
 * Set of every tmux pane id across all sessions on the running server. Empty
 * when no server is running (→ every recorded pane is treated as gone).
 *
 * This bridges tmux's pane lifecycle to the job registry. A worker whose pane
 * is closed/killed receives SIGHUP, so the wrapper shell's `crtr job _fail`
 * never runs and the job would otherwise stay `live` forever (a zombie). We
 * detect the vanished pane and reap the job instead.
 */
function allTmuxPaneIds(): Set<string> {
  const set = new Set<string>();
  const r = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return set;
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (t !== '') set.add(t);
  }
  return set;
}

/**
 * Reap a job whose hosting tmux pane has disappeared. Acts only when the job is
 * still `live`, has a recorded pane, and has produced no result file. Writes a
 * terminal `closed` result so the job stops being a zombie and every reader
 * (status, list, result --wait) agrees. `closed` is distinct from `failed`: we
 * don't know the outcome, only that the pane is gone. Returns true if it reaped.
 *
 * `panes` lets a caller reuse a single tmux query across many jobs (listJobs).
 */
function reapIfPaneDead(meta: JobMeta, panes?: Set<string>): boolean {
  if (meta.status !== 'live') return false;
  if (meta.pane_id === undefined || meta.pane_id === '') return false;
  if (existingResultPath(meta.job_id) !== null) return false;
  const set = panes ?? allTmuxPaneIds();
  if (set.has(meta.pane_id)) return false;
  try {
    writeMarkdownResult(meta.job_id, '', 'closed', 'worker pane closed before submitting a result');
  } catch {
    return false;
  }
  return true;
}

/** Poll cadence (ms) for detecting a closed worker pane during result --wait. */
const PANE_POLL_MS = 2000;

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
  opts: { cwd: string; pid?: number; lifecycle?: 'worker' | 'persistent'; root?: boolean; forward?: boolean },
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
  if (opts.pid !== undefined) meta.pid = opts.pid;
  if (opts.lifecycle !== undefined) meta.lifecycle = opts.lifecycle;
  if (opts.root !== undefined) meta.root = opts.root;
  if (opts.forward !== undefined) meta.forward = opts.forward;

  writeMeta(jobId, meta);
  return { jobId, dir };
}

/**
 * Record the completion-routing metadata for a job (R1): the node refs it
 * reports to, the session it belongs to, and the display name/title/delivery
 * hint carried in the completion notice. Written after createJob by the spawn
 * path (agent.ts) and human job creators. Merges over existing meta.
 */
export function recordJobReportTo(
  jobId: string,
  opts: {
    reportTo?: string[];
    sessionId?: string;
    sessionCwd?: string;
    name?: string;
    title?: string;
    delivery?: DeliveryHint;
  },
): void {
  const meta = readMeta(jobId);
  if (opts.reportTo !== undefined) meta.report_to = opts.reportTo;
  if (opts.sessionId !== undefined && opts.sessionId !== '') meta.session_id = opts.sessionId;
  if (opts.sessionCwd !== undefined && opts.sessionCwd !== '') meta.session_cwd = opts.sessionCwd;
  if (opts.name !== undefined && opts.name !== '') meta.name = opts.name;
  if (opts.title !== undefined && opts.title !== '') meta.title = opts.title;
  if (opts.delivery !== undefined) meta.delivery = opts.delivery;
  writeMeta(jobId, meta);
}

/**
 * Merge partial lifecycle flags into an existing job's meta.json.
 * Used by promotion (Phase 5) and `--persistent` wiring.
 */
export function recordJobFlags(
  jobId: string,
  partial: { lifecycle?: 'worker' | 'persistent'; root?: boolean; forward?: boolean; superseded?: boolean },
): void {
  const meta = readMeta(jobId);
  if (partial.lifecycle !== undefined) meta.lifecycle = partial.lifecycle;
  if (partial.root !== undefined) meta.root = partial.root;
  if (partial.forward !== undefined) meta.forward = partial.forward;
  if (partial.superseded !== undefined) meta.superseded = partial.superseded;
  writeMeta(jobId, meta);
}

/**
 * Deliver a `completed` event to each report_to parent recorded in meta (R2).
 * Best-effort and idempotent: returns true if at least one notice was written,
 * letting the caller set `meta.notified` in the SAME meta write so a later
 * terminal transition (e.g. `_fail` after a `submit`) does not double-notify.
 *
 * Host-agnostic: it only appends to the durable inbox JSONL. The live push into
 * a pi parent session is the watcher extension's job (R3); claude parents pull
 * via `crtr agent inbox` (R7).
 */
function notifyReportTo(meta: JobMeta, status: TerminalStatus): boolean {
  if (meta.notified === true) return false;
  const sessionId = meta.session_id;
  const targets = meta.report_to ?? [];
  if (sessionId === undefined || sessionId === '' || targets.length === 0) return false;

  const data: Record<string, unknown> = { status, delivery: meta.delivery ?? 'followUp' };
  if (meta.name !== undefined && meta.name !== '') data['name'] = meta.name;
  if (meta.title !== undefined && meta.title !== '') data['title'] = meta.title;

  // Inbox lives under the SESSION's cwd namespace (the spawner's cwd), which may
  // differ from meta.cwd (the child's working dir) when spawned with --cwd.
  const inboxCwd = meta.session_cwd ?? meta.cwd;
  let delivered = false;
  for (const ref of targets) {
    try {
      // Default report_to refs are already node ids (parent job id / pane node);
      // resolveNodeIdInSession handles name/index refs and falls back to the raw
      // ref when nothing matches.
      const nodeId = resolveNodeIdInSession(sessionId, ref, inboxCwd) ?? ref;
      appendNodeEvent(sessionId, nodeId, { from: meta.job_id, event: 'completed', data }, inboxCwd);
      delivered = true;
    } catch {
      /* best-effort per-target */
    }
  }
  return delivered;
}

/**
 * Append a `collected` tombstone to the report_to inbox(es) so the parent's push
 * watcher suppresses (or cancels) the corresponding `completed` notice — the
 * out-of-band pull path (`job read result --wait`) and the push path thus share
 * one consumption signal and the orchestrator is told exactly once.
 *
 * Idempotent via `meta.collected`: only the first terminal collection writes the
 * tombstone. Mirrors notifyReportTo's routing (same session, same cwd namespace,
 * same resolved nodes). Best-effort; never throws.
 *
 * CONTRACT: call this ONLY once the result has been delivered to a live caller
 * (the `job read result` command calls it after the result bytes flush to a
 * connected stdout). Never call it from a pure read or speculatively — a
 * canceled/abandoned `--wait` must leave NO tombstone so the push watcher still
 * delivers the notice (bias-to-deliver; losing a completion is worse than a
 * redundant notice).
 */
export function markCollected(jobId: string): void {
  let meta: JobMeta;
  try {
    meta = readMeta(jobId);
  } catch {
    return;
  }
  if (meta.collected === true) return;
  const sessionId = meta.session_id;
  const targets = meta.report_to ?? [];
  if (sessionId === undefined || sessionId === '' || targets.length === 0) return;

  const inboxCwd = meta.session_cwd ?? meta.cwd;
  let delivered = false;
  for (const ref of targets) {
    try {
      const nodeId = resolveNodeIdInSession(sessionId, ref, inboxCwd) ?? ref;
      appendNodeEvent(
        sessionId,
        nodeId,
        { from: meta.job_id, event: 'collected', data: { job_id: meta.job_id } },
        inboxCwd,
      );
      delivered = true;
    } catch {
      /* best-effort per-target */
    }
  }
  if (delivered) {
    meta.collected = true;
    try {
      writeMeta(jobId, meta);
    } catch {
      /* best-effort idempotency guard */
    }
  }
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
 * Record the pid of a detached worker (e.g. a headless background agent) so
 * jobStatus can mark the job failed if the process dies without a result.
 */
export function recordJobPid(jobId: string, pid: number): void {
  const meta = readMeta(jobId);
  meta.pid = pid;
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
  if (meta.forward !== false && notifyReportTo(meta, terminalStatus)) meta.notified = true;
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

  // Phase 2.3: a superseded job's natural-stop submit records 'superseded', not 'done'.
  const meta = readMeta(jobId);
  const effectiveStatus: TerminalStatus =
    terminalStatus === 'done' && meta.superseded === true ? 'superseded' : terminalStatus;

  const fm: MarkdownResultFrontmatter = {
    status: effectiveStatus,
    written_at: new Date().toISOString(),
  };
  if (reason !== undefined && reason !== '') {
    fm.reason = reason;
  }

  const content = `${renderFrontmatter(fm)}${body}`;
  const tmp = join(dir, '.result.tmp');
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, resultMdPath(jobId));

  meta.status = effectiveStatus;
  if (meta.forward !== false && notifyReportTo(meta, effectiveStatus)) meta.notified = true;
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
 *   - Closed:        pane vanished with no result → status 'closed'
 */
export interface ReadResultResponse {
  status: 'done' | 'failed' | 'canceled' | 'closed' | 'superseded' | 'timeout';
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

  // NOTE: readResult is PURE — it must never write the `collected` tombstone.
  // The ack is owned by the COMMAND layer (`job read result`), gated on the
  // result bytes actually being delivered to a live caller. A read that resolves
  // for an abandoned/canceled `--wait` (orphaned subprocess) must NOT suppress
  // the push notice; see markCollected and the command's delivery gate.
  const existing = existingResultPath(jobId);
  if (existing !== null) {
    return Promise.resolve(parseAt(existing));
  }

  if (opts.waitMs === undefined || opts.waitMs <= 0) {
    return Promise.resolve({ status: 'timeout' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const finish = (response: ReadResultResponse): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
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

    // fs.watch only fires on result files. A pane that closes without a submit
    // produces no such event, so poll to reap it instead of hanging until the
    // full timeout budget elapses.
    poll = setInterval(() => {
      const found = existingResultPath(jobId);
      if (found !== null) {
        finish(parseAt(found));
        return;
      }
      try {
        if (reapIfPaneDead(readMeta(jobId))) {
          const reaped = existingResultPath(jobId);
          if (reaped !== null) finish(parseAt(reaped));
        }
      } catch { /* noop */ }
    }, PANE_POLL_MS);

    // A non-finite budget (Infinity) means block until a result appears or the
    // worker pane dies — used by `human review`, where the human may take an
    // unbounded amount of time. The poll above still reaps a dead pane, so this
    // never hangs forever on a closed pane.
    if (Number.isFinite(opts.waitMs)) {
      timer = setTimeout(() => {
        finish({ status: 'timeout' });
      }, opts.waitMs);
    }
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
  let meta = readMeta(jobId);
  if (reapIfPaneDead(meta)) {
    meta = readMeta(jobId);
  }
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

  // One tmux query, reused to reap every job whose pane has vanished.
  const panes = allTmuxPaneIds();

  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mp = join(dir, 'meta.json');
      if (!existsSync(mp)) continue;
      let meta = JSON.parse(readFileSync(mp, 'utf8')) as JobMeta;
      if (reapIfPaneDead(meta, panes)) {
        meta = JSON.parse(readFileSync(mp, 'utf8')) as JobMeta;
      }

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

// ---------------------------------------------------------------------------
// Telemetry sidecar
// ---------------------------------------------------------------------------

export interface TelemetryRec {
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  model?: string;
  host_session_id?: string;
  updated_at: string;
}

function telemetryPath(jobId: string): string {
  return join(jobDir(jobId), 'telemetry.json');
}

/**
 * Write (merge) a telemetry patch into <job_dir>/telemetry.json.
 * Shallow-merges only the defined keys in `patch` over any existing record,
 * stamps `updated_at`, then writes tmp+rename. Throws `notFound` when the
 * job directory does not exist.
 */
export function writeTelemetry(
  jobId: string,
  patch: Omit<TelemetryRec, 'updated_at'>,
): void {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    throw notFound(`job not found: ${jobId}`, { job_id: jobId });
  }

  let existing: Partial<TelemetryRec> = {};
  const tp = telemetryPath(jobId);
  if (existsSync(tp)) {
    try {
      existing = JSON.parse(readFileSync(tp, 'utf8')) as Partial<TelemetryRec>;
    } catch { /* treat parse failure as absent */ }
  }

  // Only defined (non-undefined) keys from patch overwrite existing values.
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );

  const merged: TelemetryRec = {
    ...existing,
    ...definedPatch,
    updated_at: new Date().toISOString(),
  };

  const tmp = join(dir, '.telemetry.tmp');
  writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  renameSync(tmp, tp);
}

/**
 * Read <job_dir>/telemetry.json. Returns null when the file is absent or
 * unparseable — never throws on a missing/corrupt sidecar.
 */
export function readTelemetry(jobId: string): TelemetryRec | null {
  const tp = telemetryPath(jobId);
  if (!existsSync(tp)) return null;
  try {
    return JSON.parse(readFileSync(tp, 'utf8')) as TelemetryRec;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live panes — exported alias reused by sessions + reaper
// ---------------------------------------------------------------------------

/**
 * Set of every tmux pane id across all sessions. Empty when no tmux server is
 * running. Exported so the session module and job-list reap hook share one
 * `tmux list-panes -a` query instead of each issuing their own.
 */
export function livePanes(): Set<string> {
  return allTmuxPaneIds();
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
  if (meta.forward !== false && notifyReportTo(meta, 'canceled')) meta.notified = true;
  writeMeta(jobId, meta);

  return { canceled: signaled };
}
