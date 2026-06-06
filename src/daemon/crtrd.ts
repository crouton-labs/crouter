// crtrd — the thin supervisor daemon. One instance per canvas.
//
// Sole responsibility: supervise tmux window exit and revive nodes. No
// orchestration logic lives here. The daemon is a process-lifecycle watcher.
//
// Model (v3: liveness is PANE-existence, not window-existence — a manual
// move-pane/join-pane/break-pane must never read as a node death)
//   • Poll every intervalMs (default 2000ms).
//   • For each active|idle node: check whether its tmux PANE is still alive
//     (isNodePaneAlive; window-existence is only a legacy/no-pane fallback).
//   • Pane alive → reconcile its LOCATION (follow any manual move; lazy-backfill
//     a legacy row's pane), then judge pi liveness — healthy, skip otherwise.
//   • Pane gone + intent==='refresh' → fresh respawn (node asked to yield).
//   • Pane gone + intent==='idle-release' → node freed its own pane while
//     dormant; clear the stale window ref and revive (resume) when its inbox
//     gains an unseen entry.
//   • Pane gone + any other intent → route on what the node was doing:
//       - never-booted (pi_session_id null) → crash ('dead') + surface boot fail
//       - mid-generation (busy marker present) → crash ('dead')
//       - finished its turn, still awaiting a live child → crash ('dead'), for now
//       - finished its turn, awaiting nothing live → finalize ('done')
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
  getRow,
  setPresence,
  getNode,
  hasActiveLiveSubscription,
  type NodeRow,
  type NodeMeta,
} from '../core/canvas/index.js';
import { transition } from '../core/runtime/lifecycle.js';
import { isBusy } from '../core/runtime/busy.js';
import { isNodePaneAlive, reconcile } from '../core/runtime/placement.js';
import { reviveNode } from '../core/runtime/revive.js';
import { pushUrgent } from '../core/feed/feed.js';
import { readInboxSince, readCursor } from '../core/feed/inbox.js';

/** Surface a vehicle that never booted.
 *
 *  `spawnChild` returns status="active" the instant the tmux window opens — it
 *  does NOT wait for pi to come up, because boot is inherently slow (and slower
 *  under load) and racing it would either block the spawner or false-fail a
 *  slow-but-healthy launch. The cost of that optimism: a pi that dies before its
 *  first session_start (so `pi_session_id` was never recorded) is invisible —
 *  the parent believes its child is running. When the daemon later finds the
 *  pane gone with no session ever bound, it errors LOUDLY up the spine: an
 *  urgent push so the parent learns the child failed to launch instead of just
 *  seeing a silent `dead`. */
async function surfaceBootFailure(meta: NodeMeta): Promise<void> {
  const body =
    `⚠ Spawn failed — \`${meta.name}\` (${meta.kind}) never started.\n\n` +
    `Its pi vehicle exited before the session came up (no pi_session_id was ever ` +
    `recorded), so the node produced no output. This is almost always a transient ` +
    `launch failure — e.g. resource pressure when several nodes boot at once — not ` +
    `a fault in the task itself.\n\n` +
    `If the work still needs doing, re-spawn it; if spawns keep dying, spawn fewer at a time.`;
  await pushUrgent(meta.node_id, body, { from: meta.node_id });
}

const DEFAULT_INTERVAL_MS = 2000;

// How long a node's pi may be observed dead-while-its-window-lives before the
// daemon revives it. MUST exceed worst-case pi boot time: a normal in-place
// refresh (reviveInPlace) transiently shows a dead OLD pid for the gap between
// the old pi dying and the fresh pi booting + re-recording its pid, and we must
// not double-spawn into that gap.
const REVIVE_GRACE_MS = 20_000;

// Per-node first-observed-dead timestamps, for the grace window above. In-memory
// only — a daemon restart resets it (worst case: one extra grace interval).
const unhealthySince = new Map<string, number>();

export type LivenessVerdict = 'leave' | 'pending' | 'revive';

/** Decide what to do with a node whose tmux pane is alive, from its pi
 *  liveness and how long it's been dead. Pure — the time-and-tmux side effects
 *  live in handleLiveWindow; this is the unit-testable core.
 *    piPidAlive: true=alive, false=dead, null=no pid recorded (legacy node, or a
 *      relaunch in flight) — leave those to the pane-gone pass.
 *    deadFor: ms since first observed dead, or null on the first observation. */
export function livenessVerdict(piPidAlive: boolean | null, deadFor: number | null): LivenessVerdict {
  if (piPidAlive !== false) return 'leave';
  if (deadFor === null || deadFor < REVIVE_GRACE_MS) return 'pending';
  return 'revive';
}

/** A node whose tmux PANE is alive: pane-existence does NOT prove pi is
 *  alive (an inline root runs pi under a persistent login shell that survives
 *  pi's death), so gauge liveness on the recorded pid and revive a dead pi once
 *  it's been dead past the grace window. */
function handleLiveWindow(row: NodeRow, now: number): void {
  const id = row.node_id;
  // A deliberately-frozen focused-dormant node (intent=idle-release) keeps its
  // pane alive via remain-on-exit (F3, §3c). Do NOT grace-revive it here — it is
  // waiting for a worker's inbox push, which the second pass delivers. Grace-
  // reviving would pre-empt that and churn the frozen focus pane.
  if (row.intent === 'idle-release') {
    unhealthySince.delete(id);
    return;
  }
  const pid = row.pi_pid;
  const piPidAlive = pid == null ? null : isPidAlive(pid);

  if (piPidAlive !== false) {
    unhealthySince.delete(id); // alive, or no pid to judge — nothing pending
    return;
  }

  const since = unhealthySince.get(id);
  const verdict = livenessVerdict(piPidAlive, since === undefined ? null : now - since);
  if (verdict === 'pending') {
    if (since === undefined) unhealthySince.set(id, now);
    return;
  }

  // 'revive' — pi has been dead past the grace window while its window lived on.
  unhealthySince.delete(id);
  // A refresh-yield wants fresh context (re-read the roadmap); any other death
  // resumes the saved conversation. reviveNode opens a fresh window and clears
  // pi_pid, so the next tick won't re-fire on this stale pid.
  const resume = row.intent !== 'refresh';
  process.stderr.write(
    `[crtrd] revive ${id} (pi dead, pane alive, intent=${String(row.intent)})\n`,
  );
  reviveNode(id, { resume });
}

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

