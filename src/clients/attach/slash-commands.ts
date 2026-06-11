// slash-commands.ts — builtin slash-command parse + dispatch for `crtr attach` (C6).
//
// Builtin slash commands are NOT engine-interpreted: `session.prompt('/model')`
// ships "/model" to the LLM as literal text. So the viewer recognizes the 21
// vendored `BUILTIN_SLASH_COMMANDS` itself and dispatches the matching
// `ClientToBroker` command frame; only EXTENSION commands (anything the viewer
// doesn't recognize) fall through to be sent as a `prompt` for the engine's
// extension runner to handle.
//
// SELECTORS — native interactive pickers. `/model`, `/resume`, `/fork`, `/tree`,
// `/settings`, `/scoped-models` open pi's real `*SelectorComponent`s as overlays,
// fed by the operator-view read-op `data` frames (broker-protocol) over the
// socket. With no arg they open the picker (via the `openXPicker` SlashContext
// callbacks the InputController exposes, fed by its read-op request channel —
// which attach-cmd MUST wire via `onRequest: (f) => socket.request(f)`). With an
// arg the same resolved value is sent directly (`/model <provider/id>`, `/resume
// <path>`, `/fork <entryId>`, `/tree <entryId>`) without the UI. If the request
// channel is unwired the picker degrades to the arg-form notice. (Verified
// against pi 0.79.1 — `ScopedModelsSelectorComponent` is the one selector pi does
// not re-export, so /scoped-models renders read-only via a SelectList.)
//
// SCOPED OUT (review m2 — no engine method): `/login`, `/logout`, `/share`,
// `/trust` — a brief "not supported in attach" notice, never a frame.

import { execFile } from 'node:child_process';
import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import { BUILTIN_SLASH_COMMANDS } from '../../core/runtime/pi-vendored.js';
import { surfaceTmuxStyleArgs } from '../../core/runtime/surface-bg.js';
import type {
  BrokerSnapshot,
  ClientToBroker,
  SetThinkingLevelFrame,
} from '../../core/runtime/broker-protocol.js';

/** Everything a slash handler needs: the frame sink, a notice sink, the latest
 *  engine state (for read-only commands like `/session`), and the cwd (for the
 *  default `/export` path). */
export interface SlashContext {
  /** Send a command frame to the broker (= InputController hooks.onCommand). */
  send: (frame: ClientToBroker) => void;
  /** Surface a transient one-line notice in the viewer. */
  notify: (message: string) => void;
  /** Latest `welcome`/`session_info_changed` state, if the controller fed it. */
  state?: BrokerSnapshot['state'];
  /** cwd for the default `/export` path; defaults to `process.cwd()`. */
  cwd?: string;
  /** The canvas node this viewer is attached to — used by `/promote` (passed
   *  as `--node`). Falls back to `CRTR_NODE_ID` when absent; if neither is set
   *  `/promote` notifies and no-ops. (Unit Q wires this from `runAttach`.) */
  nodeId?: string;
  /** Toggle the in-process GRAPH overlay (the local subscription-tree view).
   *  `/graph` is inherently an in-viewer overlay, not a tmux popup, so this unit
   *  registers `/graph` as a stub that calls this hook. Unit C/Q owns the overlay
   *  itself and populates this; when absent `/graph` notifies it isn't wired yet. */
  onGraph?: () => void;
  /** Detach this viewer (`/quit`). A viewer quit DETACHES — it tears down the
   *  local TUI/socket and leaves the shared engine running. Wired by attach-cmd to
   *  `teardown('detach')`; without it `/quit` cannot actually exit (just sending
   *  `bye` makes the broker drop the socket, which the viewer treats as a dropped
   *  connection and reconnects). */
  onQuit?: () => void;
  /** Copy the last assistant message to the clipboard (`/copy`). Wired by
   *  attach-cmd (it owns the ChatView that holds the text + the clipboard writer). */
  onCopy?: () => void;
  /** OPTIONAL native-picker openers — the InputController fills these from its
   *  read-op request channel. When absent (channel unwired) the value-picker
   *  builtins fall back to the text-arg notice. */
  openModelPicker?: () => void;
  openSessionPicker?: () => void;
  openForkPicker?: () => void;
  openTreePicker?: () => void;
  openSettingsPicker?: () => void;
  openScopedModelsPicker?: () => void;
  /** Open the native /login provider selector. */
  openLoginPicker?: () => void;
  /** Open the native /logout provider selector. */
  openLogoutPicker?: () => void;
}

