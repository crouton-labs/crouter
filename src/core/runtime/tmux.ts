// tmux placement — one window per active node.
//
//   session = a root        window = a node        window 0 = optional dashboard
//
// Background windows run but don't render — only the current window draws. That
// is the "detached but switchable" model: nothing tiles, you never see a node's
// UI unless you switch to it. Bring one forefront with select-window (within a
// root) or switch-client + select-window (across roots). done/dead nodes close
// their window; reviving opens a fresh one.

import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Shell quoting + tmux invocation
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

export function inTmux(): boolean {
  return process.env['TMUX'] !== undefined && process.env['TMUX'] !== '';
}

/** The single, shared tmux session that ALL canvas node windows live in.
 *  Overridable with CRTR_NODE_SESSION (default `crtr`). Every root and every
 *  child opens a window here rather than cluttering the user's own working
 *  session — switch to it to browse the whole live graph, ignore it otherwise. */
export function nodeSession(): string {
  const v = process.env['CRTR_NODE_SESSION'];
  return v !== undefined && v !== '' ? v : 'crtr';
}

export interface TmuxLocation {
  session: string;
  window: string;
  pane: string;
}

/** Where the caller currently is, or null if not inside tmux. */
export function currentTmux(): TmuxLocation | null {
  if (!inTmux()) return null;
  const r = tmux([
    'display-message',
    '-p',
    '#{session_name}\t#{window_id}\t#{pane_id}',
  ]);
  if (!r.ok) return null;
  const [session, window, pane] = r.stdout.split('\t');
  return { session, window, pane };
}

// ---------------------------------------------------------------------------
// Sessions + windows
// ---------------------------------------------------------------------------

export function sessionExists(name: string): boolean {
  return tmux(['has-session', '-t', name]).ok;
}

/** Create a detached session rooted at `cwd` if it doesn't exist. The session
 *  name is a root's tmux home; every node under that root is a window in it. */
export function ensureSession(name: string, cwd: string): void {
  if (sessionExists(name)) return;
  tmux(['new-session', '-d', '-s', name, '-c', cwd]);
}

function envFlags(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) out.push('-e', `${k}=${v}`);
  return out;
}

export interface OpenWindowOpts {
  session: string;
  /** Window name (the node's display name). */
  name: string;
  cwd: string;
  env: Record<string, string>;
  /** The full command to run in the window (already a shell string). */
  command: string;
}

/** Open a background window for a node and run `command` in it. `-d` keeps it
 *  detached so it doesn't steal focus or become the current window. Returns the
 *  new window id.
 *
 *  Target is `${session}:` (trailing colon = the session, no window index) plus
 *  `-a` (insert after the current window) so tmux allocates the next free index.
 *  Passing a bare session name resolves to the session's *active window*, which
 *  makes new-window try to create AT that occupied index and fail with
 *  "create window failed: index N in use" whenever the active window is not the
 *  last one (common when base-index is 0 but the live window sits at index 1).
 *  `-a` also keeps node windows off index 0, which is reserved for the optional
 *  dashboard. */
export function openNodeWindow(opts: OpenWindowOpts): string | null {
  const r = tmux([
    'new-window',
    '-d',
    '-a',
    '-P',
    '-F',
    '#{window_id}',
    '-t',
    `${opts.session}:`,
    '-n',
    opts.name,
    '-c',
    opts.cwd,
    ...envFlags(opts.env),
    opts.command,
  ]);
  return r.ok ? r.stdout : null;
}

/** Open a background window running a plain login shell (no pi) and return its
 *  window + pane ids. Used by demote: the agent's pi is swapped OUT into this
 *  window's slot and the shell is swapped INTO the caller's pane. `-a` keeps it
 *  off index 0 (reserved for a dashboard), `-d` keeps it from stealing focus. */
export function openShellWindow(opts: { session: string; name: string; cwd: string }):
  { window: string; pane: string } | null {
  const r = tmux([
    'new-window', '-d', '-a', '-P',
    '-F', '#{window_id}\t#{pane_id}',
    '-t', `${opts.session}:`,
    '-n', opts.name,
    '-c', opts.cwd,
  ]);
  if (!r.ok) return null;
  const [window, pane] = r.stdout.split('\t');
  if (window === undefined || pane === undefined) return null;
  return { window, pane };
}

/** Bring a node's window forefront. Switches client across roots when needed. */
export function focusWindow(session: string, window: string): boolean {
  const here = currentTmux();
  const sameRoot = here?.session === session;
  if (!sameRoot) {
    if (!tmux(['switch-client', '-t', session]).ok) return false;
  }
  return tmux(['select-window', '-t', window]).ok;
}

/** Close a node's window (drop it from the UI). */
export function closeWindow(window: string): boolean {
  return tmux(['kill-window', '-t', window]).ok;
}

/** The active pane id of a window. Node windows are single-pane, so this is the
 *  node's pane. Returns null if the window is gone or tmux fails. */
export function paneOfWindow(session: string, window: string): string | null {
  const r = tmux(['display-message', '-p', '-t', `${session}:${window}`, '#{pane_id}']);
  return r.ok && r.stdout !== '' ? r.stdout : null;
}

