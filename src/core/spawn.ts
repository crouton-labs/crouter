// Tmux pane spawning machinery for crtr job subtree.
//
// Kept: spawnAgent (fire-and-forget new pane), spawnAndDetach (detach + kill originating pane),
//       shellQuote, isInTmux, countPanesInCurrentWindow, findWindowWithSpace.
//
// Removed: createSession, submitToSession, awaitSession, waitForResult,
//          sessionDirForId, writeSessionMeta, readSessionMeta — all superseded
//          by the jobs.ts sidecar model (result.json + log.jsonl).
//
// Crash detection: the wrapper shell command is:
//   `claude --dangerously-skip-permissions <prompt>; crtr job _fail <job_id>`
// If the worker calls `crtr job submit` before claude exits, result.json is
// written and `_fail` is a no-op (writeResult is idempotent for done status).
// If claude dies without a submit, `_fail` writes status 'failed'. Either way
// `job read result` sees a terminal result.json.

import { spawnSync } from 'node:child_process';

export interface SpawnAgentOptions {
  /** First user message for the new claude session. */
  prompt: string;
  cwd: string;
  /** crtr job_id injected as CRTR_JOB_ID env var in the pane. */
  jobId: string;
  /** If set, resume this Claude Code session with --fork-session (new session id). */
  fork?: { sessionId: string };
  /** Max panes per tmux window before overflowing to a new window. */
  maxPanesPerWindow: number;
  /** Display name passed to `claude -n`; surfaces in pane title and /resume picker. */
  name?: string;
}

export interface SpawnAgentResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  /** tmux pane id of the spawned pane. */
  paneId?: string;
  /** How the pane was placed. */
  placement?: 'split-window' | 'new-window';
  message: string;
}

export interface DetachOptions {
  /** Inner command to run in the pane. If omitted, build `claude … <prompt>`. */
  command?: string;
  /** Full first user message for the new claude session (claude mode only;
   *  ignored when `command` is set). No custom system prompt. */
  prompt?: string;
  cwd: string;
  /** crtr job_id injected as CRTR_JOB_ID env var in the pane and used by the
   *  `_fail` guard. Optional only when `failGuard` is false. */
  jobId?: string;
  /** Where to open the new pane. */
  placement: 'split-h' | 'split-v' | 'new-window';
  /** Seconds to wait before killing the originating pane so the caller can finish. */
  killAfterSeconds: number;
  /** Append `; crtr job _fail <jobId>` and inject CRTR_JOB_ID. Default true. */
  failGuard?: boolean;
  /** Pin the new pane to this tmux pane: split-window splits it; new-window is
   *  inserted immediately after its window (-a -t <pane>). Without this, tmux
   *  uses the attached client's currently-focused pane — which drifts if the
   *  user switches windows between kickoff and spawn. */
  targetPane?: string;
  /** Display name passed to `claude -n`; ignored when `command` is set
   *  (caller controls the full argv in that mode). */
  name?: string;
}

export interface DetachResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  paneId?: string;
  message: string;
}

export function isInTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function countPanesInCurrentWindow(): number {
  const result = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

interface WindowInfo {
  windowId: string;
  paneCount: number;
  isActive: boolean;
}

function listWindowsInCurrentSession(): WindowInfo[] {
  const result = spawnSync(
    'tmux',
    ['list-windows', '-F', '#{window_id} #{window_panes} #{window_active}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [id, count, active] = line.split(' ');
      return {
        windowId: id,
        paneCount: Number.parseInt(count, 10),
        isActive: active === '1',
      };
    });
}

/**
 * Map of window_id → list of pane TTYs (basename, e.g. `ttys008`) for every
 * pane in the current tmux session. Used as the bridge between tmux's pane
 * model and the system process table for foreground-command lookup.
 *
 * tmux's `#{pane_current_command}` is unreliable on macOS because the Claude
 * Code CLI sets `process.title` to its version (e.g. `2.1.143`), which is what
 * tmux then reports. Going through the TTY + `ps` gives us the real binary
 * name (`claude`) from the kernel.
 */
function paneTtysByWindow(): Map<string, string[]> {
  const result = spawnSync(
    'tmux',
    ['list-panes', '-s', '-F', '#{window_id} #{pane_tty}'],
    { encoding: 'utf8' },
  );
  const out = new Map<string, string[]>();
  if (result.status !== 0) return out;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const windowId = line.slice(0, idx);
    const tty = line.slice(idx + 1);
    const ttyBase = tty.startsWith('/dev/') ? tty.slice(5) : tty;
    const existing = out.get(windowId);
    if (existing === undefined) {
      out.set(windowId, [ttyBase]);
    } else {
      existing.push(ttyBase);
    }
  }
  return out;
}

