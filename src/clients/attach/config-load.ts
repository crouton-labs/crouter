// config-load.ts — load the user's pi keybindings + theme for `crtr attach` (M8).
//
// These loaders are CLI-layer: pi does the *resolution* (the KeybindingsManager
// matcher, `initTheme`) but the FILE reads are not reusable from pi, so we own
// them. We read pi's own config locations so an attach viewer honors the same
// `~/.pi/agent/keybindings.json` + theme the user already configured for pi.
//
// THE KEYBINDINGS MANAGER. pi's app-level KeybindingsManager (`core/keybindings`,
// with `.create()` + the `app.*` definition table `KEYBINDINGS`) is NOT exported
// — only its TYPE is re-exported, and the `KEYBINDINGS` const not at all. So we
// construct pi-tui's KeybindingsManager (the base class CustomEditor actually
// matches against) over the merged definition set: pi-tui's `TUI_KEYBINDINGS`
// (editor/cursor/select bindings) + a VENDORED copy of pi's `app.*` editor
// bindings below (required — CustomEditor.handleInput gates onEscape/onPasteImage/
// onAction on `keybindings.matches(data, "app.*")`, so without the app defs those
// never fire). We also register it globally via `setKeybindings` so the reused
// pi-tui components (SelectList autocomplete, the dialog editor) honor overrides.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';

/** pi's user config dir: `~/.pi/agent/`. */
export function defaultAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

/**
 * pi's `app.*` editor keybindings — VENDORED from pi `core/keybindings.ts`
 * `KEYBINDINGS` (the const is not exported; review-C1 pattern). This is the
 * subset CustomEditor's main editor consults; the selector-internal bindings
 * (`app.tree.*`, `app.models.*`, session delete/rename) are omitted because the
 * attach viewer does not open those selectors in Phase 4. Re-sync on each SDK
 * bump against `core/keybindings.js`.
 */
const APP_KEYBINDINGS = {
  'app.interrupt': { defaultKeys: 'escape', description: 'Cancel or abort' },
  'app.clear': { defaultKeys: 'ctrl+c', description: 'Clear editor' },
  'app.exit': { defaultKeys: 'ctrl+d', description: 'Exit when editor is empty' },
  'app.suspend': { defaultKeys: 'ctrl+z', description: 'Suspend to background' },
  'app.thinking.cycle': { defaultKeys: 'shift+tab', description: 'Cycle thinking level' },
  'app.model.cycleForward': { defaultKeys: 'ctrl+p', description: 'Cycle to next model' },
  'app.model.cycleBackward': { defaultKeys: 'shift+ctrl+p', description: 'Cycle to previous model' },
  'app.model.select': { defaultKeys: 'ctrl+l', description: 'Open model selector' },
  'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Toggle tool output' },
  'app.thinking.toggle': { defaultKeys: 'ctrl+t', description: 'Toggle thinking blocks' },
  'app.editor.external': { defaultKeys: 'ctrl+g', description: 'Open external editor' },
  // Alt+Enter inserts a newline in the attach editor (shift+enter is unreliable
  // across terminals), so the follow-up-queue action drops its alt+enter default
  // to free the chord — see ATTACH_KEYBINDING_OVERRIDES below.
  'app.message.followUp': { defaultKeys: [], description: 'Queue follow-up message' },
  'app.message.dequeue': { defaultKeys: 'alt+up', description: 'Restore queued messages' },
  'app.clipboard.pasteImage': { defaultKeys: ['alt+v', 'ctrl+v'], description: 'Paste image from clipboard' },
  'app.session.new': { defaultKeys: [], description: 'Start a new session' },
  'app.session.tree': { defaultKeys: [], description: 'Open session tree' },
  'app.session.fork': { defaultKeys: [], description: 'Fork current session' },
  'app.session.resume': { defaultKeys: [], description: 'Resume a session' },
} satisfies Record<string, { defaultKeys: string | string[]; description: string }>;

/**
 * Read `~/.pi/agent/keybindings.json` (if present) and return the user's binding
 * overrides. Tolerates a flat `{action: keys}` map or a `{keybindings: {...}}`
 * wrapper; a missing/malformed file → `undefined` (fall back to defaults).
 */
export function loadUserKeybindings(agentDir = defaultAgentDir()): KeybindingsConfig | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(agentDir, 'keybindings.json'), 'utf8'));
    const obj =
      raw && typeof raw === 'object' && 'keybindings' in raw
        ? (raw as { keybindings: unknown }).keybindings
        : raw;
    if (!obj || typeof obj !== 'object') return undefined;
    return obj as KeybindingsConfig;
  } catch {
    return undefined;
  }
}

