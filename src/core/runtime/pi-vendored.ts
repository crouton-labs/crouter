// pi-vendored.ts — symbols copied verbatim from pi that pi does NOT re-export.
//
// VENDORED, not imported, because pi's `exports` map is `.`-only (+`./hooks`):
// a deep import like `@earendil-works/pi-coding-agent/dist/core/slash-commands`
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED, and the symbol is absent from the
// package-root `index.d.ts` at BOTH 0.78.1 and 0.79.0 — so there is no pin at
// which it becomes importable (review C1). The only safe access is to copy it.
//
// MAINTENANCE: re-sync on EVERY pi SDK bump. The source of truth is
// `node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js`.
// If the upstream list changes (entries added/removed/reworded), update the copy
// below to match and adjust the count note.

/**
 * pi's builtin slash commands — vendored verbatim from pi `core/slash-commands.js`
 * `BUILTIN_SLASH_COMMANDS` (review C1). **21 entries at 0.78.1** (review n1 — NOT 23).
 *
 * Builtins are NOT engine-interpreted (`session.prompt('/model')` ships `/model`
 * to the LLM as literal text), so the broker's `get_commands` op MERGES this list
 * with the engine's registered commands/templates/skills, and the viewer
 * autocomplete parses these locally. Both the broker (T3) and the viewer (T6)
 * import this single copy.
 *
 * Upstream interpolates `${APP_NAME}` into the `quit` description; `APP_NAME`
 * defaults to "pi" (overridable via pi config), so the vendored copy hardcodes
 * "Quit pi".
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)' },
  { name: 'import', description: 'Import and resume a session from a JSONL file' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session at the current position' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'login', description: 'Configure provider authentication' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, and themes' },
  { name: 'quit', description: 'Quit pi' },
];