/**
 * Map of tty basename → set of foreground process `comm` names on that tty.
 * A process is "foreground" if its STAT field includes `+` (member of the
 * terminal's foreground process group). Built from one `ps -axo ...` call.
 */
function foregroundCommsByTty(): Map<string, Set<string>> {
  const result = spawnSync('ps', ['-axo', 'stat=,comm=,tty='], { encoding: 'utf8' });
  const out = new Map<string, Set<string>>();
  if (result.status !== 0) return out;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const m = line.match(/^(\S+)\s+(.+?)\s+(\S+)\s*$/);
    if (m === null) continue;
    const [, stat, comm, tty] = m;
    if (!stat.includes('+')) continue;
    if (tty === '??' || tty === '?') continue;
    const existing = out.get(tty);
    if (existing === undefined) {
      out.set(tty, new Set<string>([comm.trim()]));
    } else {
      existing.add(comm.trim());
    }
  }
  return out;
}

/**
 * Find a window in the current tmux session with fewer than `maxPanesPerWindow`
 * panes AND where every existing pane has `claude` as a foreground process.
 * Prefers the active window so the spawned pane is visible to the user;
 * otherwise falls back to the first other eligible window. Returns the tmux
 * window id (e.g. `@5`) to pass via `-t`, or null if no window qualifies.
 *
 * Windows holding non-agent panes (dashboards, log tails, idle shells, editors,
 * REPLs, etc.) are skipped so spawning never disrupts those workflows. A pane
 * qualifies as long as `claude` is among its foreground commands — co-resident
 * helpers like `caffeinate` don't disqualify it.
 */
export function findWindowWithSpace(maxPanesPerWindow: number): string | null {
  const windows = listWindowsInCurrentSession();
  const ttysByWindow = paneTtysByWindow();
  const fgByTty = foregroundCommsByTty();
  const isClaudeOnly = (windowId: string): boolean => {
    const ttys = ttysByWindow.get(windowId);
    if (ttys === undefined || ttys.length === 0) return false;
    return ttys.every((tty) => fgByTty.get(tty)?.has('claude') === true);
  };
  const eligible = windows.filter(
    (w) => w.paneCount < maxPanesPerWindow && isClaudeOnly(w.windowId),
  );
  const active = eligible.find((w) => w.isActive);
  if (active !== undefined) return active.windowId;
  const first = eligible[0];
  if (first === undefined) return null;
  return first.windowId;
}

/**
 * Schedule a kill-pane on the *current* tmux pane after `delaySeconds`, detached
 * so the caller can return normally before the pane dies. No-op outside tmux
 * or when TMUX_PANE is unset.
 *
 * Used by `crtr job submit` (kill_pane=true) so a reviewer agent can self-close
 * its pane after delivering its verdict, and by `spawnAndDetach` for handoff
 * self-kill.
 */
export function scheduleKillCurrentPane(delaySeconds: number): boolean {
  const currentPane = process.env.TMUX_PANE;
  if (currentPane === undefined || currentPane === '' || delaySeconds <= 0) {
    return false;
  }
  const killCmd = `sleep ${delaySeconds}; tmux kill-pane -t ${currentPane}`;
  spawnSync('sh', ['-c', `nohup sh -c ${shellQuote(killCmd)} </dev/null >/dev/null 2>&1 &`], {
    stdio: 'ignore',
  });
  return true;
}

/**
 * Build the wrapper shell command passed to the tmux pane.
 *
 * Pattern: `claude <args>; crtr job _fail <job_id>`
 *
 * If the worker submits via `crtr job submit` before claude exits,
 * result.json is already written (`done`); `_fail` sees it and is a no-op.
 * If claude crashes/exits without submitting, `_fail` writes status `failed`
 * so `job read result` can distinguish completion from crash.
 */
function wrapperCmd(claudeCmd: string, jobId: string): string {
  return `${claudeCmd}; crtr job _fail ${shellQuote(jobId)}`;
}

