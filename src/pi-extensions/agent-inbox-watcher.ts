// crtr parent-side inbox watcher (pi).
//
// The symmetric counterpart to agent-stophook.ts: where the stop-hook fires
// when a crtr-spawned agent FINISHES, this extension runs in the PARENT pi
// session and pushes child-completion notices into it automatically — so the
// orchestrator never has to poll `crtr agent inbox` or block on
// `crtr job read result --wait`. See spec auto-inject-job-completion (R3–R6).
//
// It runs in two contexts (R6):
//   - Spawned agents: crtr `-e`-injects it alongside the stop-hook
//     (buildAgentCommand, ../core/spawn.ts).
//   - Top-level human session: installed as a STANDING extension in the user's
//     pi config (pi-personal-extensions).
//
// It is INERT in a plain pi session: it only activates once it can resolve a
// crtr session + node for its tmux pane (R8). A non-crtr pane never resolves a
// session, so nothing is ever injected and no errors surface.
//
// Plain JS-with-types (no @earendil-works/* import) so it compiles inside
// crouter's tsc build without taking a dependency on the pi packages — matching
// the stop-hook's constraint. Shapes used here are verified against pi's
// ExtensionAPI (dist/core/extensions/types.d.ts):
//   pi.sendUserMessage(content, { deliverAs?: 'steer' | 'followUp' })  // always triggers a turn
//   ctx.isIdle(): boolean
//   events: agent_start / agent_end (track streaming), session_start (capture ctx)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

type PiEvents = 'session_start' | 'agent_start' | 'agent_end' | 'turn_end' | 'session_shutdown';
interface PiLike {
  on: (event: PiEvents, handler: (event: any, ctx: any) => void | Promise<void>) => void;
  sendUserMessage: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ) => void;
}

/**
 * Publish the current pi conversation id into the process env so child
 * subprocesses (`crtr agent new`, `crtr human`) inherit it. pi's bash tool
 * builds child env from a live `process.env` spread at exec time, so this
 * reaches children race-free. It is BOTH the child handshake and the watcher's
 * own top-level resolution key. No-op when the session id is unavailable
 * (older pi without getSessionId) — the watcher then stays inert at top level.
 */
function publishPiSessionId(ctx: any): void {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === 'string' && id !== '') process.env.CRTR_PI_SESSION_ID = id;
  } catch {
    /* best-effort */
  }
}

// Module-level handle to the live tick timer. pi IGNORES an extension factory's
// returned disposer, so a `/reload` (or any re-init) would otherwise leave the
// previous setInterval running and ADD a new one — N reloads => N live watchers,
// each with its own in-memory cursor, all delivering the same completion. That
// is the double-notify bug. We clear any prior timer on re-init AND on
// session_shutdown so exactly one watcher is ever live.
let liveTimer: ReturnType<typeof setInterval> | undefined;

const CRTR_DIR_NAME = '.crouter';
// Tick cadence and coalescing window. We re-scan the resolved inbox file every
// TICK_MS; a burst of completions that arrive within DEBOUNCE_MS of each other
// is injected as a single coalesced notice (R5).
const TICK_MS = 800;
const DEBOUNCE_MS = 1200;

function mangleCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * The inbox to read on a tick, where the durable cursor lives, and what to seed
 * it with on first resolution. There is exactly ONE inbox per watcher because
 * each crtr session binds 1:1 to a pi conversation:
 *   - Spawned agent: the session is CRTR_SESSION_ID; the node is its own job.
 *   - Top-level: the session is the one whose `pi_session_id` matches THIS pi
 *     conversation (CRTR_PI_SESSION_ID, injected at session_start); the node is
 *     `pi:<pi_session_id>`. A new conversation in a reused tmux pane has a
 *     different pi_session_id, so it resolves a different session and can never
 *     read a prior conversation's inbox (the pane-reuse bleed bug).
 */
interface Target {
  /** The inbox JSONL(s) to read this tick. Always length 1; kept as an array
   *  so the reader loop is uniform. */
  inboxFiles: string[];
  /** Durable cursor location (survives watcher restarts → exactly-once). */
  cursorFile: string;
  /** Cursor to seed on FIRST resolution when no cursor file exists yet. */
  seedTs: string;
}

interface PendingCompletion {
  jobId: string;
  name: string;
  status: string;
  delivery: 'steer' | 'followUp';
}

