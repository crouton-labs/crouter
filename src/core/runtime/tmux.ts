// tmux placement — one window per active node.
//
//   session = a root        window = a node        window 0 = optional dashboard
//
// Background windows run but don't render — only the current window draws. That
// is the "detached but switchable" model: nothing tiles, you never see a node's
// UI unless you switch to it. Bring one forefront with select-window (within a
// root) or switch-client + select-window (across roots). done/dead nodes close
// their window; reviving opens a fresh one.

import { spawnSync } from 'node:child_process';
import { readConfig } from '../config.js';
import { surfaceTmuxStyleArgs } from './surface-bg.js';

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

/** Force bracketed-paste capabilities on for every terminal on this tmux server.
 *
 *  Many terminfo entries lack the Enbp/Dsbp (enable/disable bracketed paste)
 *  capabilities. Without them tmux never asks the outer terminal to wrap pastes,
 *  so a multi-line paste arrives as raw `\r` and the inner app (pi, zsh, …)
 *  submits on the first newline — i.e. one paste lands as several messages.
 *  Declaring the caps for `*` restores bracketed paste so pastes stay atomic.
 *
 *  `terminal-overrides` is a server option, so this is set once per server and
 *  is idempotent: we only append our entry when the Enbp marker isn't already
 *  present (e.g. the user's own tmux.conf already declares it). Must run only
 *  once a server exists — set-option errors out with no server running — so
 *  callers invoke it AFTER ensuring a session. */
function ensureBracketedPaste(): void {
  const current = tmux(['show-options', '-s', 'terminal-overrides']).stdout;
  if (current.includes('Enbp=')) return;
  tmux(['set-option', '-sga', 'terminal-overrides', '*:Enbp=\E[?2004h:Dsbp=\E[?2004l']);
}

/** Create a detached session rooted at `cwd` if it doesn't exist. The session
 *  name is a root's tmux home; every node under that root is a window in it. */