/** The window a pane currently lives in. Used after a swap-pane to learn which
 *  slot the caller's pane occupied — pane ids are stable across swaps, windows
 *  are not, so the node→window mapping must be re-derived from the pane. Returns
 *  null if the pane is gone or tmux fails. */
export function windowOfPane(pane: string): string | null {
  const r = tmux(['display-message', '-p', '-t', pane, '#{window_id}']);
  return r.ok && r.stdout !== '' ? r.stdout : null;
}

/** Swap `targetPane` into `callerPane`'s layout slot, IN PLACE. `-d` keeps the
 *  caller's window active, so the target's pane appears where the caller is
 *  rather than navigating the client off to the target's window. The caller's
 *  old pane lives on in the target's former window — the move is reversible
 *  (focusing back swaps it in again). Best-effort; never throws. */
export function swapPaneInPlace(targetPane: string, callerPane: string): boolean {
  if (targetPane === callerPane) return true;
  return tmux(['swap-pane', '-d', '-s', targetPane, '-t', callerPane]).ok;
}

export interface RespawnPaneOpts {
  /** Target pane id (e.g. `%3`) — the pane to re-exec in place. */
  pane: string;
  cwd: string;
  env: Record<string, string>;
  /** The full command to run in the pane (already a shell string). */
  command: string;
}

/** Re-exec a command in an EXISTING pane, in place. `-k` kills the pane's
 *  current process (e.g. a yielding pi) and starts `command` in the same pane
 *  — the window/pane survives, so an interactive session is never dropped to a
 *  shell and no window churns. Used by refresh-yield.
 *
 *  Spawned DETACHED (own process group, unref'd) so the request reaches the
 *  tmux server even though killing the pane tears down the caller's own pi.
 *  Returns true once the request was dispatched. */
export function respawnPane(opts: RespawnPaneOpts): boolean {
  try {
    const child = spawn(
      'tmux',
      [
        'respawn-pane',
        '-k',
        '-c',
        opts.cwd,
        ...envFlags(opts.env),
        '-t',
        opts.pane,
        opts.command,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// pi command assembly
// ---------------------------------------------------------------------------

/** Turn a pi argv array into a single shell command string. */
export function piCommand(argv: string[], binary = 'pi'): string {
  return [binary, ...argv.map(shellQuote)].join(' ');
}

// ---------------------------------------------------------------------------
// Window liveness helpers (used by the supervisor daemon)
// ---------------------------------------------------------------------------

/** List all window ids present in `session`. Returns [] if the session does
 *  not exist or tmux fails for any reason. Each entry is the raw window id
 *  string reported by tmux (e.g. `@1`, `@2`, …). */
export function listWindowIds(session: string): string[] {
  const r = tmux(['list-windows', '-t', session, '-F', '#{window_id}']);
  if (!r.ok || r.stdout === '') return [];
  return r.stdout.split('\n').filter((s) => s !== '');
}

/** True when both `session` and `window` are present (non-null/undefined) and
 *  the window currently exists inside the session. False whenever either arg
 *  is absent, the session is gone, or tmux does not know the window. */
export function windowAlive(
  session: string | null | undefined,
  window: string | null | undefined,
): boolean {
  if (session == null || window == null) return false;
  return listWindowIds(session).includes(window);
}

// ---------------------------------------------------------------------------
// Focus helpers (used by the presence layer)
// ---------------------------------------------------------------------------

/** Activate a window within its session (same-session navigation). Equivalent
 *  to `tmux select-window -t <session>:<window>`. Best-effort; never throws. */
export function selectWindow(session: string, window: string): boolean {
  return tmux(['select-window', '-t', `${session}:${window}`]).ok;
}

/** Switch the tmux client to a different session (cross-session focus). Runs
 *  `tmux switch-client -t <session>`. Best-effort; never throws. The caller is
 *  responsible for following up with selectWindow to land on the right window. */
export function switchClient(session: string): boolean {
  return tmux(['switch-client', '-t', session]).ok;
}

// ---------------------------------------------------------------------------
// Prefix menu — Alt+C opens a which-key-style tmux display-menu of crouter
// actions. Installed on the running server at root boot; idempotent (a re-bind
// overwrites the previous one). Items shell out to `crtr`, passing the active
// pane so an action targets the agent currently in front of you.
// ---------------------------------------------------------------------------

/** Bind Alt+C to the crouter action menu. Best-effort; false if tmux fails. */
export function installMenuBinding(): boolean {
  const sess = nodeSession();
  return tmux([
    'bind-key', '-n', 'M-c', 'display-menu',
    '-T', '#[align=centre] crtr ',
    // Anchor to the top-right of the pane it was called from (tmux clamps it
    // back on-screen) rather than centring on the whole terminal.
    '-x', '#{pane_right}', '-y', '#{pane_top}',
    'detach agent \u2192 background', 'd', `run-shell "crtr node demote --pane '#{pane_id}'"`,
    'browse background agents',       'g', `switch-client -t ${sess}`,
  ]).ok;
}
