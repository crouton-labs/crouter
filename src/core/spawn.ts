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

/** Count panes in a tmux window (0 outside tmux / on error). With `targetPane`,
 *  counts the window THAT pane lives in (the placement decision must reflect the
 *  window the new pane will actually open into, not the caller's backstage one);
 *  without it, the caller's current window. */
export function countPanesInWindow(targetPane?: string): number {
  const args =
    targetPane !== undefined && targetPane !== ''
      ? ['list-panes', '-t', targetPane, '-F', '#{pane_id}']
      : ['list-panes', '-F', '#{pane_id}'];
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

/** Back-compat alias: panes in the caller's current window. */
export function countPanesInCurrentWindow(): number {
  return countPanesInWindow();
}

/** Does this tmux pane id still exist? `display-message` EXITS 0 with EMPTY
 *  output on an unresolvable pane, so test for non-empty stdout, not just `.ok`.
 *  False outside tmux / on error. */
export function paneAlive(pane: string): boolean {
  if (!isInTmux() || !/^%\d+$/.test(pane)) return false;
  const r = spawnSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() !== '';
}

/** Resolve a tmux pane id to its `session:window_index` — the target form
 *  `new-window -t` accepts. tmux REJECTS a pane id for new-window ("can't
 *  specify pane here"); only split-window -t takes a pane. null outside tmux /
 *  on a bad pane id / on error / empty. */
export function paneWindowTarget(pane: string): string | null {
  if (!isInTmux() || !/^%\d+$/.test(pane)) return null;
  const r = spawnSync(
    'tmux',
    ['display-message', '-p', '-t', pane, '#{session_name}:#{window_index}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  const t = r.stdout.trim();
  return t !== '' ? t : null;
}

/** The active pane of the user's attached tmux client — where they are looking
 *  right now. `list-clients` first attached client, then its current pane. Used
 *  to surface a human prompt in the user's view when nothing in the asking
 *  node's graph is focused. null outside tmux / no client / on error. */
export function attachedClientPane(): string | null {
  if (!isInTmux()) return null;
  const clients = spawnSync('tmux', ['list-clients', '-F', '#{client_name}'], {
    encoding: 'utf8',
  });
  if (clients.status !== 0) return null;
  const name = clients.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (name === undefined) return null;
  const pane = spawnSync('tmux', ['display-message', '-p', '-c', name, '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (pane.status !== 0) return null;
  const id = pane.stdout.trim();
  return id !== '' ? id : null;
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
  /** Pass tmux `-d` to new-window so CREATING the window never switches the
   *  attached client to it (split-window already leaves the client's view put).
   *  The prompt lands in the target session/window without jumping the user out
   *  of what they are looking at. No effect on split-h/split-v. */
  detached?: boolean;
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
    if (opts.detached === true) splitArgs.push('-d'); // don't switch the client to it
    if (opts.targetPane !== undefined && opts.targetPane !== '') {
      // new-window -t REJECTS a pane id (tmux exits 1: "can't specify pane
      // here") — only split-window -t accepts a pane. Resolve the target pane to
      // its session:window first; -a then inserts the new window right after it.
      // If the pane can't be resolved, fall back to no -t (tmux uses current).
      const winTarget = paneWindowTarget(opts.targetPane);
      if (winTarget !== null) splitArgs.push('-a', '-t', winTarget);
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
