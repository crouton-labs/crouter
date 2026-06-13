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
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { surfaceBgAnsi } from '../../core/runtime/surface-bg.js';

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
 * pi-coding-agent's `CustomEditor` resolves `@earendil-works/pi-tui` from its OWN
 * `node_modules`, which can be a SEPARATE module instance from the one this file
 * imports (a non-deduped install leaves a nested copy). The editor's newline /
 * submit handling reads keybindings AND the kitty-protocol flag from THAT
 * instance's module-globals via `getKeybindings()` / `isKittyProtocolActive()`,
 * so state we set only on our copy is invisible to it — the user's `alt+enter`
 * newline binding never applies and Enter falls through to submit. We mirror our
 * state onto the editor's instance too. When the install IS deduped both resolve
 * to one module and the mirror is a harmless re-set. Best-effort: a resolution /
 * import failure leaves the editor on our copy's state (the deduped case).
 */
let editorPiTuiPromise:
  | Promise<typeof import('@earendil-works/pi-tui') | undefined>
  | undefined;

function editorPiTui(): Promise<typeof import('@earendil-works/pi-tui') | undefined> {
  if (!editorPiTuiPromise) {
    editorPiTuiPromise = (async () => {
      try {
        const pcaEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
        const piTuiPath = createRequire(pcaEntry).resolve('@earendil-works/pi-tui');
        return (await import(pathToFileURL(piTuiPath).href)) as typeof import('@earendil-works/pi-tui');
      } catch {
        return undefined;
      }
    })();
  }
  return editorPiTuiPromise;
}

/** Register the manager on the editor's pi-tui instance too (see `editorPiTui`),
 *  so the editor's newline/submit handling honors the same (user-overridden)
 *  bindings as the rest of the viewer. Call once, after `createKeybindingsManager`. */
export async function mirrorKeybindingsToEditor(km: KeybindingsManager): Promise<void> {
  (await editorPiTui())?.setKeybindings(km);
}

/** Mirror the negotiated kitty-keyboard-protocol flag onto the editor's pi-tui
 *  instance (ProcessTerminal sets it only on OUR copy). Call after the terminal
 *  has negotiated, i.e. after `tui.start()`. */
export async function mirrorKittyProtocolToEditor(active: boolean): Promise<void> {
  (await editorPiTui())?.setKittyProtocolActive(active);
}

/**
 * Resolve the `fd` binary path the @-mention file picker needs. pi-tui's
 * `CombinedAutocompleteProvider` only returns file suggestions when handed an
 * `fdPath` (its third ctor arg) — without it, typing `@` triggers the picker but
 * `getFuzzyFileSuggestions` returns `[]`, so the picker never appears (issue #6).
 * pi's own interactive mode resolves this via `ensureTool('fd')` from its
 * internal `utils/tools-manager` (checks pi's managed bin dir + system PATH,
 * downloading the binary if missing). That module is NOT on pi-coding-agent's
 * `.`-only export map, so we reach it the same way we reach the editor's pi-tui
 * instance: resolve the package entry, then import the sibling file by URL
 * (file URLs bypass the bare-specifier exports gate). Best-effort: any
 * resolution/import failure (or no fd available) → `null`, and the picker stays
 * file-less rather than crashing.
 */
let fdPathPromise: Promise<string | null> | undefined;

export function resolveFdPath(): Promise<string | null> {
  if (!fdPathPromise) {
    fdPathPromise = (async () => {
      try {
        const pcaEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
        const toolsManagerUrl = new URL('./utils/tools-manager.js', pcaEntry).href;
        const toolsManager = (await import(toolsManagerUrl)) as {
          ensureTool(tool: 'fd' | 'rg', silent?: boolean): Promise<string | undefined>;
        };
        return (await toolsManager.ensureTool('fd', true)) ?? null;
      } catch {
        return null;
      }
    })();
  }
  return fdPathPromise;
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
  /** Distinct-surface paint for a modal/overlay: wraps a WHOLE rendered line so
   *  it sits on the theme's `selectedBg` background, edge to edge, re-asserting
   *  the bg after every embedded full-reset so an inner `\x1b[0m` (a status dot,
   *  the cursor bar) can't punch a hole in the surface. Closes with a bg-only
   *  reset so the surface never bleeds past the line. */
  surface: (s: string) => string;
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
  // The distinct-surface bg-on SGR, captured once. Re-asserted after every
  // embedded `\x1b[0m` (full reset) inside a line so a coloured cell can't drop
  // back to the default background mid-row; the line ends with `\x1b[49m` (reset
  // background only) so the surface never bleeds onto the next line.
  const bgOn = surfaceBgAnsi();
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
    surface: (line) => `${bgOn}${line.replace(/\x1b\[0m/g, `\x1b[0m${bgOn}`)}\x1b[49m`,
  };
}