/** Canvas slash-commands — reimplemented NATIVE in the viewer (the canvas chrome
 *  pi-extensions cannot load here; see findings-chrome-parity.md Feature 3). Each
 *  ports the action of its extension: `/promote` ← canvas-commands.ts, `/resume-node`
 *  ← canvas-resume.ts, `/view` ← canvas-view.ts, `/graph` ← canvas-nav.ts. Three of
 *  them shell a `crtr` subcommand via `tmux display-popup` (the viewer runs inside a
 *  tmux pane, so this works exactly as in the extensions); `/graph` is a stub for the
 *  overlay (Unit C/Q). Exported so Unit Q can fold these into the autocomplete list. */
export const CANVAS_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'graph', description: 'Toggle the canvas GRAPH view (your local subscription tree)' },
  { name: 'promote', description: 'Promote this node to an orchestrator — /promote, or /promote <kind> to specialize' },
  { name: 'resume-node', description: 'Open the canvas navigator (search/scope/sort/tree) and resume the chosen node' },
  { name: 'view', description: 'Open a view in a popup — bare for the picker, or /view <name> to open that view directly' },
];

const CANVAS_NAMES = new Set(CANVAS_SLASH_COMMANDS.map((c) => c.name));

/** Builtins with no Phase-4 engine method — scoped out (review m2). */
const SCOPED_OUT = new Set(['trust']);

/** Valid `/settings thinking` levels — the `SetThinkingLevelFrame['level']`
 *  union (= AgentSession['thinkingLevel'], pi-agent-core ThinkingLevel),
 *  mirrored as a runtime set so an invalid arg is rejected with the options
 *  rather than shipped as a frame the engine would throw on. Built from a
 *  `Record<level, true>` so the build fails BOTH ways if the union drifts: a
 *  missing key (union GAINED a level) or an extra key (union dropped one). */
const THINKING_LEVELS = new Set<string>(
  Object.keys({
    off: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
  } satisfies Record<SetThinkingLevelFrame['level'], true>),
);

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));

/** True if `text` is a leading-slash command (vs. a normal prompt). */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith('/');
}

/**
 * Parse + dispatch a leading-slash command. Returns `true` if it was handled
 * (a recognized builtin or a scoped-out notice) — the caller then clears the
 * editor and sends nothing else. Returns `false` for an UNRECOGNIZED command,
 * which the caller forwards to the engine as a `prompt` (extension command).
 */
