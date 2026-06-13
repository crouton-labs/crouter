// Regression (#11): in the attach viewer, Alt+Enter did NOTHING on an INSTALLED
// (non-deduped) crtr — not a newline, not a submit. Root cause: pi-coding-agent's
// CustomEditor resolves `@earendil-works/pi-tui` from its OWN node_modules, a
// SEPARATE module instance from the one `config-load` imports. The base Editor
// reads `getKeybindings()` from THAT instance — stuck at the default
// `tui.input.newLine = shift+enter` unless the `mirrorKeybindingsToEditor` shim
// (best-effort, `import.meta.resolve`-based) succeeds in registering crtr's
// manager on it. On install layouts where that mirror silently fails, the
// `alt+enter → newLine` override never reached the editor and Alt+Enter
// (`\x1b[13;3u`) matched neither newLine nor submit and fell through.
//
// The fix makes the chord self-contained: `TitledEditor.handleInput` matches
// newLine against crtr's OWN KeybindingsManager (the one CustomEditor already
// uses for `app.*`) and inserts the newline directly, so it no longer depends on
// the cross-instance mirror. The third test below builds the editor WITHOUT the
// mirror and is the real guard for the installed-layout failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TUI, ProcessTerminal } from '@earendil-works/pi-tui';
import { TitledEditor } from '../titled-editor.js';
import { createKeybindingsManager, mirrorKeybindingsToEditor } from '../config-load.js';

// Kitty CSI-u: `\x1b[<codepoint>;<1+mods>u`. enter=13, alt=2 → mods byte 3.
const ALT_ENTER = '\x1b[13;3u';
const ENTER = '\r';

async function buildEditor(): Promise<TitledEditor> {
  // Empty agent dir → no user keybindings.json, so the binding under test is the
  // attach DEFAULT (`ATTACH_KEYBINDING_OVERRIDES` adds alt+enter to newLine).
  const agentDir = mkdtempSync(join(tmpdir(), 'crtr-kb-'));
  const km = createKeybindingsManager(agentDir);
  await mirrorKeybindingsToEditor(km); // mirror still runs for general tui.* parity
  const tui = new TUI(new ProcessTerminal());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TitledEditor(tui, { borderColor: (s: string) => s, selectList: {} } as any, km as any, {
    paddingX: 1,
  });
}

test('attach editor inserts a newline on Alt+Enter (cross-instance binding reaches the editor)', async () => {
  const editor = await buildEditor();
  let submitted: string | null = null;
  editor.onSubmit = (t) => {
    submitted = t;
  };
  editor.setText('hello');
  editor.handleInput(ALT_ENTER);
  assert.equal(editor.getText(), 'hello\n', 'Alt+Enter must insert a newline, not be swallowed');
  assert.equal(submitted, null, 'Alt+Enter must not submit');
});

test('attach editor still submits on plain Enter', async () => {
  const editor = await buildEditor();
  let submitted: string | null = null;
  editor.onSubmit = (t) => {
    submitted = t;
  };
  editor.setText('hello');
  editor.handleInput(ENTER);
  assert.equal(submitted, 'hello', 'plain Enter must submit');
  assert.equal(editor.getText(), '', 'editor clears after submit');
});

test('attach editor inserts a newline on Alt+Enter even WITHOUT the cross-instance mirror (#11)', async () => {
  // Reproduces the installed-layout failure: the editor's pi-tui instance never
  // received crtr's alt+enter override (mirror not run). TitledEditor.handleInput
  // must still newline by matching crtr's own km directly.
  const agentDir = mkdtempSync(join(tmpdir(), 'crtr-kb-'));
  const km = createKeybindingsManager(agentDir);
  // NOTE: deliberately NOT calling mirrorKeybindingsToEditor.
  const tui = new TUI(new ProcessTerminal());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = new TitledEditor(tui, { borderColor: (s: string) => s, selectList: {} } as any, km as any, {
    paddingX: 1,
  });
  let submitted: string | null = null;
  editor.onSubmit = (t) => {
    submitted = t;
  };
  editor.setText('hello');
  editor.handleInput(ALT_ENTER);
  assert.equal(editor.getText(), 'hello\n', 'Alt+Enter must newline without relying on the mirror');
  assert.equal(submitted, null, 'Alt+Enter must not submit');
});
