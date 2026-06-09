// slash-commands.ts — builtin slash-command parse + dispatch for `crtr attach` (C6).
//
// Builtin slash commands are NOT engine-interpreted: `session.prompt('/model')`
// ships "/model" to the LLM as literal text. So the viewer recognizes the 21
// vendored `BUILTIN_SLASH_COMMANDS` itself and dispatches the matching
// `ClientToBroker` command frame; only EXTENSION commands (anything the viewer
// doesn't recognize) fall through to be sent as a `prompt` for the engine's
// extension runner to handle.
//
// SELECTORS — the Phase-4 reality. The plan called for `/model`, `/resume`,
// `/fork`, `/tree`, `/settings` to open pi's exported `*SelectorComponent`s. The
// authoritative 0.78.1 .d.ts shows those components require ENGINE-side state a
// socket-only viewer does not have (`ModelSelectorComponent` needs the
// `ModelRegistry` + `SettingsManager`; `SessionSelectorComponent` needs session
// loaders; `TreeSelectorComponent` needs the `SessionTreeNode[]` tree), and the
// §1.2 command-frame floor set exposes NO read op to fetch any of it. So in
// Phase 4 these resolve via a TEXT ARGUMENT — `/model <id>`, `/resume <path>`,
// `/fork <entryId>`, `/tree <entryId>` — which sends the SAME resolved value the
// selector would have, i.e. zero engine capability is lost; only the interactive
// picker UI waits for a future read op. A no-arg invocation shows a one-line
// notice with the arg form. (This protocol gap is reported up to the parent.)
//
// SCOPED OUT (review m2 — no engine method): `/login`, `/logout`, `/share`,
// `/trust` — a brief "not supported in attach" notice, never a frame.

import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import { BUILTIN_SLASH_COMMANDS } from '../../core/runtime/pi-vendored.js';
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
}

/** Builtins with no Phase-4 engine method — scoped out (review m2). */
const SCOPED_OUT = new Set(['login', 'logout', 'share', 'trust']);

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

    // --- value-picker builtins: arg form (selector deferred, see header) ---
    case 'model':
      if (!arg) return pickerHint(ctx, 'model', '/model <id>');
      ctx.send({ type: 'set_model', model: arg });
      return true;
    case 'resume':
      if (!arg) return pickerHint(ctx, 'session', '/resume <session-path>');
      ctx.send({ type: 'switch_session', path: arg });
      return true;
    case 'fork':
      if (!arg) return pickerHint(ctx, 'fork point', '/fork <entryId>');
      ctx.send({ type: 'fork', entryId: arg });
      return true;
    case 'tree':
      if (!arg) return pickerHint(ctx, 'tree', '/tree <entryId>');
      ctx.send({ type: 'navigate_tree', targetId: arg });
      return true;

    // --- settings (sub-command form; interactive menu needs read ops) ------
    case 'settings':
      return handleSettings(arg, ctx);

    // --- read-only / informational ----------------------------------------
    case 'session':
      ctx.notify(describeSession(ctx.state));
      return true;

    // --- recognized builtins with no Phase-4 wire path --------------------
    case 'copy':
    case 'changelog':
    case 'hotkeys':
    case 'scoped-models':
    case 'clone':
      ctx.notify(`/${name} is not available in attach (Phase 4)`);
      return true;

    default:
      // A builtin we listed but didn't special-case: treat as unsupported
      // rather than leak it to the LLM as literal text.
      ctx.notify(`/${name} is not available in attach (Phase 4)`);
      return true;
  }
}

/** Build slash-command autocomplete entries from the merged command list (the
 *  broker's `get_commands` result, which T7 may inject) — defaults to the
 *  vendored builtins. Shaped for pi-tui's `CombinedAutocompleteProvider`. */
export function slashCommandList(
  commands: ReadonlyArray<{ name: string; description?: string }> = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
  return commands.map((c) => ({ name: c.name, description: c.description }));
}

/** Same list as flat autocomplete items (value/label/description). */
export function commandAutocompleteItems(
  commands: ReadonlyArray<{ name: string; description?: string }> = BUILTIN_SLASH_COMMANDS,
): AutocompleteItem[] {
  return commands.map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, description: c.description }));
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
    default:
      ctx.notify(
        'Settings: /settings thinking <level> | auto-retry on|off | auto-compaction on|off ' +
          '(the interactive settings menu needs data not exposed over view.sock in Phase 4)',
      );
      return true;
  }
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
