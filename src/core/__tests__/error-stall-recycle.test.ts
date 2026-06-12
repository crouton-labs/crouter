// Run with: node --import tsx/esm --test src/core/__tests__/error-stall-recycle.test.ts
//
// BUG-REGRESSION (§I error-stall; gh issue #4 — node mqaeqzdu-0746b3b7, a 9h
// zombie). A provider outage exhausted the engine's SDK retry budget mid-task:
// pi appended trailing stopReason:'error' assistant messages to the session
// .jsonl and PARKED (the stophook's agent_end returns early on 'error' — "stay
// alive for re-steering"). A headless node has no human to re-steer it, so the
// broker stayed alive, status stayed 'active', and the daemon's pid-only
// liveness check read it healthy for 9 hours while its parent believed it was
// working. The daemon is the authority: a live, not-busy, intent-null engine
// whose session file has been quiet past ERROR_STALL_QUIET_MS and whose last
// assistant message stopped with 'error' is force-killed, so the ordinary
// dead-pid crash path grace-revives RESUME on the saved session — the exact
// manual recovery (kill broker + canvas revive) that fixed the zombie by hand.
//
// Three legs: the pure truth table (E1 — errorStallVerdict), the tail-signature
// parser (E2 — trailingEngineError), and the daemon integration over a real
// live pid the daemon must SIGTERM (E3 — superviseTick with an injected clock).
// Regression check: drop §I and E3's "engine killed" assert goes RED (the
// parked error engine lives forever, never recovered).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import {
  errorStallVerdict,
  trailingEngineError,
  ERROR_STALL_QUIET_MS,
  isPidAlive,
} from '../../daemon/crtrd.js';

// ---------------------------------------------------------------------------
// Session-jsonl line builders (the shape pi writes: {type:'message', message}).
// ---------------------------------------------------------------------------
function line(message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'message', id: 'x', timestamp: new Date().toISOString(), message });
}
const assistant = (stopReason: string, errorMessage?: string): string =>
  line({ role: 'assistant', stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) });
const toolResult = (): string => line({ role: 'toolResult' });
const user = (): string => line({ role: 'user' });

// ---------------------------------------------------------------------------
// E1 — the pure error-stall truth table.
// ---------------------------------------------------------------------------
test('E1 errorStallVerdict: kill ONLY a live, not-busy, intent-null engine, quiet past grace, with a trailing error', () => {
  const G = ERROR_STALL_QUIET_MS;

  // The one 'kill' case.
  assert.equal(errorStallVerdict(true, null, false, G, true), 'kill', 'alive+no-intent+!busy+quiet>=grace+error → kill');
  assert.equal(errorStallVerdict(true, null, false, G + 60_000, true), 'kill', 'well past grace → kill');

  // Recent session activity → leave (something is still making progress).
  assert.equal(errorStallVerdict(true, null, false, G - 1, true), 'leave', 'within quiet grace → leave');
  assert.equal(errorStallVerdict(true, null, false, null, true), 'leave', 'unknown quiet span → leave');

  // No trailing error → a healthy park (attended root, awaiting node) — leave.
  assert.equal(errorStallVerdict(true, null, false, G + 60_000, false), 'leave', 'last turn not an error → leave');

  // A working engine is NEVER killed (wedged-on-bash is recovered by killing the
  // subprocess, not the node).
  assert.equal(errorStallVerdict(true, null, true, G + 60_000, true), 'leave', 'busy (mid-turn) → leave');

  // A pending intent belongs to other paths (§H refresh; idle-release dormancy).
  assert.equal(errorStallVerdict(true, 'refresh', false, G + 60_000, true), 'leave', 'intent=refresh → leave (§H owns it)');
  assert.equal(errorStallVerdict(true, 'idle-release', false, G + 60_000, true), 'leave', 'intent=idle-release → leave');

  // A dead/unknown pid is the ordinary revive path's job.
  assert.equal(errorStallVerdict(false, null, false, G + 60_000, true), 'leave', 'dead pid → leave');
  assert.equal(errorStallVerdict(null, null, false, G + 60_000, true), 'leave', 'unknown pid → leave');
});