/**
 * Resolve the single inbox to read, its durable cursor, and the first-resolution
 * seed. Mirrors `crtr agent inbox`'s resolution.
 *   - Spawned agent: CRTR_SESSION_ID is set; the node is its own job
 *     (CRTR_JOB_ID == CRTR_PARENT_JOB_ID == node id).
 *   - Top-level human session: no CRTR_SESSION_ID; resolve the session whose
 *     `pi_session_id` matches CRTR_PI_SESSION_ID (the pi conversation that owns
 *     this pane); the node is `pi:<pi_session_id>`.
 * Returns null when nothing resolves — a plain pi session, OR a top-level
 * session with no pi id available (older pi / watcher not installed): we stay
 * INERT rather than falling back to the pane-union path, whose cross-conversation
 * bleed is exactly what this redesign removes.
 */
function resolveTarget(): Target | null {
  // The session namespace is the SPAWNER's cwd, propagated via CRTR_SESSION_CWD
  // to every spawned agent (so an inherited session keeps the cwd it was minted
  // under even when a child runs with a differing --cwd). A top-level session
  // has no such env, so it falls back to this pi process's own cwd — which is
  // exactly where its sessions were minted. Keeps delivery and the watcher in
  // ONE cwd namespace (spec R1 cwd-identity / acceptance #10).
  const cwd = process.env.CRTR_SESSION_CWD || process.cwd();
  const sessionsDir = join(homedir(), CRTR_DIR_NAME, mangleCwd(cwd), 'sessions');

  const envSession = process.env.CRTR_SESSION_ID;
  const jobId = process.env.CRTR_JOB_ID || process.env.CRTR_PARENT_JOB_ID;
  if (envSession && envSession.trim() !== '' && jobId && jobId.trim() !== '') {
    // Spawned agent: one fixed session + inbox; seed from the session's created.
    const inboxFile = join(sessionsDir, envSession, 'inboxes', `${sanitizeNodeId(jobId)}.jsonl`);
    return {
      inboxFiles: [inboxFile],
      cursorFile: `${inboxFile}.cursor`,
      seedTs: sessionCreated(join(sessionsDir, envSession, 'session.json')),
    };
  }

  // Top-level: the session bound to THIS pi conversation. No pi id → inert.
  const piId = process.env.CRTR_PI_SESSION_ID;
  if (!piId || piId.trim() === '') return null;
  if (!existsSync(sessionsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const sanitizedNode = sanitizeNodeId(`pi:${piId}`);
  for (const entry of entries) {
    const mp = join(sessionsDir, entry, 'session.json');
    if (!existsSync(mp)) continue;
    try {
      const rec = JSON.parse(readFileSync(mp, 'utf8')) as { pi_session_id?: string | null; created?: string };
      if (rec.pi_session_id !== piId) continue;
      // Exactly one inbox; per-inbox cursor (same shape as the spawned branch),
      // seeded from this session's created. /reload keeps the same pi id → same
      // session → same cursor → no re-inject.
      const inboxFile = join(sessionsDir, entry, 'inboxes', `${sanitizedNode}.jsonl`);
      return {
        inboxFiles: [inboxFile],
        cursorFile: `${inboxFile}.cursor`,
        seedTs: typeof rec.created === 'string' ? rec.created : '',
      };
    } catch {
      continue;
    }
  }
  return null; // no session bound yet — inert until the first spawn binds one
}

/** session.json `created` timestamp, or '' when absent/unreadable. */
function sessionCreated(metaFile: string): string {
  try {
    if (existsSync(metaFile)) {
      const rec = JSON.parse(readFileSync(metaFile, 'utf8')) as { created?: string };
      if (typeof rec.created === 'string') return rec.created;
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * Seed the read cursor on first resolution WITHOUT a `now` reset (which would
 * drop a completion that landed before the watcher resolved — the startup race,
 * spec R3 / acceptance #9). Order: durable cursor file → target.seedTs
 * (session-creation time) → '' (read all).
 */
function seedCursor(target: Target): string {
  try {
    if (existsSync(target.cursorFile)) {
      const v = readFileSync(target.cursorFile, 'utf8').trim();
      if (v !== '') return v;
    }
  } catch {
    /* fall through */
  }
  return target.seedTs;
}

/** Persist the durable cursor so a watcher restart never re-injects. Best-effort. */
function persistCursor(target: Target, cursor: string): void {
  try {
    writeFileSync(target.cursorFile, cursor, 'utf8');
  } catch {
    /* best-effort; the sessions dir should exist by the time we have events */
  }
}

/** Read inbox events with ts strictly after `sinceTs`. */
function readSince(inboxFile: string, sinceTs: string): { ts: string; event: string; from: string | null; data?: any }[] {
  if (!existsSync(inboxFile)) return [];
  let raw: string;
  try {
    raw = readFileSync(inboxFile, 'utf8');
  } catch {
    return [];
  }
  const out: { ts: string; event: string; from: string | null; data?: any }[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ev = JSON.parse(line) as { ts: string; event: string; from: string | null; data?: any };
      if (ev.ts <= sinceTs) continue;
      out.push(ev);
    } catch {
      continue;
    }
  }
  return out;
}

/** Build the coalesced completion notice injected into the parent session (R4). */
function renderNotice(pending: PendingCompletion[]): string {
  if (pending.length === 1) {
    const p = pending[0]!;
    const label = p.name && p.name !== '' ? `${p.name} (${p.jobId})` : p.jobId;
    return (
      `[crtr] Worker ${label} finished with status "${p.status}". ` +
      `Fetch its result with \`crtr job read result ${p.jobId}\` if you need the body, ` +
      `then continue your work.`
    );
  }
  const lines = pending.map((p) => {
    const label = p.name && p.name !== '' ? `${p.name} (${p.jobId})` : p.jobId;
    return `  - ${label}: ${p.status}`;
  });
  return (
    `[crtr] ${pending.length} workers finished:\n${lines.join('\n')}\n` +
    `Fetch any result you need with \`crtr job read result <job_id>\`, then continue.`
  );
}

export default function agentInboxWatcher(pi: PiLike): () => void {
  // Capture the latest event context so we can read idle state from the timer
  // callback (which has no ctx of its own).
  let lastCtx: any;
  let streaming = false;
  const captureCtx = (_event: any, ctx: any): void => {
    if (ctx !== undefined) lastCtx = ctx;
    publishPiSessionId(ctx);
  };
  pi.on('session_start', (_event: any, ctx: any): void => {
    captureCtx(_event, ctx);
    // Bootstrap the persistent root job ONLY for a true top-level pi
    // conversation. A spawned agent already inherits CRTR_SESSION_ID/
    // CRTR_JOB_ID from its spawn and is a node in its SPAWNER's session;
    // re-rooting it here would (1) mint a redundant per-agent session and
    // (2) repoint CRTR_JOB_ID/CRTR_SESSION_ID off the job its completions are
    // delivered to, so this watcher would tail the wrong inbox and silently
    // drop every notice meant for it (defeating resolveTarget's own
    // spawned-agent branch). Skip whenever an inherited crtr session is present.
    const inherited = process.env['CRTR_SESSION_ID'];
    if (inherited && inherited.trim() !== '') return;
    // Bootstrap so CRTR_SESSION_ID, CRTR_JOB_ID, CRTR_SESSION_CWD are set in
    // process.env before any `crtr agent new` calls. pi's bash tool spreads
    // live process.env at exec time, so children inherit these race-free.
    // This is an eagerness optimization; `crtr agent new` self-heals when
    // CRTR_PI_SESSION_ID is set but this block hasn't run yet.
    const piId = process.env['CRTR_PI_SESSION_ID'];
    if (piId && piId.trim() !== '') {
      try {
        const r = spawnSync('crtr', ['agent', 'root-init'], {
          encoding: 'utf8',
          env: process.env as NodeJS.ProcessEnv,
        });
        if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== '') {
          const parsed = JSON.parse(r.stdout.trim()) as { session_id?: string; job_id?: string };
          if (typeof parsed.session_id === 'string' && typeof parsed.job_id === 'string') {
            process.env['CRTR_SESSION_ID'] = parsed.session_id;
            process.env['CRTR_JOB_ID'] = parsed.job_id;
            process.env['CRTR_SESSION_CWD'] = process.cwd();
          }
        }
      } catch {
        /* best-effort; crtr agent new self-heals when piSessionId is available */
      }
    }
  });
  pi.on('turn_end', captureCtx);
  pi.on('agent_start', (_e: any, ctx: any) => {
    captureCtx(_e, ctx);
    streaming = true;
  });
  pi.on('agent_end', (_e: any, ctx: any) => {
    captureCtx(_e, ctx);
    streaming = false;
  });

  let seeded = false;
  let cursor = '';
  let pending: PendingCompletion[] = [];
  let lastArrival = 0;
  // Job ids collected out-of-band (a `collected` tombstone in the inbox, written
  // by `job read result` when it surfaces a terminal result). A completion whose
  // job is here was already shown to the orchestrator via the pull path, so the
  // push notice is suppressed — the two channels deliver exactly once between
  // them. Retained for the watcher's lifetime; job ids are tiny and low-volume.
  const collected = new Set<string>();

  const isIdle = (): boolean => {
    try {
      if (typeof lastCtx?.isIdle === 'function') return lastCtx.isIdle() === true;
    } catch {
      /* fall through */
    }
    return !streaming;
  };

  const flush = (): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const notice = renderNotice(batch);
    const anySteer = batch.some((p) => p.delivery === 'steer');
    try {
      if (isIdle()) {
        // Idle → trigger a turn immediately (sendUserMessage always triggers).
        pi.sendUserMessage(notice);
      } else {
        // Mid-stream → steer (interrupt) only if requested, else follow up.
        pi.sendUserMessage(notice, { deliverAs: anySteer ? 'steer' : 'followUp' });
      }
    } catch {
      // Re-queue on failure so a transient error doesn't drop the notice.
      pending = batch.concat(pending);
    }
  };

  const tick = (): void => {
    try {
      // Recompute the target every tick: the top-level inbox set GROWS as new
      // sessions are minted by each spawn (see Target). Inert until something
      // resolves (R8).
      const target = resolveTarget();
      if (target === null) return;
      if (!seeded) {
        // Seed durably (persisted file, else newest-session created) — NOT `now`
        // — so a completion that arrived before we resolved is still delivered
        // exactly once (spec R3 / acceptance #9). Read immediately on this tick.
        cursor = seedCursor(target);
        seeded = true;
      }

      // Union events across every inbox in the target, past the shared cursor.
      const events: { ts: string; event: string; from: string | null; data?: any }[] = [];
      for (const f of target.inboxFiles) events.push(...readSince(f, cursor));
      if (events.length > 0) {
        events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        // Advance the cursor past everything we've read (completed or not) so we
        // never re-inject an event (R3), and persist it for restart-safety.
        for (const ev of events) {
          if (ev.ts > cursor) cursor = ev.ts;
        }
        persistCursor(target, cursor);
        const eventJobId = (ev: { from: string | null; data?: any }): string =>
          typeof ev.from === 'string' && ev.from !== '' ? ev.from : String((ev.data ?? {}).job_id ?? 'unknown');
        // First absorb `collected` tombstones: record them and cancel any
        // not-yet-flushed `completed` still sitting in the debounce buffer.
        for (const ev of events) {
          if (ev.event !== 'collected') continue;
          collected.add(eventJobId(ev));
        }
        if (collected.size > 0) pending = pending.filter((p) => !collected.has(p.jobId));
        for (const ev of events) {
          if (ev.event !== 'completed') continue;
          const jobId = eventJobId(ev);
          if (collected.has(jobId)) continue; // already surfaced via the pull path
          const d = ev.data ?? {};
          pending.push({
            jobId,
            name: typeof d.name === 'string' ? d.name : '',
            status: typeof d.status === 'string' ? d.status : 'done',
            delivery: d.delivery === 'steer' ? 'steer' : 'followUp',
          });
        }
        if (pending.length > 0) lastArrival = Date.now();
      }

      // Coalesce: flush only once the burst has settled (no new arrival within
      // DEBOUNCE_MS) so near-simultaneous completions become one injection (R5).
      if (pending.length > 0 && Date.now() - lastArrival >= DEBOUNCE_MS) {
        flush();
      }
    } catch {
      /* watcher is best-effort; never crash the host session */
    }
  };

  // Clear any timer left over from a prior init (pi ignores returned disposers,
  // so /reload would otherwise stack watchers — the double-notify bug).
  if (liveTimer !== undefined) clearInterval(liveTimer);
  const timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  // pi DOES fire session_shutdown, unlike the ignored factory return value — use
  // it as the authoritative teardown so a re-init never finds a live sibling.
  pi.on('session_shutdown', () => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
  });

  // Returned for testability + clean teardown. pi ignores an extension
  // factory's return value, so this is a no-op there — the guard above is what
  // actually prevents stacking.
  return () => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
  };
}

// Exported for unit tests; not part of the pi extension contract.
export const __testing = { resolveTarget, renderNotice, readSince, sanitizeNodeId, mangleCwd, TICK_MS, DEBOUNCE_MS };
