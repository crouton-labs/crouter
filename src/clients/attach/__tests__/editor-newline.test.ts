// Regression: in the attach viewer, Alt+Enter did NOTHING — not a newline, not a
// submit. The editor was SWALLOWING it. Root cause: pi-coding-agent's
// CustomEditor resolves `@earendil-works/pi-tui` from its OWN node_modules, a
// SEPARATE module instance from the one `config-load` imports (a non-deduped
// install). config-load registered the KeybindingsManager only on its copy, but
// the editor's super reads `getKeybindings()` from ITS instance — stuck at the
// default `tui.input.newLine = shift+enter`. So the attach `alt+enter → newLine`
// binding was invisible to the editor: Alt+Enter (`\x1b[13;3u`) matched neither
// newLine nor submit and fell through. `mirrorKeybindingsToEditor` registers the
// SAME manager on the editor's pi-tui instance; this test feeds the exact
// Alt+Enter / Enter byte sequences a terminal sends and asserts the behavior.
// See mirrorKeybindingsToEditor in src/clients/attach/config-load.ts.

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
  await mirrorKeybindingsToEditor(km); // the fix
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