// ---------------------------------------------------------------------------
// E2 — the tail-signature parser.
// ---------------------------------------------------------------------------
test('E2 trailingEngineError: only a trailing error assistant turn matches', () => {
  // The observed zombie shape: trailing zero-token error assistant messages.
  assert.equal(
    trailingEngineError([assistant('toolUse'), toolResult(), assistant('error', 'Connection error.')].join('\n')),
    'Connection error.',
    'trailing error turn → its errorMessage',
  );
  // Trailing non-assistant lines (toolResults, an injected user message that
  // never got a response) are walked past to the last assistant turn.
  assert.equal(
    trailingEngineError([assistant('error', 'Connection error.'), user()].join('\n')),
    'Connection error.',
    'trailing injected user line is walked past',
  );
  // A healthy park / human abort is NOT a wedge.
  assert.equal(trailingEngineError([assistant('error', 'x'), toolResult(), assistant('stop')].join('\n')), null, 'recovered after an earlier error → null');
  assert.equal(trailingEngineError(assistant('aborted')), null, 'human Esc → null');
  // A tail cut mid-line (the 64KB boundary) is skipped, not fatal.
  assert.equal(
    trailingEngineError(['ut"}}garbage-fragment', assistant('error', 'boom')].join('\n')),
    'boom',
    'cut first fragment is skipped',
  );
  // An error turn with no errorMessage still reads as a wedge.
  assert.notEqual(trailingEngineError(assistant('error')), null, 'error with no errorMessage still matches');
  assert.equal(trailingEngineError(null), null, 'no tail → null');
  assert.equal(trailingEngineError(''), null, 'empty tail → null');
});

// ---------------------------------------------------------------------------
// E3 — daemon integration: a parked trailing-error engine is force-recycled.
// ---------------------------------------------------------------------------
const T0 = 9_000_000_000;

test(
  'E3 daemon force-kills a wedged engine: live, not-busy, intent-null, session quiet past grace with a trailing error turn',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-e3' });
    const dir = mkdtempSync(join(tmpdir(), 'crtr-e3-'));
    // Real live subprocesses standing in for the parked engines; `sleep` dies on
    // SIGTERM, so the daemon's force-kill is directly observable.
    const wedged = spawn('sleep', ['300'], { stdio: 'ignore' });
    const parked = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      // The WEDGED node: session ends in an error turn, quiet for > the grace.
      const wedgedFile = join(dir, 'wedged.jsonl');
      writeFileSync(wedgedFile, [assistant('toolUse'), toolResult(), assistant('error', 'Connection error.')].join('\n') + '\n');
      const staleSec = (T0 - ERROR_STALL_QUIET_MS - 1) / 1000;
      utimesSync(wedgedFile, staleSec, staleSec);
      const wedgedId = h.fabricateBrokerNode({
        kind: 'developer',
        status: 'active',
        pi_pid: wedged.pid!,
        pi_session_id: 'sess-e3-wedged',
        pi_session_file: wedgedFile,
      });

      // The CONTROL node: equally old and quiet, but its last turn is a healthy
      // 'stop' (an attended root overnight) — must NEVER be killed.
      const parkedFile = join(dir, 'parked.jsonl');
      writeFileSync(parkedFile, [assistant('toolUse'), toolResult(), assistant('stop')].join('\n') + '\n');
      utimesSync(parkedFile, staleSec, staleSec);
      h.fabricateBrokerNode({
        kind: 'developer',
        status: 'active',
        pi_pid: parked.pid!,
        pi_session_id: 'sess-e3-parked',
        pi_session_file: parkedFile,
      });

      assert.equal(isPidAlive(wedged.pid!), true, 'precondition: the wedged engine is alive');

      // --- TICK @ T0: the session has already been quiet past the grace (the
      //     file mtime is the clock — no arming tick), so the daemon SIGTERMs
      //     the wedged engine on sight. ---
      await h.tick(T0);
      await h.waitFor(() => (isPidAlive(wedged.pid!) ? null : true), {
        label: 'daemon SIGTERM killed the wedged trailing-error engine (§I)',
        timeoutMs: 10_000,
      });
      assert.equal(isPidAlive(wedged.pid!), false, 'the wedged engine was force-killed');
      assert.equal(isPidAlive(parked.pid!), true, 'the healthily-parked engine was NOT touched');
      assert.equal(h.node(wedgedId)!.intent ?? null, null, 'intent stays null — the dead-pid CRASH branch owns the revive (resume)');
    } finally {
      for (const c of [wedged, parked]) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
      await h.dispose();
    }
  },
);
