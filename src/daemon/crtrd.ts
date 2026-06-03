// crtrd — the thin supervisor daemon. One instance per canvas.
//
// Sole responsibility: supervise tmux window exit and revive nodes. No
// orchestration logic lives here. The daemon is a process-lifecycle watcher.
//
// Model
//   • Poll every intervalMs (default 2000ms).
//   • For each active|idle node: check whether its tmux window is still alive.
//   • Window alive → healthy, skip.
//   • Window gone + intent==='refresh' → fresh respawn (node asked to yield).
//   • Window gone + intent==='idle-release' → node freed its own pane while
//     dormant; clear the stale window ref and revive (resume) when its inbox
//     gains an unseen entry.
//   • Window gone + any other intent → crash: mark 'dead'.
//   • Nodes with no tmux placement (inline roots) are skipped.
//
// Single-instance guarantee
//   A PID file at crtrHome()/crtrd.pid prevents double-runs. On start, if the
//   file exists and the recorded pid is alive, we refuse to start (exit 0).
//   On stop (SIGINT/SIGTERM/exit) we remove the file.

import {
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { crtrHome } from '../core/canvas/paths.js';
import {
  listNodes,
  setStatus,
  getNode,
  updateNode,
  type NodeRow,
} from '../core/canvas/index.js';
import { windowAlive } from '../core/runtime/tmux.js';
import { reviveNode } from '../core/runtime/revive.js';
import { readInboxSince, readCursor } from '../core/feed/inbox.js';

const DEFAULT_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Pidfile
// ---------------------------------------------------------------------------

function pidfilePath(): string {
  return join(crtrHome(), 'crtrd.pid');
}

function writePidfile(): void {
  // Ensure the canvas home exists before writing.
  mkdirSync(crtrHome(), { recursive: true });
  writeFileSync(pidfilePath(), String(process.pid), 'utf8');
}

function removePidfile(): void {
  try {
    rmSync(pidfilePath());
  } catch {
    // Already gone — nothing to do.
  }
}

/** Read the pid stored in the pidfile, or null if absent / malformed. */
export function readPidfile(): number | null {
  const p = pidfilePath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True if a process with `pid` is currently alive (signal-0 probe). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when a crtrd process is already running (pidfile exists + pid alive). */
export function isDaemonRunning(): boolean {
  const pid = readPidfile();
  return pid !== null && isPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Supervisor tick
// ---------------------------------------------------------------------------

async function superviseTick(): Promise<void> {
  let rows: NodeRow[];
  try {
    rows = listNodes({ status: ['active', 'idle'] });
  } catch (err) {
    process.stderr.write(
      `[crtrd] listNodes error: ${(err as Error).message}\n`,
    );
    return;
  }

  for (const row of rows) {
    try {
      // listNodes returns the lightweight NodeRow; we need the full NodeMeta
      // for tmux_session, window, intent, and pi_session_id.
      const meta = getNode(row.node_id);
      if (meta === null) continue; // vanished between list and get

      // Nodes without tmux placement are inline roots — not daemon-managed.
      if (meta.tmux_session == null || meta.window == null) continue;

      if (windowAlive(meta.tmux_session, meta.window)) continue; // healthy

      // Window is gone. Branch on why.
      if (meta.intent === 'refresh') {
        // The node set intent=refresh before stopping — a clean yield. Respawn
        // fresh so it re-reads its roadmap/context dir.
        process.stderr.write(`[crtrd] revive ${row.node_id} (refresh-yield)\n`);
        reviveNode(row.node_id, { resume: false });
      } else if (meta.intent === 'idle-release') {
        // The node freed its own window on purpose while dormant. Drop the stale
        // window ref and keep it 'idle'; the inbox-poll pass below revives it
        // (resume) the moment a subscribed worker delivers.
        updateNode(row.node_id, { window: null });
      } else {
        // Window vanished without the node completing or refreshing — a crash.
        process.stderr.write(
          `[crtrd] dead ${row.node_id} (window gone, intent=${String(meta.intent)})\n`,
        );
        setStatus(row.node_id, 'dead');
      }
    } catch (err) {
      // One bad node must never kill the loop.
      process.stderr.write(
        `[crtrd] error supervising ${row.node_id}: ${(err as Error).message}\n`,
      );
    }
  }

  // Second pass: revive idle-released nodes whose inbox has unseen entries.
  // The in-process inbox-watcher dies with pi, so the daemon owns wake-on-message
  // for dormant nodes. readCursor is the cursor the watcher persisted before
  // exit; any entry past it is undelivered work — resume the node to handle it.
  for (const row of rows) {
    try {
      const meta = getNode(row.node_id);
      if (meta === null) continue;
      if (meta.status !== 'idle' || meta.intent !== 'idle-release') continue;
      // If a window is somehow alive, the in-process watcher owns delivery.
      if (meta.window != null && windowAlive(meta.tmux_session ?? '', meta.window)) {
        continue;
      }

      const entries = readInboxSince(row.node_id, readCursor(row.node_id));
      if (entries.length > 0) {
        process.stderr.write(`[crtrd] revive ${row.node_id} (idle-release, inbox)\n`);
        reviveNode(row.node_id, { resume: true });
      }
    } catch (err) {
      process.stderr.write(
        `[crtrd] error polling inbox ${row.node_id}: ${(err as Error).message}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// runDaemon — the public entry point
// ---------------------------------------------------------------------------

export interface DaemonOpts {
  /** Milliseconds between supervision polls. Default 2000. */
  intervalMs?: number;
}

/** Start the supervisor loop.
 *
 *  If a live crtrd is already running (pidfile + pid alive), exits immediately
 *  (exit 0 — idempotent, not an error). Otherwise, writes the pidfile, sets up
 *  signal handlers, and enters the poll loop.
 *
 *  Returns a teardown callback that stops the loop and removes the pidfile.
 *  (Mainly useful for tests; in production the daemon runs until signaled.) */
export function runDaemon(opts: DaemonOpts = {}): () => void {
  if (isDaemonRunning()) {
    const pid = readPidfile();
    process.stderr.write(`[crtrd] already running (pid ${pid ?? '?'})\n`);
    process.exit(0);
  }

  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  writePidfile();

  process.stderr.write(
    `[crtrd] started (pid ${process.pid}, interval ${interval}ms)\n`,
  );

  let running = true;

  // Cleanup — idempotent.
  const cleanup = (): void => {
    removePidfile();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', () => {
    cleanup();
  });

  // Recursive setTimeout keeps ticks sequential and avoids overlap on slow
  // canvases (a timer that fires while a prior tick is awaiting is dropped).
  const scheduleTick = (): void => {
    if (!running) return;
    superviseTick()
      .catch((err: unknown) => {
        process.stderr.write(
          `[crtrd] tick error: ${(err as Error).message}\n`,
        );
      })
      .finally(() => {
        if (running) setTimeout(scheduleTick, interval);
      });
  };

  const initialTimer = setTimeout(scheduleTick, interval);

  return (): void => {
    running = false;
    clearTimeout(initialTimer);
    cleanup();
  };
}

export default runDaemon;
