// Run with: node --import tsx/esm --test src/core/__tests__/error-stall-marker.test.ts
//
// BUG-REGRESSION (§I error-stall VISIBILITY; gh#4-adjacent — the 9h-zombie this
// feature surfaces). When a node's engine exhausts its retry budget on a rate-
// limit / overloaded / connection error, the broker stays ALIVE and the node is
// indistinguishable from a healthy dormant node for up to ERROR_STALL_QUIET_MS.
// The error-stall MARKER makes that invisible window visible on the canvas-graph
// views. Two legs:
//   M1 — classifyEngineError: each kind + the fallback (the heuristic, order-
//        sensitive: rate-limit/overloaded checked before connection).
//   M2 — the marker round-trip through dashboardRowsAll: mark → the row shows
//        hanging (streaming forced false); clear → gone; a DEAD pid → not hanging
//        (the pid-AND gate makes a stale marker from a crashed broker harmless).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { classifyEngineError, isModelNotFoundError, markErrorStall, clearErrorStall } from '../runtime/error-stall.js';
import { dashboardRowsAll } from '../canvas/render.js';

// ---------------------------------------------------------------------------
// M1 — the heuristic classifier.
// ---------------------------------------------------------------------------
test('M1 classifyEngineError: each kind + fallback, order-sensitive', () => {
  // rate-limit.
  assert.equal(classifyEngineError('Rate limit exceeded'), 'rate-limit');
  assert.equal(classifyEngineError('HTTP 429 Too Many Requests'), 'rate-limit');
  assert.equal(classifyEngineError('you have exceeded your quota'), 'rate-limit');

  // overloaded.
  assert.equal(classifyEngineError('Overloaded'), 'overloaded');
  assert.equal(classifyEngineError('Error 529: server is temporarily unavailable'), 'overloaded');
  assert.equal(classifyEngineError('503 Service Unavailable'), 'overloaded');
  assert.equal(classifyEngineError('the server busy, try again'), 'overloaded');

  // connection.
  assert.equal(classifyEngineError('Connection error.'), 'connection');
  assert.equal(classifyEngineError('ECONNRESET'), 'connection');
  assert.equal(classifyEngineError('fetch failed'), 'connection');
  assert.equal(classifyEngineError('request timed out'), 'connection');

  // ORDER: a 429/529 whose text ALSO mentions connection/network must NOT be
  // swallowed by the connection match (rate-limit/overloaded are checked first).
  assert.equal(classifyEngineError('429 rate limit on this network connection'), 'rate-limit');
  assert.equal(classifyEngineError('529 overloaded — connection to upstream lost'), 'overloaded');

  // fallback.
  assert.equal(classifyEngineError('some unrecognized engine failure'), 'other');
  assert.equal(classifyEngineError(''), 'other');
});

// ---------------------------------------------------------------------------
// BUG-REGRESSION: a 404 not_found (configured model decommissioned/unavailable)
// must be detected so the broker fails the node over to the strong-anthropic
// ladder model instead of wedging on the same dead model forever. The verbatim
// text below is the engine error a node hit when its `anthropic/ultra` ladder
// cell pointed at a model the account could not reach.
// ---------------------------------------------------------------------------
test('isModelNotFoundError detects the provider 404 not_found that triggers strong-anthropic fallback', () => {
  const verbatim =
    'Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Claude Fable 5 is not available. Please use Opus 4.8. Learn more: https://www.anthropic.com/news/fable-mythos-access"},"request_id":"req_011CcHgqfwD2Hjg193Ym1Sys"}';
  assert.equal(isModelNotFoundError(verbatim), true);
  assert.equal(isModelNotFoundError('Error: 404 model not found'), true);
  assert.equal(isModelNotFoundError('the requested model does not exist'), true);

  // Must NOT fire on the transient outage kinds the auto-retry path already owns,
  // nor on an empty/unknown error — those are not "swap models" situations.
  assert.equal(isModelNotFoundError('HTTP 429 Too Many Requests'), false);
  assert.equal(isModelNotFoundError('503 Service Unavailable'), false);
  assert.equal(isModelNotFoundError('Connection error.'), false);
  assert.equal(isModelNotFoundError('Error: 404 unexpected endpoint /v1/foo'), false); // a 404 with no not-found/model signal
  assert.equal(isModelNotFoundError(''), false);
});

// ---------------------------------------------------------------------------
// M2 — the marker round-trip through dashboardRowsAll.
// ---------------------------------------------------------------------------
test('M2 dashboardRowsAll surfaces a hanging marker (pid-gated); clear removes it', async () => {
  const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-esm' });
  try {
    // A LIVE node (the test process pid is definitely alive).
    const liveId = h.fabricateBrokerNode({ kind: 'developer', status: 'active', pi_pid: process.pid });

    // A node whose recorded pid is DEAD (the pid-gate must read it not-hanging).
    // A child we spawn-then-let-exit gives a pid that is reliably gone.
    const dead = spawnSync('true', [], { stdio: 'ignore' });
    const deadPid = dead.pid ?? 2147483646; // `true` has already exited
    const deadId = h.fabricateBrokerNode({ kind: 'developer', status: 'active', pi_pid: deadPid });

    const find = (id: string) => dashboardRowsAll().find((r) => r.node_id === id);

    // No marker yet → not hanging.
    assert.equal(find(liveId)?.hanging ?? null, null, 'no marker → not hanging');

    // Mark the live node → its row shows hanging, classified, streaming forced off.
    markErrorStall(liveId, 'Rate limit exceeded (429)');
    const row = find(liveId);
    assert.notEqual(row?.hanging ?? null, null, 'marked live node → hanging set');
    assert.equal(row?.hanging?.kind, 'rate-limit', 'kind classified from the message');
    assert.equal(row?.streaming, false, 'hanging forces streaming false (mutually exclusive)');

    // A DEAD pid + a marker → NOT hanging (the pid-AND gate).
    markErrorStall(deadId, 'Connection error.');
    assert.equal(find(deadId)?.hanging ?? null, null, 'dead pid → marker ignored (pid gate)');

    // Clear → gone.
    clearErrorStall(liveId);
    assert.equal(find(liveId)?.hanging ?? null, null, 'cleared marker → not hanging');
  } finally {
    await h.dispose();
  }
});
