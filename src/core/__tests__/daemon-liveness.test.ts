// Run with: node --import tsx/esm --test src/core/__tests__/daemon-liveness.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.8 + §E). The FAST half of the daemon
// liveness suite — the PURE decision primitives, no tmux at all. The pane-alive
// reconciliation half (withLiveWindow/withLivePane → paneLocation/listLivePanes
// tmux probes — a genuine tmux dependency) lives in full/daemon-liveness-pane.full.test.ts.
//
// (1) BUG LOCKED — the REVIVE_GRACE_MS double-spawn guard, distilled to its pure
//     core: livenessVerdict(piPidAlive, deadFor). A pi observed DEAD must PEND
//     through the grace window before a revive (revive too early lands in the
//     old-pi-dies→fresh-pi-boots gap and double-spawns a second vehicle on one
//     .jsonl); a live/unknown pi is left alone. Plus isPidAlive, the signal-0
//     probe the whole supervision pass keys on.
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — livenessVerdict is a total pure function
//     of (alive?, deadFor): zero process, zero tmux, instant. isPidAlive is a
//     kill(pid, 0) syscall on a self/reaped pid — no pane, no session. Neither
//     decision consults a window, so neither needs one to be exercised
//     faithfully. (The pane-existence reconciliation — paneAlive vs window-cache,
//     gone-branch routing, frozen-pane revive — DOES need a real pane to be
//     faithful, so it stays in the full tier.)
//
// (3) HOW THE DRIVE STILL FAILS IF THE BUG REGRESSES — drop the
//     `deadFor < REVIVE_GRACE_MS` pending branch and livenessVerdict(false, 1_000)
//     returns 'revive' instead of 'pending' → the grace-window asserts go RED.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { closeDb } from '../canvas/db.js';
import { isPidAlive, livenessVerdict } from '../../daemon/crtrd.js';

let home: string;

/** A pid that is guaranteed dead: spawn a no-op and let spawnSync reap it. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe; // fall back to an implausibly-high pid
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-daemon-liveness-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

// ---------------------------------------------------------------------------
// livenessVerdict — the pure grace-window decision
// ---------------------------------------------------------------------------

test('livenessVerdict: a live (or unknown) pi is left alone', () => {
  assert.equal(livenessVerdict(true, 0), 'leave', 'alive pid → leave');
  assert.equal(livenessVerdict(true, 10_000_000), 'leave');
  assert.equal(livenessVerdict(null, 10_000_000), 'leave', 'no recorded pid → leave (legacy / in-flight)');
});

test('livenessVerdict: a dead pi pends through the grace window, then revives', () => {
  assert.equal(livenessVerdict(false, null), 'pending', 'first observation → pending');
  assert.equal(livenessVerdict(false, 0), 'pending', 'just-observed-dead → pending');
  assert.equal(livenessVerdict(false, 1_000), 'pending', 'still inside grace → pending');
  assert.equal(livenessVerdict(false, 10_000_000), 'revive', 'dead past grace → revive');
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

test('isPidAlive: this process is alive; a reaped pid is dead', () => {
  assert.equal(isPidAlive(process.pid), true, 'self is alive');
  assert.equal(isPidAlive(deadPid()), false, 'a reaped/implausible pid is dead');
});
