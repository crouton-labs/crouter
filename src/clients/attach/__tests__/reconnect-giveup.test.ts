// Regression: the `crtr attach` viewer used to ALWAYS teardown ("broker gone")
// on a socket close, so a resident broker node's yield→revive cycle dropped the
// viewer to a shell. The fix holds the pane and re-dials the SAME view.sock
// while the node is still alive, giving up only when it is genuinely gone. This
// locks the give-up/keep-reconnecting decision (the bug-prone core) without a
// socket or tmux. See src/clients/attach/{view-socket,attach-cmd}.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconnectShouldGiveUp } from '../view-socket.js';
import type { NodeRow, NodeStatus } from '../../../core/canvas/types.js';

const rowWith = (status: NodeStatus): NodeRow =>
  ({
    node_id: 'n',
    status,
    host_kind: 'broker',
    intent: null,
    pi_pid: null,
  }) as unknown as NodeRow;

test('keeps reconnecting while the node is still alive (active = mid yield/revive)', () => {
  // A yield leaves status='active' (intent='refresh') — must NOT give up.
  assert.equal(reconnectShouldGiveUp(rowWith('active')), false);
  // idle-release revives on the next inbox wake — keep trying (bounded by the
  // supervisor's own ~30s deadline), do not give up.
  assert.equal(reconnectShouldGiveUp(rowWith('idle')), false);
});

test('gives up the instant the node is genuinely gone', () => {
  assert.equal(reconnectShouldGiveUp(rowWith('done')), true);
  assert.equal(reconnectShouldGiveUp(rowWith('dead')), true);
  assert.equal(reconnectShouldGiveUp(rowWith('canceled')), true);
  // A reaped row (null) → give up.
  assert.equal(reconnectShouldGiveUp(null), true);
});