export function dispatchSlashCommand(text: string, ctx: SlashContext): boolean {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const name = m[1];
  const arg = m[2].trim();

  if (SCOPED_OUT.has(name)) {
    ctx.notify(`/${name} is not supported in attach (Phase 4)`);
    return true;
  }
  // Canvas commands (reimplemented native in the viewer) — handled before the
  // builtin gate since they are neither pi builtins nor engine-extension commands.
  if (CANVAS_NAMES.has(name)) return dispatchCanvasCommand(name, arg, ctx);
  // Unknown to us AND not a builtin → let the engine's extension runner have it.
  if (!BUILTIN_NAMES.has(name)) return false;

  switch (name) {
    // --- direct frames -----------------------------------------------------
    case 'new':
      ctx.send({ type: 'new_session' });
      return true;
    case 'reload':
      ctx.send({ type: 'reload' });
      return true;
    case 'compact':
      ctx.send({ type: 'compact', instructions: arg || undefined });
      return true;
    case 'quit':
      // A viewer "quit" DETACHES — the shared engine keeps running (one-writer).
      // onQuit tears the viewer down locally (which sends `bye` itself). Falling
      // back to a bare `bye` would just make the broker close the socket, which
      // the viewer reconnects to — so the detach MUST go through onQuit.
      if (ctx.onQuit) {
        ctx.onQuit();
        return true;
      }
      ctx.send({ type: 'bye' });
      ctx.notify('Detaching — the engine keeps running');
      return true;

    // --- frames needing one argument --------------------------------------
    case 'name':
      if (!arg) return usage(ctx, '/name <display name>');
      ctx.send({ type: 'set_session_name', name: arg });
      return true;
    case 'export': {
      const { path, format } = parseExport(arg, ctx.cwd ?? process.cwd());
      ctx.send({ type: 'export', path, format });
      ctx.notify(`Exporting session → ${path}`);
      return true;
    }
    case 'import':
      // `/import` resumes a session built from a JSONL file → switch_session.
      if (!arg) return usage(ctx, '/import <path-to-session.jsonl>');
      ctx.send({ type: 'switch_session', path: arg });
      return true;

    // --- value-picker builtins: native picker (no arg) OR direct value (arg) ---
    case 'model':
      if (!arg) return openOrHint(ctx.openModelPicker, ctx, 'model', '/model <provider/id>');
      ctx.send({ type: 'set_model', model: arg });
      return true;
    case 'resume':
      if (!arg) return openOrHint(ctx.openSessionPicker, ctx, 'session', '/resume <session-path>');
      ctx.send({ type: 'switch_session', path: arg });
      return true;
    case 'fork':
      if (!arg) return openOrHint(ctx.openForkPicker, ctx, 'fork point', '/fork <entryId>');
      ctx.send({ type: 'fork', entryId: arg });
      return true;
    case 'tree':
      if (!arg) return openOrHint(ctx.openTreePicker, ctx, 'tree', '/tree <entryId>');
      ctx.send({ type: 'navigate_tree', targetId: arg });
      return true;
    case 'scoped-models':
      if (ctx.openScopedModelsPicker) {
        ctx.openScopedModelsPicker();
        return true;
      }
      ctx.notify('The scoped-models view needs the read-op channel, which this viewer has not wired');
      return true;

    // --- settings (sub-command form; interactive menu needs read ops) ------
    case 'settings':
      return handleSettings(arg, ctx);

    // --- read-only / informational ----------------------------------------
    case 'session':
      ctx.notify(describeSession(ctx.state));
      return true;
    case 'copy':
      // Copy the last assistant message to the clipboard — viewer-owned (the text
      // is in the ChatView; no engine round-trip). attach-cmd does the actual copy.
      if (ctx.onCopy) {
        ctx.onCopy();
        return true;
      }
      ctx.notify('/copy is not available in this viewer');
      return true;

    // --- auth commands — viewer-local OAuth/API-key flows ------------------
    case 'login':
      if (ctx.openLoginPicker) { ctx.openLoginPicker(); return true; }
      ctx.notify('/login is not available in this viewer');
      return true;
    case 'logout':
      if (ctx.openLogoutPicker) { ctx.openLogoutPicker(); return true; }
      ctx.notify('/logout is not available in this viewer');
      return true;

    // --- share / clone / changelog -----------------------------------------
    case 'share':
      ctx.send({ type: 'share' });
      ctx.notify('Sharing session…');
      return true;
    case 'clone':
      ctx.send({ type: 'clone' });
      ctx.notify('Cloning session…');
      return true;
    case 'changelog':
      ctx.notify('/changelog: see https://github.com/earendil-works/pi for release notes (no bundled changelog in this build)');
      return true;

    // --- recognized builtins with no Phase-4 wire path --------------------
    case 'hotkeys':
      ctx.notify(`/${name} is not available in attach (Phase 4)`);
      return true;

    default:
      // A builtin we listed but didn't special-case: treat as unsupported
      // rather than leak it to the LLM as literal text.
      ctx.notify(`/${name} is not available in attach (Phase 4)`);
      return true;
  }
}

/** Append the native canvas commands to a command list, skipping any already
 *  present (so they survive whatever list Unit Q feeds in — builtins, or the
 *  broker's `get_commands` result). The four canvas commands are viewer-owned,
 *  so they are always surfaced in autocomplete regardless of the source list. */
function withCanvasCommands(
  commands: ReadonlyArray<{ name: string; description?: string }>,
): ReadonlyArray<{ name: string; description?: string }> {
  const seen = new Set(commands.map((c) => c.name));
  return [...commands, ...CANVAS_SLASH_COMMANDS.filter((c) => !seen.has(c.name))];
}

/** Build slash-command autocomplete entries from the merged command list (the
 *  broker's `get_commands` result, which T7 may inject) — defaults to the
 *  vendored builtins. The native canvas commands are always appended. Shaped for
 *  pi-tui's `CombinedAutocompleteProvider`. */
export function slashCommandList(
  commands: ReadonlyArray<{ name: string; description?: string }> = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
  return withCanvasCommands(commands).map((c) => ({ name: c.name, description: c.description }));
}