/**
 * Build the KeybindingsManager the attach viewer drives input with: TUI defaults
 * + vendored `app.*` defs, with the user's overrides applied, registered as the
 * global pi-tui keybindings so reused components pick up the same bindings.
 * (`as unknown as` bridges the readonly `TUI_KEYBINDINGS`/string-literal defs to
 * the mutable `KeybindingDefinitions` param — vendoring cast, no behavior change.)
 */
/**
 * Attach-specific default overrides applied OVER pi's TUI defaults. Alt+Enter
 * inserts a newline here (the follow-up-queue action gives up its alt+enter
 * default above), because shift+enter — pi's stock newline chord — does not
 * transmit a distinct sequence in many terminals. User `keybindings.json` still
 * wins on top of these (applied as the manager's override config).
 */
const ATTACH_KEYBINDING_OVERRIDES = {
  'tui.input.newLine': { defaultKeys: ['shift+enter', 'alt+enter'], description: 'Insert new line' },
} satisfies Record<string, { defaultKeys: string | string[]; description: string }>;

export function createKeybindingsManager(agentDir = defaultAgentDir()): KeybindingsManager {
  const definitions = {
    ...TUI_KEYBINDINGS,
    ...APP_KEYBINDINGS,
    ...ATTACH_KEYBINDING_OVERRIDES,
  } as unknown as KeybindingDefinitions;
  const km = new KeybindingsManager(definitions, loadUserKeybindings(agentDir));
  setKeybindings(km);
  return km;
}

/**
 * The user's theme name from pi settings — project (`<cwd>/.pi/settings.json`)
 * overrides global (`~/.pi/agent/settings.json`). `undefined` → pi's default.
 */
export function loadThemeName(opts?: { agentDir?: string; cwd?: string }): string | undefined {
  const files = [
    join(opts?.cwd ?? process.cwd(), '.pi', 'settings.json'),
    join(opts?.agentDir ?? defaultAgentDir(), 'settings.json'),
  ];
  for (const file of files) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && typeof (raw as { theme?: unknown }).theme === 'string') {
        return (raw as { theme: string }).theme;
      }
    } catch {
      /* missing/malformed — try the next location */
    }
  }
  return undefined;
}

/** Resolve + activate the user's theme so the reused pi components (markdown,
 *  editor, select-list themes) render at parity with the user's pi. */
export function applyTheme(opts?: { agentDir?: string; cwd?: string }): void {
  initTheme(loadThemeName(opts));
}

/**
 * The named styling roles the attach chrome paints with, all theme-derived so the
 * viewer matches whatever theme the user configured for pi. Each is a
 * `str => str` colorizer applied to a whole token.
 */
export interface AttachPalette {
  /** Headings / badges / panel titles — the theme accent (gold in the default). */
  accent: (s: string) => string;
  /** Live/active markers + the working spinner — the theme's bright accent (teal). */
  active: (s: string) => string;
  /** Informational values (model name, counts) — the theme link color (blue). */
  info: (s: string) => string;
  /** Secondary text — the theme muted gray. */
  muted: (s: string) => string;
  /** Least-important text — SGR faint (a style, not a hue). */
  faint: (s: string) => string;
  /** Border rules / frames — the theme border color. */
  border: (s: string) => string;
  /** Emphasis. */
  bold: (s: string) => string;
  /** Error text. pi's public theme API does NOT surface the `error` ThemeColor
   *  (only markdown/select-list/settings-list derived colors are re-exported), so
   *  this is the semantically-correct ANSI red — NOT an ad-hoc hardcode. */
  error: (s: string) => string;
  /** Warning / transient notices. Same constraint as `error` → ANSI yellow. */
  warning: (s: string) => string;
}

const FAINT = (s: string): string => `\x1b[2m${s}\x1b[22m`;
const RED = (s: string): string => `\x1b[31m${s}\x1b[39m`;
const YELLOW = (s: string): string => `\x1b[33m${s}\x1b[39m`;

/**
 * Build the attach chrome's color palette from the LIVE theme. Call AFTER
 * `applyTheme()` — the colors are pulled from pi's `getMarkdownTheme()` /
 * `getSelectListTheme()`, which read the active theme singleton at call time.
 *
 * pi does not re-export the raw `Theme` instance (its `.` export map omits the
 * `theme` const and `getEditorTheme`/`getTheme`), so the accent/border/muted hues
 * are sourced from the markdown + select-list theme colorizers, which ARE
 * re-exported and are themselves backed by `theme.fg(...)`. The two semantic
 * colors pi never exposes through that surface — `error`/`warning` — fall back to
 * standard ANSI red/yellow.
 */
export function attachPalette(): AttachPalette {
  const md = getMarkdownTheme();
  const sel = getSelectListTheme();
  return {
    accent: md.heading,
    active: md.code,
    info: md.link,
    muted: sel.description,
    faint: FAINT,
    border: md.hr,
    bold: md.bold,
    error: RED,
    warning: YELLOW,
  };
}
