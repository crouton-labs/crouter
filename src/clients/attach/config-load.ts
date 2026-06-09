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
import { initTheme } from '@earendil-works/pi-coding-agent';

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
  'app.message.followUp': { defaultKeys: 'alt+enter', description: 'Queue follow-up message' },
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
export function createKeybindingsManager(agentDir = defaultAgentDir()): KeybindingsManager {
  const definitions = { ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS } as unknown as KeybindingDefinitions;
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
