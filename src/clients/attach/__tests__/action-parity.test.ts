// Regression: the `crtr attach` viewer's InputController wired only a subset of
// pi's editor `app.*` actions, so several keys that work in pi were dead in the
// attach surface — most visibly Ctrl+O (toggle tool output) and Ctrl+T (toggle
// thinking blocks), but also Ctrl+G (external editor), Shift+Tab (cycle thinking
// level), Shift+Ctrl+P (cycle model backward), and Alt+Up (dequeue). The broker
// already supported every one of these frames; only the client-side onAction
// wiring was missing. The fix wires them in input-controller's wire() and adds
// the ChatView render toggles for the two display-only ones. This assembly lives
// inside TUI-constructing code with no unit seam, so we guard the wiring at the
// source level (mirrors onrequest-wired.test.ts).
// See src/clients/attach/{input-controller,chat-view,attach-cmd}.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string): string =>
  readFileSync(join(here, '..', file), 'utf8').replace(/\s+/g, ' ');

const inputController = read('input-controller.ts');
const chatView = read('chat-view.ts');
const attachCmd = read('attach-cmd.ts');

test('input-controller wires every previously-dead app.* editor action', () => {
  for (const action of [
    'app.tools.expand', // Ctrl+O — toggle tool output
    'app.thinking.toggle', // Ctrl+T — toggle thinking blocks
    'app.thinking.cycle', // Shift+Tab — cycle thinking level
    'app.model.cycleBackward', // Shift+Ctrl+P — cycle model backward
    'app.message.dequeue', // Alt+Up — restore queued messages
    'app.editor.external', // Ctrl+G — external editor
  ]) {
    assert.match(
      inputController,
      new RegExp(`onAction\\(\\s*'${action.replace(/\./g, '\\.')}'`),
      `input-controller must register onAction('${action}')`,
    );
  }
});

test('cycle_model carries an explicit direction in both directions', () => {
  assert.match(inputController, /type:\s*'cycle_model',\s*direction:\s*'forward'/);
  assert.match(inputController, /type:\s*'cycle_model',\s*direction:\s*'backward'/);
});

test('ChatView exposes the Ctrl+O / Ctrl+T render toggles', () => {
  assert.match(chatView, /toggleToolsExpanded\(\)/, 'ChatView needs toggleToolsExpanded()');
  assert.match(chatView, /toggleThinking\(\)/, 'ChatView needs toggleThinking()');
  // The toggles must actually fan out to the rendered children, not just flip a flag.
  assert.match(chatView, /child\.setExpanded\(this\.toolOutputExpanded\)/);
  assert.match(chatView, /child\.setHideThinkingBlock\(this\.hideThinking\)/);
});

test('attach-cmd connects the ChatView toggles to the input controller', () => {
  assert.match(attachCmd, /onToggleToolsExpand:\s*\(\)\s*=>[\s\S]*chatView\.toggleToolsExpanded\(\)/);
  assert.match(attachCmd, /onToggleThinking:\s*\(\)\s*=>[\s\S]*chatView\.toggleThinking\(\)/);
});