/** True if a process with `pid` is currently alive (signal-0 probe). `kill(pid,
 *  0)` throws ESRCH when the process is gone; EPERM means it exists but isn't
 *  ours — still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
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

export async function superviseTick(now: number = Date.now()): Promise<void> {
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
      // Runtime (tmux_session, window, intent, pi_pid) is now authoritative IN
      // the row — no per-node getNode re-read. Only the boot-failure split below
      // still needs identity (pi_session_id), read on demand there.

      // Nodes with no tmux placement at all are inline roots — not daemon-
      // managed. Pane-anchored: a node still counts as placed if it has a pane
      // even when its derived window/session cache is null.
      if (row.tmux_session == null && row.window == null && row.pane == null) continue;

      if (isNodePaneAlive(row)) {
        // The pane is up — but that alone doesn't mean pi is. Reconcile first
        // (follow any manual pane move, and lazy-backfill a legacy row's pane
        // from its live window), then judge pi liveness off the fresh row. The
        // alive-gate means reconcile here only ever FOLLOWS/backfills — never
        // nulls the LOCATION out from under the gone-branches below.
        reconcile(row.node_id);
        handleLiveWindow(getRow(row.node_id) ?? row, now);
        continue;
      }

      // The pane is gone. Branch on why.
      unhealthySince.delete(row.node_id); // pane-gone path owns it now
      if (row.intent === 'refresh') {
        // The node set intent=refresh before stopping — a clean yield. Respawn
        // fresh so it re-reads its roadmap/context dir.
        process.stderr.write(`[crtrd] revive ${row.node_id} (refresh-yield)\n`);
        reviveNode(row.node_id, { resume: false });
      } else if (row.intent === 'idle-release') {
        // The node freed its own window on purpose while dormant. Drop the stale
        // window ref and keep it 'idle'; the inbox-poll pass below revives it
        // (resume) the moment a subscribed worker delivers.
        setPresence(row.node_id, { tmux_session: row.tmux_session, window: null });
      } else {
        // The pane vanished without the node yielding or releasing. Route on what
        // the node was DOING at pane-kill time — not every gone pane is a death:
        //   • never-booted (pi_session_id null) → crash + surface boot failure.
        //     A spawn failure the parent was never told about — it had no turn to
        //     finish, so it can never be a finalize. (Boot-failed vs crashed turns
        //     on pi_session_id, an IDENTITY field — the one place this pass still
        //     reads meta; surfaceBootFailure also wants name/kind for its message.)
        //   • MID-GENERATION (busy marker present) → crash (→dead). agent_start
        //     touched the marker and agent_end never cleared it ⇒ the pane was
        //     killed inside a turn: a genuine mid-run death. (The pane is gone, so
        //     pi is dead; we read isBusy WITHOUT the usual AND-pidAlive guard on
        //     purpose — here a stale marker IS the proof it died mid-turn.)
        //   • finished its turn (busy ABSENT) but still awaiting a LIVE child →
        //     crash (→dead) for now. (This waiting-on-a-live-child case may later
        //     route to a revivable-idle instead of a hard death.)
        //   • finished its turn AND awaiting nothing live → finalize (→done): it
        //     did its own work and the pane was closed to dismiss it.
        const meta = getNode(row.node_id);
        const neverBooted = meta !== null && meta.pi_session_id == null;
        if (
          !neverBooted &&
          !isBusy(row.node_id) &&
          !hasActiveLiveSubscription(row.node_id)
        ) {
          transition(row.node_id, 'finalize');
          process.stderr.write(
            `[crtrd] done ${row.node_id} (pane gone after turn end, no live child)\n`,
          );
        } else {
          transition(row.node_id, 'crash');
          if (neverBooted) {
            process.stderr.write(
              `[crtrd] boot-failed ${row.node_id} (pane gone before pi ever started)\n`,
            );
            try {
              await surfaceBootFailure(meta as NodeMeta);
            } catch (err) {
              process.stderr.write(
                `[crtrd] surfaceBootFailure ${row.node_id} error: ${(err as Error).message}\n`,
              );
            }
          } else {
            process.stderr.write(
              `[crtrd] dead ${row.node_id} (pane gone, intent=${String(row.intent)})\n`,
            );
          }
        }
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
      // Re-read the ROW for fresh runtime (the first pass may have mutated it);
      // no meta needed — status/intent/window/tmux_session all live in the row.
      const r = getRow(row.node_id);
      if (r === null) continue;
      if (r.status !== 'idle' || r.intent !== 'idle-release') continue;
      // The in-process inbox-watcher only owns delivery while pi is actually LIVE.
      // A frozen focused-dormant pane (remain-on-exit, F3) is pane-ALIVE but
      // pi-DEAD — no watcher — so the daemon must wake it. Gate the skip on pi
      // liveness, NOT pane presence (which would skip a frozen pane forever, §3c).
      if (r.pi_pid != null && isPidAlive(r.pi_pid)) continue;

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
