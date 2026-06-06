// Tmux pane detach helpers.
//
// A small set of tmux primitives used by the `human` command tree to put the
// humanloop TUI in a detached pane: spawnAndDetach (open a pane running a given
// command), countPanesInCurrentWindow (placement decision), plus shellQuote and
// isInTmux. The canvas runtime has its own one-window-per-node machinery in
// core/runtime/tmux.ts; this module is only the pane-split path the human TUI
// needs.

import { spawnSync } from 'node:child_process';

export function isInTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Count panes in the current tmux window (0 outside tmux / on error). */
export function countPanesInCurrentWindow(): number {
  const result = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * Schedule a kill-pane on the *current* tmux pane after `delaySeconds`, detached
 * so the caller can return normally before the pane dies. No-op outside tmux,
 * when TMUX_PANE is unset, or when delaySeconds <= 0.
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

export interface DetachOptions {
  /** Inner command to run in the new pane. */
  command: string;
  cwd: string;
  /** Optional id injected as the CRTR_JOB_ID env var in the pane. */
  jobId?: string;
  /** Where to open the new pane. */
  placement: 'split-h' | 'split-v' | 'new-window';
  /** Seconds before killing the originating pane so the caller can finish. */
  killAfterSeconds: number;
  /** Pin the new pane to this tmux pane: split-window splits it; new-window is
   *  inserted immediately after its window (-a -t <pane>). Without this, tmux
   *  uses the attached client's currently-focused pane — which drifts if the
   *  user switches windows between kickoff and spawn. */
  targetPane?: string;
}

export interface DetachResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  paneId?: string;
  message: string;
}

/**
 * Fire-and-forget: launch `opts.command` in a new pane (or window), then
 * schedule the originating pane to be killed after `killAfterSeconds`. Returns
 * as soon as the new pane is up; does NOT wait for the command to finish.
 */
export function spawnAndDetach(opts: DetachOptions): DetachResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'handoff requires tmux (TMUX env var not set)',
    };
  }

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
  splitArgs.push(opts.command);

  const split = spawnSync('tmux', splitArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? 'tmux split-window/new-window failed' : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  // Force `remain-on-exit off` at PANE scope on the new pane. remain-on-exit is
  // a pane option (tmux 3.x) inherited from the window-scoped value, and the
  // canvas runtime arms `remain-on-exit on` on a node's vehicle/focus WINDOW
  // (F3 freeze, see runtime/tmux.ts setRemainOnExit). A split-window pane opened
  // into that window inherits the `on`, so the humanloop TUI pane would linger
  // as a dead pane ("pane is dead (status 0, …)") when `crtr human _run` exits 0
  // instead of closing. Overriding at pane scope destroys this pane on clean
  // exit WITHOUT touching the window's value (focus freeze still works) or the
  // user's global config. Best-effort: harmless no-op on tmux where the option
  // is window-only.
  if (paneId !== '') {
    spawnSync('tmux', ['set-option', '-p', '-t', paneId, 'remain-on-exit', 'off'], {
      stdio: 'ignore',
    });
  }

  // Schedule self-kill of the originating pane.
  scheduleKillCurrentPane(opts.killAfterSeconds);

  return {
    status: 'spawned',
    paneId,
    message: `handed off to pane ${paneId}`,
  };
}
