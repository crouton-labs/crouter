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
import { readConfig } from '../config.js';

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

export interface SplitPaneOpts {
  /** The pane to split — the caller's current pane. */
  pane: string;
  cwd: string;
  env: Record<string, string>;
  /** The full command to run in the new pane (already a shell string). */
  command: string;
  /** 'h' → side-by-side (left/right); 'v' → stacked (top/bottom). Default 'h'. */
  direction?: 'h' | 'v';
}

/** Split `pane` and run `command` in the new ADJACENT pane, within the SAME
 *  window. Unlike openNodeWindow (which exiles the node to its own background
 *  window in the shared session), this keeps the new node BESIDE the caller so
 *  the two can be driven side-by-side. No `-d`, so split-window makes the new
 *  pane active — bringing the spawned node forefront. Returns the new pane id,
 *  or null if tmux fails. */
export function splitPane(opts: SplitPaneOpts): string | null {
  const dir = opts.direction === 'v' ? '-v' : '-h';
  const r = tmux([
    'split-window',
    dir,
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    opts.pane,
    '-c',
    opts.cwd,
    ...envFlags(opts.env),
    opts.command,
  ]);
  return r.ok ? r.stdout : null;
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

/** Close a single PANE. Its window closes automatically once this was the last
 *  pane, but sibling panes survive — so co-located nodes (several agents sharing
 *  one window via swap-pane focus) are torn down one at a time instead of all
 *  at once by a window kill. Pane ids are the stable vehicle handle; windows
 *  shift under swap-pane focus, so pane-granular teardown is the correct unit. */
export function closePane(pane: string): boolean {
  return tmux(['kill-pane', '-t', pane]).ok;
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

/** The session + window a pane currently lives in. Used by demote to place the
 *  recycled root's meta on the pane it respawns into. Null if tmux fails. */
export function paneLocation(pane: string): { session: string; window: string } | null {
  const r = tmux(['display-message', '-p', '-t', pane, '#{session_name}\t#{window_id}']);
  if (!r.ok) return null;
  const [session, window] = r.stdout.split('\t');
  if (session === undefined || session === '' || window === undefined || window === '') return null;
  return { session, window };
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
// Multi-pane layout (used by `canvas tmux-spread`)
// ---------------------------------------------------------------------------

/** Move a source pane into a destination window (`tmux join-pane`). The source
 *  pane's running process (e.g. a child's live pi) is preserved; its now-empty
 *  source window auto-closes. Best-effort; false if tmux fails. */
export function joinPane(srcPane: string, dstWindow: string): boolean {
  return tmux(['join-pane', '-s', srcPane, '-t', dstWindow]).ok;
}

/** Apply a named tmux layout to a window (`tmux select-layout`). Use
 *  `main-vertical` for one wide pane on the left + the rest stacked right.
 *  Best-effort; never throws. */
export function selectLayout(window: string, layout: string): boolean {
  return tmux(['select-layout', '-t', window, layout]).ok;
}

/** Set a tmux window option (`tmux set-window-option`). Used to size the main
 *  pane (`main-pane-width`) before a main-vertical layout. Best-effort. */
export function setWindowOption(window: string, name: string, value: string): boolean {
  return tmux(['set-window-option', '-t', window, name, value]).ok;
}

/** Type a literal (e.g. a `/graph` slash command) into a pane and press Enter
 *  (`tmux send-keys -t <pane> '<text>' Enter`). Requires the pane's editor be
 *  empty, same limitation as the menu's `/promote` item. Best-effort. */
export function sendKeysEnter(pane: string, text: string): boolean {
  return tmux(['send-keys', '-t', pane, text, 'Enter']).ok;
}

// ---------------------------------------------------------------------------
// Prefix menu — Alt+C opens a which-key-style tmux display-menu of crouter
// actions. Installed on the running server at root boot; idempotent (a re-bind
// overwrites the previous one). Items shell out to `crtr`, passing the active
// pane so an action targets the agent currently in front of you.
// ---------------------------------------------------------------------------

/** Reserved mnemonic keys owned by the built-in menu items below — a custom
 *  `prefixBind` may not claim these (the built-in item wins). */
const RESERVED_MENU_KEYS = new Set(['o', 'd', 'x', 'b']);

/** Bind Alt+C to the crouter action menu. Best-effort; false if tmux fails.
 *  The built-in items (promote/demote/close/browse) are static; the canvas-nav
 *  chords (graph/manager/expand/report-N + any custom prefixBind) are appended
 *  from `canvasNav.prefixBinds`, each routed through `crtr canvas chord` (or, for
 *  the `__graph__` sentinel, a `send-keys '/graph'`) so the menu stays static
 *  while behaviour is config-driven. */
export function installMenuBinding(): boolean {
  const sess = nodeSession();
  const title = ' crtr ';
  const items: Array<{ name: string; key: string; cmd: string }> = [
    // Promote types `/promote` into the agent's pane rather than shelling out:
    // the slash command delivers the orchestration guidance into the node's
    // context, which a bare `run-shell` (output discarded) could not.
    { name: 'promote to orchestrator',    key: 'o', cmd: `send-keys -t '#{pane_id}' '/promote' Enter` },
    { name: 'finish agent + recycle pane', key: 'd', cmd: `run-shell "crtr node demote --pane '#{pane_id}'"` },
    // Close cascades down the subscribes_to spine (kills the subtree's windows,
    // marks them canceled); revivable. Output discarded — the keypress just acts.
    { name: 'close agent + subtree',       key: 'x', cmd: `run-shell "crtr node close --pane '#{pane_id}' >/dev/null 2>&1"` },
    // Re-keyed g→b so `g` is free for the canvas-nav GRAPH toggle (below).
    { name: 'browse background agents',    key: 'b', cmd: `switch-client -t ${sess}` },
  ];

  // Canvas-nav chords from config (default: g→graph, m→manager, e→expand). The
  // `__graph__` sentinel toggles the in-pi GRAPH modal via send-keys; every
  // other bind shells the chord dispatcher, which resolves the pane's node and
  // interpolates the bind at popup time. Keys colliding with the built-ins are
  // skipped (the built-in wins).
  let prefixBinds: Record<string, { run: string; desc?: string }> = {};
  try { prefixBinds = readConfig('user').canvasNav.prefixBinds; } catch { /* defaults below */ }
  for (const [key, bind] of Object.entries(prefixBinds)) {
    if (key.length !== 1 || RESERVED_MENU_KEYS.has(key)) continue;
    const name = bind.desc !== undefined && bind.desc !== '' ? bind.desc : `chord ${key}`;
    const cmd =
      bind.run === '__graph__'
        ? `send-keys -t '#{pane_id}' '/graph' Enter`
        : `run-shell "crtr canvas chord --pane '#{pane_id}' --key ${key} >/dev/null 2>&1"`;
    items.push({ name, key, cmd });
  }

  // Focus report N: nine generated chord items (1..9), each resolved by the
  // dispatcher to subscriptionsOf(self)[N-1] at popup time.
  for (let n = 1; n <= 9; n++) {
    items.push({
      name: `focus report ${n}`,
      key: `${n}`,
      cmd: `run-shell "crtr canvas chord --pane '#{pane_id}' --key ${n} >/dev/null 2>&1"`,
    });
  }

  // tmux's -x sets the menu's LEFT edge. To sit the box INSIDE the pane's
  // top-right corner, shift x left by the box width (longest line + tmux chrome:
  // borders + padding + the right-aligned mnemonic-key column) via format math.
  const boxW = Math.max(title.length, ...items.map((i) => i.name.length)) + 6;
  // Fine-tune nudges off the pane's top-right corner: a hair further left and
  // one row down so the box doesn't kiss the pane border.
  const nudgeX = 1; // extra columns left
  const nudgeY = 3; // rows down
  const args = [
    'bind-key', '-n', 'M-c', 'display-menu',
    '-T', `#[align=centre]${title}`,
    '-x', `#{e|-:#{pane_right},${boxW + nudgeX}}`,
    '-y', `#{e|+:#{pane_top},${nudgeY}}`,
  ];
  for (const it of items) args.push(it.name, it.key, it.cmd);
  return tmux(args).ok;
}

// ---------------------------------------------------------------------------
// Nav bindings — Alt+] / Alt+[ DFS-walk the canvas one window at a time. Each
// key shells out to `crtr node cycle`, passing the active pane so the walk is
// relative to the agent in front of you; cycle then swaps the next/prev node
// into that pane (like `node focus`). Output is discarded so the keypress never
// pops a results view. Installed at root boot alongside the Alt+C menu.
// ---------------------------------------------------------------------------

/** Bind Alt+] (forward) and Alt+[ (back) to the DFS canvas walk. Best-effort;
 *  false if either bind fails. NOTE: Alt+[ is only delivered cleanly when the
 *  terminal/tmux disambiguate it from a raw CSI introducer (`extended-keys on`).
 */
export function installNavBindings(): boolean {
  const next = tmux([
    'bind-key', '-n', 'M-]', 'run-shell',
    `crtr node cycle --dir next --pane '#{pane_id}' >/dev/null 2>&1`,
  ]).ok;
  const prev = tmux([
    'bind-key', '-n', 'M-[', 'run-shell',
    `crtr node cycle --dir prev --pane '#{pane_id}' >/dev/null 2>&1`,
  ]).ok;
  return next && prev;
}
