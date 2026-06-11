// Regression: `/quit` in the attach viewer only sent a `bye` frame + a notice.
// The broker answers `bye` with socket.end(), which the viewer's close handler
// treats as a dropped connection and RECONNECTS — so `/quit` never detached (it
// silently reconnected). The fix routes `/quit` through an `onQuit` hook wired to
// teardown('detach'). Likewise `/copy` was a dead "not available" stub; it now
// runs through an `onCopy` hook. This guards the dispatch contract for both.
// See src/clients/attach/{slash-commands,input-controller,attach-cmd}.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlashCommand, type SlashContext } from '../slash-commands.js';

function ctx(overrides: Partial<SlashContext> = {}): SlashContext & {
  sent: unknown[];
  notices: string[];
} {
  const sent: unknown[] = [];
  const notices: string[] = [];
  return {
    send: (f) => sent.push(f),
    notify: (m) => notices.push(m),
    sent,
    notices,
    ...overrides,
  };
}

test('/quit detaches via onQuit and does NOT send a bare bye (reconnect-loop bug)', () => {
  let quit = 0;
  const c = ctx({ onQuit: () => quit++ });
  const handled = dispatchSlashCommand('/quit', c);
  assert.equal(handled, true);
  assert.equal(quit, 1, '/quit must invoke onQuit (teardown), not just send bye');
  assert.equal(c.sent.length, 0, '/quit must not send a bare bye frame when onQuit is wired');
});

test('/quit falls back to a bye frame when onQuit is unwired', () => {
  const c = ctx();
  dispatchSlashCommand('/quit', c);
  assert.deepEqual(c.sent, [{ type: 'bye' }]);
});

test('/copy runs through onCopy instead of the dead "not available" stub', () => {
  let copy = 0;
  const c = ctx({ onCopy: () => copy++ });
  const handled = dispatchSlashCommand('/copy', c);
  assert.equal(handled, true);
  assert.equal(copy, 1, '/copy must invoke onCopy');
  assert.equal(c.notices.length, 0, '/copy must not fall through to a notice when onCopy is wired');
});