/**
 * Fire-and-forget: launch an interactive `claude` in a new pane (or window),
 * then schedule the originating pane to be killed after `killAfterSeconds`.
 *
 * No custom system prompt — the task is delivered as the first user message.
 * Returns as soon as the new pane is up; does NOT wait for claude to finish.
 */
export function spawnAndDetach(opts: DetachOptions): DetachResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'handoff requires tmux (TMUX env var not set)',
    };
  }

  const buildClaudeInner = (): string => {
    const parts: string[] = ['claude'];
    if (opts.name !== undefined && opts.name !== '') {
      parts.push('-n', shellQuote(opts.name));
    }
    parts.push('--dangerously-skip-permissions', shellQuote(opts.prompt as string));
    return parts.join(' ');
  };
  const inner = opts.command !== undefined ? opts.command : buildClaudeInner();

  const useFailGuard = opts.failGuard !== false;
  const fullCmd = useFailGuard ? wrapperCmd(inner, opts.jobId as string) : inner;

  const splitArgs: string[] = [];
  if (opts.placement === 'new-window') {
    splitArgs.push('new-window');
    if (opts.targetPane !== undefined && opts.targetPane !== '') {
      // -a = insert after target window; -t <pane> resolves to that pane's window.
      splitArgs.push('-a', '-t', opts.targetPane);
    }
  } else {
    splitArgs.push('split-window');
    splitArgs.push(opts.placement === 'split-h' ? '-h' : '-v');
    if (opts.targetPane !== undefined && opts.targetPane !== '') {
      splitArgs.push('-t', opts.targetPane);
    }
  }
  splitArgs.push('-P', '-F', '#{pane_id}');
  splitArgs.push('-c', opts.cwd);
  if (opts.jobId !== undefined) {
    splitArgs.push('-e', `CRTR_JOB_ID=${opts.jobId}`);
  }
  splitArgs.push(fullCmd);

  const split = spawnSync('tmux', splitArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? 'tmux split-window/new-window failed' : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  // Schedule self-kill of the originating pane.
  scheduleKillCurrentPane(opts.killAfterSeconds);

  return {
    status: 'spawned',
    paneId,
    message: `handed off to pane ${paneId}; this pane will close in ${opts.killAfterSeconds}s`,
  };
}

/**
 * Async sibling spawn. Launches a claude session in a tmux pane, progressively
 * filling existing windows up to `maxPanesPerWindow` before creating a new
 * window. Returns immediately with the pane id; the parent stays alive.
 *
 * Placement order:
 *   1. Current window, if it has space.
 *   2. Any other window in the session with space.
 *   3. New window (every existing window at capacity).
 *
 * If `fork` is set, uses `claude --resume <id> --fork-session`.
 */
export function spawnAgent(opts: SpawnAgentOptions): SpawnAgentResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'crtr job requires tmux (TMUX env var not set)',
    };
  }

  const claudeParts: string[] = ['claude'];
  if (opts.name !== undefined && opts.name !== '') {
    claudeParts.push('-n', shellQuote(opts.name));
  }
  if (opts.fork !== undefined) {
    claudeParts.push('--resume', opts.fork.sessionId, '--fork-session');
  }
  claudeParts.push('--dangerously-skip-permissions', shellQuote(opts.prompt));
  const claudeCmd = claudeParts.join(' ');

  const fullCmd = wrapperCmd(claudeCmd, opts.jobId);

  const targetWindow = findWindowWithSpace(opts.maxPanesPerWindow);
  const placement: 'split-window' | 'new-window' =
    targetWindow === null ? 'new-window' : 'split-window';

  const tmuxArgs: string[] = [placement];
  if (placement === 'split-window') {
    tmuxArgs.push('-h', '-t', targetWindow as string);
  }
  tmuxArgs.push(
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    opts.cwd,
    '-e',
    `CRTR_JOB_ID=${opts.jobId}`,
    fullCmd,
  );

  const split = spawnSync('tmux', tmuxArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? `tmux ${placement} failed` : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  // Re-balance the target window's panes evenly so the new pane doesn't end up
  // half the size of its siblings. -t <pane_id> resolves to the window it lives
  // in for both placements (split + new-window).
  spawnSync('tmux', ['select-layout', '-t', paneId, 'even-horizontal'], {
    encoding: 'utf8',
  });

  return {
    status: 'spawned',
    paneId,
    placement,
    message: `agent spawned in pane ${paneId} (${placement})`,
  };
}