/** Same list as flat autocomplete items (value/label/description). */
export function commandAutocompleteItems(
  commands: ReadonlyArray<{ name: string; description?: string }> = BUILTIN_SLASH_COMMANDS,
): AutocompleteItem[] {
  return withCanvasCommands(commands).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, description: c.description }));
}

// ---------------------------------------------------------------------------
// Canvas commands — native reimplementations of the canvas chrome extensions.
// ---------------------------------------------------------------------------

/** Dispatch one of the four native canvas commands. Always returns `true` (the
 *  command is viewer-owned — never forwarded to the engine as a prompt). */
function dispatchCanvasCommand(name: string, arg: string, ctx: SlashContext): true {
  switch (name) {
    case 'graph':
      // `/graph` is inherently the in-process GRAPH overlay (canvas-nav.ts
      // `toggleGraph`), NOT a tmux popup. The overlay is Unit C/Q's surface; this
      // unit registers the command + autocomplete entry and triggers the overlay
      // via the `onGraph` hook the integration unit wires in.
      if (ctx.onGraph) ctx.onGraph();
      else ctx.notify('The GRAPH overlay is not wired into the viewer yet');
      return true;
    case 'promote':
      promoteNode(arg, ctx);
      return true;
    case 'resume-node':
      // ← canvas-resume.ts: open the full-screen canvas navigator as a popup; on
      // Enter it focuses the chosen node back into THIS pane via `crtr node focus`.
      return resumeNode(ctx);
    case 'view':
      // ← canvas-view.ts: bare `/view` opens the picker, `/view <name>` opens that
      // view directly — each as a self-contained popup (no node-focus, no return-pane).
      return openView(arg, ctx);
    default:
      ctx.notify(`/${name} is not available in attach`);
      return true;
  }
}

/** Shape of `crtr node promote --json` (subset; see nodePromote in commands/node.ts). */
interface PromoteResult {
  kind?: string;
  roadmap_path?: string;
}

/** `/promote [kind]` ← canvas-commands.ts. Shells `crtr node promote --json` for
 *  this node (out-of-process), notifies the result, then triggers a turn so the
 *  persona injector steers in the new-role guidance at the turn boundary — exactly
 *  as the node would by running the command itself. */
function promoteNode(arg: string, ctx: SlashContext): void {
  const nodeId = (ctx.nodeId ?? process.env['CRTR_NODE_ID'] ?? '').trim();
  if (nodeId === '') {
    ctx.notify('/promote: no node to promote (viewer has no node id)');
    return;
  }
  const kind = arg.trim().toLowerCase();
  ctx.notify(kind ? `Promoting → ${kind}…` : 'Promoting…');

  const argv = ['node', 'promote', '--node', nodeId, '--json'];
  if (kind !== '') argv.push('--kind', kind);

  execFile('crtr', argv, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    // On a non-zero exit crtr still prints the structured error to stdout, so
    // prefer its `message` over the raw throw.
    let result: PromoteResult | null = null;
    let errMsg: string | null = null;
    try {
      result = JSON.parse(stdout) as PromoteResult;
    } catch {
      result = null;
    }
    if (err && result === null) {
      const out = typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : '';
      try {
        const payload = JSON.parse(out) as { message?: string };
        errMsg = typeof payload.message === 'string' ? payload.message : null;
      } catch {
        errMsg = null;
      }
      if (errMsg === null) errMsg = err.message;
    }

    if (result === null) {
      ctx.notify(`promote failed: ${errMsg ?? 'unknown error'}`);
      return;
    }
    const rmPath = (result.roadmap_path ?? '').trim();
    ctx.notify(
      `Promoted to ${result.kind ?? 'orchestrator'} orchestrator — authoring roadmap${rmPath !== '' ? ` (${rmPath})` : ''}.`,
    );
    // Trigger a turn so the persona injector (canvas-stophook turn_end) fires and
    // delivers the new-role guidance — the viewer's only turn-trigger is `prompt`.
    ctx.send({
      type: 'prompt',
      text:
        'You have just been promoted to an orchestrator. Your new-role guidance is arriving — read it, author your roadmap, and start delegating.',
    });
  });
}

/** `/resume-node` ← canvas-resume.ts. Opens `crtr canvas browse` as a tmux popup,
 *  scoped to this node's cwd; on Enter it focuses the chosen node back into this
 *  pane via `crtr node focus --pane` (which `canvas browse` shells). */