export function ensureSession(name: string, cwd: string): void {
  if (!sessionExists(name)) {
    tmux(['new-session', '-d', '-s', name, '-c', cwd]);
  }
  ensureBracketedPaste();
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
 *  new window id AND the pane id it created (the durable `%pane_id`, LOCATION's
 *  anchor) — callers that only need the window destructure `.window`.
 *
 *  Target is `${session}:` (trailing colon = the session, no window index) plus
 *  `-a` (insert after the current window) so tmux allocates the next free index.
 *  Passing a bare session name resolves to the session's *active window*, which
 *  makes new-window try to create AT that occupied index and fail with
 *  "create window failed: index N in use" whenever the active window is not the
 *  last one (common when base-index is 0 but the live window sits at index 1).
 *  `-a` also keeps node windows off index 0, which is reserved for the optional
 *  dashboard. The explicit `-t ${session}:` target is the §2.2 HARD DRIVER
 *  INVARIANT — never let new-window fall back to tmux's global current session. */
export function openNodeWindow(
  opts: OpenWindowOpts,
): { window: string; pane: string } | null {
  const r = tmux([
    'new-window',
    '-d',
    '-a',
    '-P',
    '-F',
    '#{window_id}\t#{pane_id}',
    '-t',
    `${opts.session}:`,
    '-n',
    opts.name,
    '-c',
    opts.cwd,
    ...envFlags(opts.env),
    opts.command,
  ]);
  if (!r.ok) return null;
  const [window, pane] = r.stdout.split('\t');
  if (window === undefined || window === '' || pane === undefined || pane === '') {
    return null;
  }
  return { window, pane };
}

export interface SplitWindowOpts {
  cwd: string;
  env: Record<string, string>;
  /** The full command to run in the new pane (already a shell string). */
  command: string;
  /** Stack the new pane below instead of beside (default: beside, `-h`). */
  vertical?: boolean;
  /** Place the new pane BEFORE the target (left for `-h`, above for `-v`) via
   *  `-b`, instead of after it (default: after — right/below). */
  before?: boolean;
  /** Fixed size of the new pane in the split axis' cells (columns for `-h`, rows
   *  for `-v`) via `-l`. Omit ⇒ tmux's default even split. */
  size?: number;
}

/** Split `targetPane`'s window, opening a NEW pane beside it running `command`,
 *  and return the new pane id (the durable `%id`). The ONLY new-pane-beside verb
 *  (Q3: a focus opened side-by-side). `-d` keeps the caller's pane active; `-h`
 *  makes the split side-by-side (left/right), the default for a focus viewport.
 *
 *  §2.2 HARD DRIVER INVARIANT: `targetPane` is REQUIRED — a bare `split-window`
 *  would split tmux's global current pane, which can leak a pane into an
 *  unrelated user session (the exact bug this design kills). The explicit
 *  `-t <targetPane>` makes the destination structurally un-leakable. Returns
 *  null if tmux fails. */
export function splitWindow(targetPane: string, opts: SplitWindowOpts): string | null {
  const r = tmux([
    'split-window',
    '-d',
    ...(opts.vertical === true ? [] : ['-h']),
    ...(opts.before === true ? ['-b'] : []),
    ...(opts.size !== undefined ? ['-l', String(opts.size)] : []),
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    targetPane,
    '-c',
    opts.cwd,
    ...envFlags(opts.env),
    opts.command,
  ]);
  return r.ok && r.stdout !== '' ? r.stdout : null;
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

/** Rename a window (`tmux rename-window -t <window> <name>`). Used by the
 *  root relaunch to re-title the viewer window when its pane is re-pointed at
 *  the freshly-minted node. Best-effort; false if tmux fails. */
export function renameWindow(window: string, name: string): boolean {
  return tmux(['rename-window', '-t', window, name]).ok;
}

/** Break a single PANE out into a BRAND-NEW window of its own (`tmux break-pane
 *  -d`). `-d` keeps the new window in the background (does not switch the client
 *  to it); `-s <pane>` names the source pane — the §2.2 HARD DRIVER INVARIANT, so
 *  the break never falls back to tmux's global current pane. The pane keeps its
 *  durable `%id` across the move (only its window changes), so callers can keep
 *  using the same pane handle. Returns the new `{window, pane}` location, or null
 *  if tmux fails. Used by `canvas tmux-spread` to lift the caller's viewer into a
 *  fresh window before tiling sibling viewers beside it. */
export function breakPane(pane: string): { window: string; pane: string } | null {
  const r = tmux([
    'break-pane',
    '-d',
    '-P',
    '-F',
    '#{window_id}\t#{pane_id}',
    '-s',
    pane,
  ]);
  if (!r.ok) return null;
  const [window, p] = r.stdout.split('\t');
  if (window === undefined || window === '' || p === undefined || p === '') return null;
  return { window, pane: p };
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

/** The session + window a pane currently lives in (`display-message -p -t %id`).
 *  The §2.4 reconciliation read-back: resolve a node's/focus's CURRENT
 *  window/session from its durable pane id before any act, so crtr follows a
 *  manual `move-pane`/`join-pane`/`break-pane` instead of fighting it. Null if
 *  the pane is gone or tmux fails. */
export function paneLocation(pane: string): { session: string; window: string } | null {
  const r = tmux(['display-message', '-p', '-t', pane, '#{session_name}\t#{window_id}']);
  if (!r.ok) return null;
  const [session, window] = r.stdout.split('\t');
  if (session === undefined || session === '' || window === undefined || window === '') return null;
  return { session, window };
}

/** Does this pane id still exist? A `display-message` probe on the `%id` — the
 *  v3 PRIMARY liveness probe (§1.2/§2.2), replacing window-existence so a user
 *  moving a pane to another window/session never reads as "gone". True iff tmux
 *  knows the pane.
 *
 *  NOTE: `display-message -p -t <gone-pane>` EXITS 0 with EMPTY output (it does
 *  not error on an unresolvable pane target) — so an `.ok` check alone would
 *  report a dead pane as alive, defeating the whole point of pane-existence
 *  liveness. We therefore require the echoed `#{pane_id}` to equal the requested
 *  pane: a live pane echoes its own id, a gone/bogus one yields empty. */
export function paneExists(pane: string): boolean {
  const r = tmux(['display-message', '-p', '-t', pane, '#{pane_id}']);
  return r.ok && r.stdout === pane;
}

/** Does this pane exist AND have its command still RUNNING (`#{pane_dead}` = 0)?
 *  Distinguishes a pane genuinely hosting a live process from a remain-on-exit
 *  corpse frozen after exit (`pane_dead` = 1). Node viewer panes run `crtr attach`
 *  as the pane command, so pane-running ⟹ a live viewer occupies it. */
export function paneRunning(pane: string): boolean {
  const r = tmux(['display-message', '-p', '-t', pane, '#{pane_id}\t#{pane_dead}']);
  return r.ok && r.stdout === `${pane}\t0`;
}

/** Every live pane id on the server (`list-panes -a`), as a Set for membership
 *  probes. Returns null when tmux is unreachable (no server / transient failure)
 *  so callers can tell "no panes" apart from "can't tell" — a GC pass must skip,
 *  never mass-delete, on a failed probe. One subprocess call total, so batch
 *  liveness sweeps (e.g. the daemon's stale-focus GC) don't pay a per-pane
 *  display-message each. */
export function listLivePanes(): Set<string> | null {
  const r = tmux(['list-panes', '-a', '-F', '#{pane_id}']);
  if (!r.ok) return null;
  return new Set(r.stdout.split('\n').filter((p) => p !== ''));
}

/** The working directory of a pane (`display-message -p -t <pane>
 *  '#{pane_current_path}'`). Used to preserve a view monitor's cwd across a
 *  view-cycle respawn so project-scoped views still resolve. Null if tmux fails. */
export function paneCurrentPath(pane: string): string | null {
  const r = tmux(['display-message', '-p', '-t', pane, '#{pane_current_path}']);
  return r.ok && r.stdout !== '' ? r.stdout : null;
}

/** Set a PANE-scoped tmux option (`tmux set-option -p -t <pane> <name> <value>`).
 *  Used to tag a pane with the view id it currently hosts (`@crtr_view`) so the
 *  view-nav cycle can read it back and switch to the next/prev view in place.
 *  Best-effort; never throws. */
export function setPaneOption(pane: string, name: string, value: string): boolean {
  return tmux(['set-option', '-p', '-t', pane, name, value]).ok;
}

/** Read a PANE-scoped tmux option value (`tmux show-options -p -t <pane> -q -v
 *  <name>`): `-v` prints only the value, `-q` suppresses the unknown-option
 *  error so an unset option yields an empty string. undefined if tmux fails. */
export function getPaneOption(pane: string, name: string): string | undefined {
  const r = tmux(['show-options', '-p', '-t', pane, '-q', '-v', name]);
  return r.ok ? r.stdout : undefined;
}

export interface RespawnPaneOpts {
  /** Target pane id (e.g. `%3`) — the pane to re-exec in place. */
  pane: string;
  cwd: string;
  env: Record<string, string>;
  /** The full command to run in the pane (already a shell string). */
  command: string;
}

/** The `respawn-pane -k` argv for `opts`. `-k` kills the pane's current process
 *  (e.g. a yielding pi) and re-execs `command` in the SAME pane, preserving its
 *  `%id` (§1.5 F3: a frozen focus pane resumes in place, no new window). The
 *  explicit `-t opts.pane` is the §2.2 HARD DRIVER INVARIANT — respawn must name
 *  its target pane, never tmux's global current pane. */
function respawnPaneArgs(opts: RespawnPaneOpts): string[] {
  return [
    'respawn-pane',
    '-k',
    '-c',
    opts.cwd,
    ...envFlags(opts.env),
    '-t',
    opts.pane,
    opts.command,
  ];
}

/** Re-exec a command in an EXISTING pane, in place — SYNCHRONOUS. Runs the
 *  `respawn-pane` to completion and reports the real exit status. Used when the
 *  caller is NOT the pane being respawned (e.g. the daemon resuming a frozen
 *  focus pane), so it can confirm the respawn landed. Returns true on success. */
export function respawnPaneSync(opts: RespawnPaneOpts): boolean {
  return tmux(respawnPaneArgs(opts)).ok;
}

// ---------------------------------------------------------------------------
// pi command assembly
// ---------------------------------------------------------------------------

/** Turn a pi argv array into a single shell command string.
 *
 *  The binary defaults to `CRTR_PI_BINARY` when that env var is set, else the
 *  literal `pi`. This is a TEST-ONLY substitution seam: when CRTR_PI_BINARY is
 *  unset (every production path) the behavior is byte-identical to exec'ing
 *  `pi`. The integration-test harness points it at a deterministic fake-pi
 *  vehicle so a real `crtr node new` reaches the fake instead of the LLM `pi`,
 *  without any dependence on tmux/shell PATH inheritance — the substitution is
 *  baked into the command string at build time, in the process that calls
 *  piCommand. An explicit `binary` arg still overrides the env (no caller passes
 *  one today). The value may be a multi-word launcher (e.g. `node --import
 *  tsx/esm host.ts`); only the argv entries are shell-quoted, so a multi-word
 *  binary is spliced verbatim ahead of them. */
export function piCommand(
  argv: string[],
  binary = process.env['CRTR_PI_BINARY'] ?? 'pi',
): string {
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
// Focus helpers (used by the placement layer)
// ---------------------------------------------------------------------------

/** Activate a window within its session (same-session navigation). Equivalent
 *  to `tmux select-window -t <session>:<window>`. Best-effort; never throws. */
export function selectWindow(session: string, window: string): boolean {
  return tmux(['select-window', '-t', `${session}:${window}`]).ok;
}

/** Apply a named tmux layout to a window (`tmux select-layout -t <window>
 *  <layout>`). `canvas tmux-spread` calls it with `tiled` to evenly grid every
 *  viewer pane in the spread window (and between splits, to redistribute space so
 *  the next split has room). Best-effort; false if tmux fails. */
export function selectLayout(window: string, layout: string): boolean {
  return tmux(['select-layout', '-t', window, layout]).ok;
}

/** Make a pane the ACTIVE pane in its window (`tmux select-pane -t <pane>`). A
 *  `split-window -d` keeps the CALLER active, so a freshly-opened viewer pane is
 *  not focused until this runs — `focus` calls it so picking a node (e.g. from the
 *  alt+g graph) lands the keyboard on the new viewer. Best-effort; false if tmux
 *  fails. */
export function selectPane(pane: string): boolean {
  return tmux(['select-pane', '-t', pane]).ok;
}

/** Switch the tmux client to a different session (cross-session focus). Runs
 *  `tmux switch-client -t <session>`. Best-effort; never throws. The caller is
 *  responsible for following up with selectWindow to land on the right window. */
export function switchClient(session: string): boolean {
  return tmux(['switch-client', '-t', session]).ok;
}

// ---------------------------------------------------------------------------
// send-keys (chrome — used by the prefix menu + nav bindings)
// ---------------------------------------------------------------------------

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
const RESERVED_MENU_KEYS = new Set(['o', 'r', 'd', 'D', 'x']);

/** Bind Alt+C to the crouter action menu. Best-effort; false if tmux fails.
 *  The built-in items (promote/resume/demote/detach/close) are static; the canvas-nav
 *  chords (default g→graph, m→manager + any custom prefixBind) are appended
 *  from `canvasNav.prefixBinds`, each routed through `crtr canvas chord` (or, for
 *  the `__graph__` sentinel, a `send-keys '/graph'`) so the menu stays static
 *  while behaviour is config-driven. */
export function installMenuBinding(): boolean {
  const title = ' crtr ';
  const items: Array<{ name: string; key: string; cmd: string }> = [
    // Promote types `/promote` into the agent's pane rather than shelling out:
    // the slash command delivers the orchestration guidance into the node's
    // context, which a bare `run-shell` (output discarded) could not.
    { name: 'promote to orchestrator',    key: 'o', cmd: `send-keys -t '#{pane_id}' '/promote' Enter` },
    // Resume types `/resume-node` into the agent's pane: the slash command opens
    // a whole-canvas picker (incl. dormant nodes) and revives the choice via
    // `crtr node focus` — the only sync-safe open (routes through reviveNode).
    { name: 'resume node',                 key: 'r', cmd: `send-keys -t '#{pane_id}' '/resume-node' Enter` },
    // `d` runs `node demote`: flip the agent to TERMINAL in place — no finalize,
    // no kill — it keeps running where it is, and because it is now terminal it
    // is forced to push a final up the spine when it finishes. `D` runs `node
    // demote --detach`, which ALSO closes the agent's viewer pane (frees the
    // pane; the detached broker keeps generating). Neither ends it.
    { name: 'demote to terminal',          key: 'd', cmd: `run-shell "crtr node demote --pane '#{pane_id}' >/dev/null 2>&1"` },
    { name: 'detach to background',        key: 'D', cmd: `run-shell "crtr node demote --pane '#{pane_id}' --detach >/dev/null 2>&1"` },
    // Close cascades down the subscribes_to spine (kills the subtree's windows,
    // marks them canceled); revivable. Output discarded — the keypress just acts.
    { name: 'close agent + subtree',       key: 'x', cmd: `run-shell "crtr node close --pane '#{pane_id}' >/dev/null 2>&1"` },
  ];

  // Canvas-nav chords from config (default: g→graph, m→manager). The
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

  // Dismiss hint. A tmux display-menu always closes on its native cancel keys
  // (Escape / q / C-c), encoding-independent. We do NOT try to catch a re-pressed
  // Alt+C: under `extended-keys on` (common, and what pi negotiates) the second
  // Alt+C reaches the overlay as a CSI-u key (`\033[99;3u`) that tmux's menu does
  // NOT match against an `M-c` mnemonic item, so a "close menu" row keyed M-c
  // never fires and the menu just sits open (verified in tmux 3.6b: legacy Esc+c
  // closes, CSI-u does not). Instead, a disabled (`-` prefix → dim, unselectable)
  // last row tells the user the close keys that always work. Placed last so it
  // reads as chrome below the actions.
  items.push({ name: '-esc / q to close', key: '', cmd: '' });

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
    // Frame the menu on the theme's distinct-surface background so it doesn't
    // blend into the pane behind it (CTO ruling). Empty in the front door (theme
    // not loaded there); the attach viewer re-installs this with the style once
    // it has themed — see attach-cmd.ts.
    ...surfaceTmuxStyleArgs(),
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

// ---------------------------------------------------------------------------
// View-nav bindings — Alt+V then ] / [ cycle the view hosted in a MONITOR pane
// to the next/prev available view, in place. A VIEW-PREFIXED CHORD, not a bare
// Alt pair: Alt+V switches into a private one-shot `crtr-view` key table, then
// ] (next) / [ (prev) fire the cycle — mirroring node cycle's bracket DIRECTION
// grammar (Alt+] next / Alt+[ prev) while NAMESPACING the brackets so they can
// never shadow root bindings. This is collision-proof: only ONE root key (M-v)
// is claimed, and bare Alt pairs are a minefield in real configs (e.g. Alt+,/. 
// and Alt+]/.[ commonly bound to window/pane nav). The bracket lives in the
// private table, so it also sidesteps the M-[ vs CSI-introducer ambiguity that
// dogs installNavBindings' Alt+[. Each key shells `crtr view cycle`, passing the
// active pane; cycle reads the pane's @crtr_view tag and respawns it on the
// next/prev view. Output discarded so the keypress never pops a results view.
// Installed at root boot alongside the node nav + Alt+C menu.
//
// NOTE: `M-v` is a GLOBAL root binding — it intercepts Alt+V in every pane/app
// (e.g. swallowed from the pi editor), the same tradeoff crtr already takes for
// M-c / M-] / M-[. Intended: crtr owns a small set of Alt chords server-wide.
// ---------------------------------------------------------------------------

/** Bind Alt+V → (], [) to the view-monitor cycle. `M-v` enters the private
 *  `crtr-view` key table (switch-client -T), then ] cycles next / [ cycles prev.
 *  Best-effort; false if any of the three binds fail. Deliberately distinct from
 *  installNavBindings' bare Alt+]/Alt+[ (node cycle): the two cycles coexist on
 *  the same server — brackets alone walk the node graph, Alt+V-then-bracket flips
 *  view monitors. The bracket keys are bound in the private table, so they NEVER
 *  shadow the user's root ]/[ and carry no CSI-introducer ambiguity. */
export function installViewNavBindings(): boolean {
  const enter = tmux([
    'bind-key', '-n', 'M-v', 'switch-client', '-T', 'crtr-view',
  ]).ok;
  const next = tmux([
    'bind-key', '-T', 'crtr-view', ']', 'run-shell',
    `crtr view cycle --dir next --pane '#{pane_id}' >/dev/null 2>&1`,
  ]).ok;
  const prev = tmux([
    'bind-key', '-T', 'crtr-view', '[', 'run-shell',
    `crtr view cycle --dir prev --pane '#{pane_id}' >/dev/null 2>&1`,
  ]).ok;
  return enter && next && prev;
}
