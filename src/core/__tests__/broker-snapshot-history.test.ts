// Run with: node --import tsx/esm --test src/core/__tests__/broker-snapshot-history.test.ts
//
// BUG-REGRESSION (real, observed; surfaced during the crouter-web build, proven
// broker-side). After a revive resumes a previously-CLOSED pi session, the
// broker's `welcome` snapshot must present the SAME ordered, complete turn
// history the persisted session `.jsonl` holds — no omitted or reordered turn.
//
// ROOT CAUSE: the broker's `buildSnapshot` served `session.messages`
// (= `agent.state.messages`, the agent's LIVE in-memory array). pi's recovery
// paths — auto-retry, context-overflow recovery, and compaction — SLICE the
// errored/superseded assistant message out of `state.messages` while
// DELIBERATELY keeping it on disk ("keep in session for history",
// agent-session.js). So `session.messages` can OMIT a turn the `.jsonl` still
// holds. crouter-web's static normalizer reads the full ordered history correctly
// (pi `SessionManager.buildSessionContext` over the file), so a dormant viewer
// saw the complete turn — then, after a revive, the broker's live welcome
// snapshot served the diverged (omitted) array. The fix makes the snapshot
// reconstruct from the persisted session tree (the SAME source the normalizer
// uses), so live == persisted == disk (single source of truth).
//
// This drives the REAL pi SDK offline (no tmux, no broker process, no network) —
// exactly the seam where the bug lives: it builds a real resumed broker session,
// SIMULATES pi's retry slice by popping the last assistant off the live
// `agent.state.messages` (leaving the persisted tree intact), and asserts the
// snapshot follows the persisted history, not the sliced live array.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
  type BrokerEngine,
} from '../runtime/broker-sdk.js';
import { buildBrokerSession, snapshotMessages } from '../runtime/broker.js';

const realEngine: BrokerEngine = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userMsg(text: string): any {
  return { role: 'user', content: [{ type: 'text', text }] };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistantMsg(text: string, stopReason = 'stop'): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'sonnet',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

test('broker welcome snapshot serves the persisted history, not pi\u2019s sliced live array (omit-on-revive regression)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'crtr-snaphist-'));
  try {
    // 1. Build a real persisted session whose tail mimics an auto-retried turn:
    //    user \u2192 errored assistant (kept on disk) \u2192 retried assistant. This is what
    //    pi's `.jsonl` holds after a retryable error (529 / overflow / network).
    const seed = SessionManager.create(cwd);
    seed.appendMessage(userMsg('q1'));
    seed.appendMessage(assistantMsg('a1'));
    seed.appendMessage(userMsg('q2 — triggers a retryable error'));
    seed.appendMessage(assistantMsg('errored attempt', 'error')); // kept in session for history
    seed.appendMessage(assistantMsg('retried answer')); // the successful retry
    const sessionFile = seed.getSessionFile()!;
    assert.ok(sessionFile, 'seed session persisted a .jsonl');

    // The persisted, ordered history a dormant reader / crouter-web normalizer sees.
    const persisted = SessionManager.open(sessionFile).buildSessionContext().messages;
    assert.equal(persisted.length, 5, 'disk holds all five messages incl. the errored attempt');

    // 2. Revive: the broker resumes the closed session via the SERVICES path.
    const { session } = await buildBrokerSession(realEngine, {
      cwd,
      extensionPaths: [],
      resumeSessionPath: sessionFile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    try {
      assert.equal(session.messages.length, 5, 'at boot the live array == persisted history');

      // 3. Simulate pi's auto-retry/overflow slice: it removes the errored
      //    assistant from agent.state.messages but KEEPS it on disk. We reproduce
      //    that exact mutation on the live array (the persisted tree is untouched).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const live = (session as any).agent.state.messages as unknown[];
      const popped = live.pop(); // drop the last assistant from the LIVE array only
      assert.equal((popped as { role: string }).role, 'assistant', 'sliced an assistant off the live array');
      assert.equal(session.messages.length, 4, 'the live array now OMITS the persisted turn');

      // 4. The bug: pre-fix `buildSnapshot` served `session.messages` (4) \u2014 omitting
      //    a turn the .jsonl still holds. The fix serves the persisted history (5),
      //    byte-identical to the normalizer.
      const snap = snapshotMessages(session);
      assert.equal(
        snap.length,
        persisted.length,
        'snapshot presents the COMPLETE persisted history (omit-on-revive regression)',
      );
      assert.notEqual(
        snap.length,
        session.messages.length,
        'snapshot does NOT echo the sliced live array',
      );
      assert.deepEqual(
        snap,
        persisted,
        'snapshot is byte-identical to the static normalizer\u2019s buildSessionContext (single source of truth)',
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