function resumeNode(ctx: SlashContext): true {
  const origPane = process.env['TMUX_PANE'];
  if (process.env['TMUX'] === undefined || origPane === undefined || origPane === '') {
    ctx.notify('/resume-node needs tmux');
    return true;
  }
  const cwd = shellQuote(ctx.cwd ?? process.cwd());
  const cmd = `crtr canvas browse --return-pane ${origPane} --cwd ${cwd}`;
  popup(cmd);
  return true;
}

/** `/view [name]` ← canvas-view.ts. Bare opens the picker (`crtr view pick`);
 *  `/view <name>` opens that view directly (`crtr view run <name>`). Self-contained
 *  popup — no node-focus, no return-pane. */
function openView(arg: string, ctx: SlashContext): true {
  if (process.env['TMUX'] === undefined) {
    ctx.notify('/view needs tmux');
    return true;
  }
  const name = arg.trim();
  const cmd = name === '' ? 'crtr view pick' : `crtr view run ${shellQuote(name)}`;
  popup(cmd);
  return true;
}

/** Open `cmd` as a fire-and-forget tmux display-popup (same geometry as the canvas
 *  extensions). tmux runs the trailing string through `sh -c`; the popup owns its
 *  screen and closes itself when the command exits, dropping back to this pane. */
function popup(cmd: string): void {
  try {
    execFile('tmux', ['display-popup', '-E', '-w', '90%', '-h', '85%', ...surfaceTmuxStyleArgs(), cmd], () => {
      /* best-effort: popup is self-contained */
    });
  } catch {
    /* best-effort */
  }
}

/** Single-quote a string for safe interpolation into a `sh -c` command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------

function usage(ctx: SlashContext, form: string): true {
  ctx.notify(`Usage: ${form}`);
  return true;
}

function pickerHint(ctx: SlashContext, what: string, form: string): true {
  ctx.notify(`Interactive ${what} picker isn't available over view.sock yet — use ${form}`);
  return true;
}

/** Open a native picker if its opener is wired; otherwise fall back to the
 *  text-arg hint. Keeps every value-picker builtin working even when the
 *  read-op request channel is absent. */
function openOrHint(
  open: (() => void) | undefined,
  ctx: SlashContext,
  what: string,
  form: string,
): true {
  if (open) {
    open();
    return true;
  }
  return pickerHint(ctx, what, form);
}

function handleSettings(arg: string, ctx: SlashContext): true {
  const [sub, ...rest] = arg.split(/\s+/);
  const value = rest.join(' ').trim();
  switch (sub) {
    case 'thinking':
      if (!value) return usage(ctx, '/settings thinking <level>');
      if (!THINKING_LEVELS.has(value)) {
        ctx.notify(`Invalid thinking level "${value}" — choose one of: ${[...THINKING_LEVELS].join(', ')}`);
        return true;
      }
      ctx.send({ type: 'set_thinking_level', level: value as SetThinkingLevelFrame['level'] });
      return true;
    case 'auto-retry':
      ctx.send({ type: 'set_auto_retry', enabled: parseBool(value) });
      return true;
    case 'auto-compaction':
      ctx.send({ type: 'set_auto_compaction', enabled: parseBool(value) });
      return true;
    case '':
      // Bare `/settings` opens the native settings menu (falls back to the
      // sub-command summary when the picker channel is unwired).
      if (ctx.openSettingsPicker) {
        ctx.openSettingsPicker();
        return true;
      }
      return settingsSummary(ctx);
    default:
      return settingsSummary(ctx);
  }
}

function settingsSummary(ctx: SlashContext): true {
  ctx.notify('Settings: /settings thinking <level> | auto-retry on|off | auto-compaction on|off');
  return true;
}

function parseBool(value: string): boolean {
  return /^(on|true|yes|1|enabled?)$/i.test(value.trim());
}

function parseExport(arg: string, cwd: string): { path: string; format: 'html' | 'jsonl' } {
  const path = arg || `${cwd}/pi-export-${Date.now()}.html`;
  const format: 'html' | 'jsonl' = path.endsWith('.jsonl') ? 'jsonl' : 'html';
  return { path, format };
}

function describeSession(state?: BrokerSnapshot['state']): string {
  if (!state) return 'Session info unavailable';
  const name = state.sessionName ? `"${state.sessionName}" ` : '';
  return `Session ${name}${state.sessionId} · model ${state.model ?? 'unknown'} · thinking ${state.thinkingLevel}`;
}
