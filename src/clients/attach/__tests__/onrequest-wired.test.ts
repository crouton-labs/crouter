// Regression: the `crtr attach` viewer built its InputController WITHOUT the
// `onRequest` hook, so the correlated read-op channel was never wired even
// though ViewSocketClient.request() was fully implemented. Every native picker
// (/model, /resume, /fork, /tree, /settings, /scoped-models) therefore degraded
// to the "isn't available in this viewer" notice — /model couldn't open the
// model picker. The fix wires `onRequest: (frame) => socket.request(frame)` in
// attach-cmd. This assembly lives inside a big TUI-constructing function with no
// seam to unit-test, so this guards the exact wiring at the source level.
// See src/clients/attach/{attach-cmd,input-controller,slash-commands}.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'attach-cmd.ts'),
  'utf8',
);

test('attach-cmd wires onRequest to socket.request so native pickers work', () => {
  // The InputController must receive the read-op channel; without it
  // openPicker() short-circuits to the "isn't available in this viewer" notice.
  assert.match(
    src.replace(/\s+/g, ' '),
    /onRequest:\s*\(frame\)\s*=>\s*socket\.request\(frame\)/,
    'attach-cmd must pass onRequest: (frame) => socket.request(frame) to InputController',
  );
});
