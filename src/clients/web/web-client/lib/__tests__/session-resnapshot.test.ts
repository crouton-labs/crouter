import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldResnapshot,
  resnapshotDelay,
  MAX_RESNAPSHOT_ATTEMPTS,
} from '../session-resnapshot.js';

const live = { dormant: true, status: 'active', socketReady: true, attempt: 0 } as const;

test('shouldResnapshot: cold-start static on a live node, socket open', () => {
  assert.equal(shouldResnapshot({ ...live }), true);
});

test('shouldResnapshot: false when the stream is already live (not dormant)', () => {
  assert.equal(shouldResnapshot({ ...live, dormant: false }), false);
});

test('shouldResnapshot: false for a genuinely-dormant node (preserves Revive)', () => {
  for (const status of ['idle', 'done', 'dead', 'canceled']) {
    assert.equal(shouldResnapshot({ ...live, status }), false, `status=${status}`);
  }
});

test('shouldResnapshot: false while detail status is still loading (null)', () => {
  assert.equal(shouldResnapshot({ ...live, status: null }), false);
});

test('shouldResnapshot: false until the socket is genuinely open (no reconnect storm)', () => {
  assert.equal(shouldResnapshot({ ...live, socketReady: false }), false);
});

test('shouldResnapshot: bounded — stops after MAX attempts', () => {
  assert.equal(shouldResnapshot({ ...live, attempt: MAX_RESNAPSHOT_ATTEMPTS - 1 }), true);
  assert.equal(shouldResnapshot({ ...live, attempt: MAX_RESNAPSHOT_ATTEMPTS }), false);
});

test('resnapshotDelay: exponential backoff, capped', () => {
  assert.equal(resnapshotDelay(0), 400);
  assert.equal(resnapshotDelay(1), 800);
  assert.equal(resnapshotDelay(2), 1600);
  assert.equal(resnapshotDelay(3), 3200);
  assert.equal(resnapshotDelay(4), 4000); // capped
  assert.equal(resnapshotDelay(10), 4000);
});
