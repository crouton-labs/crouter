// Regression: typing `!cmd` in the attach viewer was sent to the engine as a
// normal PROMPT (the LLM saw the literal `!cmd` and took a turn) instead of
// running bash and injecting the output into context with no agent turn — pi's
// native `!`/`!!` semantics. The fix routes a leading `!` in InputController to a
// `bash` drive frame (and `!!` to one with excludeFromContext). These tests lock
// the routing decision (the user-visible crux) so it can't silently revert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TUI, ProcessTerminal } from '@earendil-works/pi-tui';
import { TitledEditor } from '../titled-editor.js';
import { InputController, type InputControllerHooks } from '../input-controller.js';
import { createKeybindingsManager } from '../config-load.js';
import type { ClientToBroker } from '../../../core/runtime/broker-protocol.js';

const ENTER = '\r';

function build(): { editor: TitledEditor; frames: ClientToBroker[] } {
  const agentDir = mkdtempSync(join(tmpdir(), 'crtr-bang-'));
  const km = createKeybindingsManager(agentDir);
  const tui = new TUI(new ProcessTerminal());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = new TitledEditor(tui, { borderColor: (s: string) => s, selectList: {} } as any, km as any, {
    paddingX: 1,
  });
  const frames: ClientToBroker[] = [];
  const hooks: InputControllerHooks = {
    onCommand: (f) => frames.push(f),
    onDialogResponse: () => {},
  };
  // eslint-disable-next-line no-new -- wiring the editor.onSubmit handler is the point
  new InputController(tui, editor as never, km as never, hooks);
  return { editor, frames };
}

test('`!cmd` routes to a bash frame, not a prompt', () => {
  const { editor, frames } = build();
  editor.setText('!ls -la');
  editor.handleInput(ENTER);
  assert.deepEqual(frames, [{ type: 'bash', command: 'ls -la', excludeFromContext: false }]);
  assert.equal(editor.getText(), '', 'editor clears after a bash submit');
});

test('`!!cmd` routes to a bash frame with excludeFromContext', () => {
  const { editor, frames } = build();
  editor.setText('!!echo secret');
  editor.handleInput(ENTER);
  assert.deepEqual(frames, [{ type: 'bash', command: 'echo secret', excludeFromContext: true }]);
});

test('a bare `!` with no command is ignored (no frame, text kept)', () => {
  const { editor, frames } = build();
  editor.setText('!   ');
  editor.handleInput(ENTER);
  assert.equal(frames.length, 0, 'a bare `!` must not emit a bash frame');
});

test('ordinary text still routes to a prompt frame (no regression)', () => {
  const { editor, frames } = build();
  editor.setText('hello world');
  editor.handleInput(ENTER);
  assert.deepEqual(frames, [{ type: 'prompt', text: 'hello world' }]);
});
