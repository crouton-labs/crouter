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
import { nodeSession } from './nodes.js';

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

/** Relocate a pane into another session as its own window WITHOUT killing the
 *  process in it — `break-pane -d` moves the pane out of its current window (the
 *  pi keeps generating) into a fresh window in `session`; `-d` leaves the caller's
 *  client where it is rather than following the pane to the background, and `-a`
 *  allocates the next free window index (same dodge as openNodeWindow). The
 *  "detach to background" driver behind `node lifecycle --detach`. Best-effort;
 *  false if tmux refuses (e.g. the pane is gone). The caller reconciles presence
 *  so the canvas follows the move. */
export function breakPaneToSession(pane: string, session: string): boolean {
  return tmux(['break-pane', '-d', '-a', '-s', pane, '-t', `${session}:`]).ok;
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

/** Re-exec a command in an EXISTING pane, in place — DETACHED. Spawned in its own
 *  process group (unref'd) so the request reaches the tmux server even though
 *  `-k` tears down the caller's own pi mid-flight. Used when a node respawns ITS
 *  OWN pane (refresh-yield): the dispatch can't be awaited because it kills the
 *  awaiter. Returns true once the request was dispatched. */
export function respawnPaneDetached(opts: RespawnPaneOpts): boolean {
  try {
    const child = spawn('tmux', respawnPaneArgs(opts), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Re-exec a command in an EXISTING pane, in place — SYNCHRONOUS. Runs the
 *  `respawn-pane` to completion and reports the real exit status. Used when the
 *  caller is NOT the pane being respawned (e.g. the daemon resuming a frozen
 *  focus pane), so it can confirm the respawn landed. Returns true on success. */
export function respawnPaneSync(opts: RespawnPaneOpts): boolean {
  return tmux(respawnPaneArgs(opts)).ok;
}

/** @deprecated Use respawnPaneDetached. Retained so existing refresh-yield
 *  callers stay green while the placement layer migrates onto the explicit
 *  sync/detached split. */
export function respawnPane(opts: RespawnPaneOpts): boolean {
  return respawnPaneDetached(opts);
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

/** Toggle `remain-on-exit` on a window (§1.5 F3). `on` keeps a focus pane on
 *  screen after its pi exits — the viewport survives (F1), the final transcript
 *  is preserved, and `respawn-pane -k` can resurrect the node into the SAME pane
 *  id. NOTE (§1.5/§2.5, spike-confirmed): a dead/frozen pane is reaped only by
 *  `kill-pane`/`respawn-pane`, NEVER by toggling this off — the toggle does not
 *  reap an already-dead pane. Best-effort; never throws. */
export function setRemainOnExit(window: string, on: boolean): boolean {
  return tmux(['set-window-option', '-t', window, 'remain-on-exit', on ? 'on' : 'off']).ok;
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
const RESERVED_MENU_KEYS = new Set(['o', 'r', 'd', 'D', 'x', 'b']);

/** Bind Alt+C to the crouter action menu. Best-effort; false if tmux fails.
 *  The built-in items (promote/demote/detach/close/browse) are static; the canvas-nav
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
    // Resume types `/resume-node` into the agent's pane: the slash command opens
    // a whole-canvas picker (incl. dormant nodes) and revives the choice via
    // `crtr node focus` — the only sync-safe open (routes through reviveNode).
    { name: 'resume node',                 key: 'r', cmd: `send-keys -t '#{pane_id}' '/resume-node' Enter` },
    // `d` runs `node demote`: flip the agent to TERMINAL in place — no finalize,
    // no kill — it keeps running where it is, and because it is now terminal it
    // is forced to push a final up the spine when it finishes. `D` runs `node
    // demote --detach`, which ALSO detaches it to the background `crtr` session
    // (frees the pane; the pi keeps generating). Neither ends it.
    { name: 'demote to terminal',          key: 'd', cmd: `run-shell "crtr node demote --pane '#{pane_id}' >/dev/null 2>&1"` },
    { name: 'detach to background',        key: 'D', cmd: `run-shell "crtr node demote --pane '#{pane_id}' --detach >/dev/null 2>&1"` },
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
