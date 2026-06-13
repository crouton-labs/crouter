// Run with: node --import tsx/esm --test src/core/__tests__/child-death-wake.test.ts
//
// DOCTRINE WAKE — "a parent that delegated and went dormant is still woken when
// its child reaches a genuine terminal outcome, and is NEVER spuriously woken on
// healthy dormancy." Drives the REAL daemon decision pass (superviseTick) + the
// REAL closeNode against canvas rows fabricated DIRECTLY in an isolated home — NO
// real tmux session, NO broker boot.
//
// BROKER CUT (this worktree): the daemon's OLD parent-wake mechanism is GONE.
// U7 deleted surfaceChildDeath and the entire pane-gone reaping block (the
// crash/finalize/release routing that used to mark a pane-gone child dead/done/
// idle and fan a system inbox entry to its subscribers). Liveness is now PID-ONLY
// — a viewer pane/window closing is NOT a node death — so a booted child whose
// engine pid is dead is REVIVED on its saved session, not surfaced as dead. The
// doctrine wake therefore RELOCATED off the daemon:
//   • child finishes → `crtr push final` wakes subscribers via the PUSH itself;
//   • child crashes → daemon grace-REVIVES it (it comes back and pushes later);
//   • child never boots → surfaceBootFailure still pushes urgent (daemon-boot.test);
//   • child `node close`d → close.ts fans the child-closed wake (tested below).
// So the daemon now fans NO liveness wake at all, which makes the old CRUX
// (healthy dormancy must not wake the parent) hold by construction. This file
// locks in (a) the new pid-only non-reaping + no-daemon-wake contract, and (b)
// the one genuine-terminal wake that still lives in core: close.ts.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { closeNode } from '../runtime/close.js';
import { superviseTick } from '../../daemon/crtrd.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

/** Write a minimal pi session with one assistant message so the node reads as
 *  NON-empty (produced AI output) — otherwise closeNode reaps it outright. */
function withSession(id: string): string {
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  return f;
}

/** A pid that is guaranteed dead. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

// A pane id no tmux server knows. In the broker cut the daemon IGNORES pane state
// entirely (liveness is pid-only) — this just stands in for "the node once had a
// viewer pane that is now gone," which must NOT count as a death.
const GONE_PANE = '%999999';

/** A booted child whose engine pid is DEAD and whose viewer pane is gone — the
 *  shape a crashed/finished child leaves behind. `pi_session_id` set so it is
 *  "booted"; `intent:null` so it takes the crash (grace-revive RESUME) branch. */
function deadEngineChild(id: string, over: Partial<NodeMeta> = {}): void {
  createNode(node(id, {
    pane: GONE_PANE,
    tmux_session: 'crtr-cdw',
    window: '@1',
    pi_pid: deadPid(),
    pi_session_id: 'booted',
    intent: null,
    status: 'active',
    ...over,
  }));
}

/** A dormant inbox-waiting PARENT — only ever the wake TARGET, asserted via its
 *  inbox. */
function inboxWaitingParent(id: string): void {
  createNode(node(id, { status: 'active' }));
}

const wakeFromChild = (parent: string, child: string) =>
  readInboxSince(parent).find((e) => e.from === child);

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-child-death-wake-'));
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

// ===========================================================================
// BROKER CUT — pid-only liveness REPLACES daemon pane-gone reaping. A booted
// child whose engine pid is dead (and whose viewer pane is gone) is REVIVABLE,
// not reaped, and the daemon fans NO wake to the dormant parent. This single
// case subsumes the four deleted scenarios (crash / quiet-finalize / awaiting a
// live grandchild / pending self-wake): with pane state ignored and
// surfaceChildDeath gone, the daemon treats them all identically — grace-revive,
// no liveness wake — so the old CRUX (no spurious wake on healthy dormancy)
// holds by construction.
// ===========================================================================

test('pid-only liveness: a dead-engine booted child is revivable, NOT reaped, and the daemon fans NO wake to its dormant parent', async () => {
  inboxWaitingParent('PARENT');
  deadEngineChild('CHILD');
  subscribe('PARENT', 'CHILD', true); // the spawn-time spine edge

  await superviseTick();

  // A dead engine pid is REVIVABLE (grace-revive RESUME on the saved session),
  // not reaped to dead/done/idle — a viewer pane closing is not a node death.
  assert.equal(getNode('CHILD')!.status, 'active', 'CHILD stays revivable, NOT reaped');
  // surfaceChildDeath is deleted: the daemon raises no liveness wake. The
  // doctrine wake now rides the child's own `push final` (or close.ts), so a
  // purely-inbox-waiting parent is never spuriously woken on dormancy/crash.
  assert.equal(readInboxSince('PARENT').length, 0, 'PARENT inbox EMPTY — no daemon liveness wake');
});

test('node close of a child wakes its SURVIVING manager (the parent outside the closing set)', async () => {
  inboxWaitingParent('PARENT');
  // A booted child; closeNode tears its (paneless-for-the-test) engine down.
  createNode(node('CHILD', { pane: GONE_PANE, tmux_session: 'crtr-cdw', window: '@1', pi_session_id: 'booted', pi_session_file: withSession('CHILD'), status: 'active' }));
  subscribe('PARENT', 'CHILD', true); // PARENT is a manager OUTSIDE the close set

  // Closing CHILD: closingSet({CHILD}) cannot pull in PARENT (PARENT is a
  // SUBSCRIBER of CHILD, never a descendant), so PARENT survives + must wake.
  const res = closeNode('CHILD');
  assert.deepEqual(res.closed, ['CHILD'], 'only CHILD is closed; PARENT spared');
  assert.equal(getNode('CHILD')!.status, 'canceled', 'CHILD canceled by close');

  const wake = wakeFromChild('PARENT', 'CHILD');
  assert.ok(wake, 'node close fanned a child-closed entry to the surviving manager (D-1: previously none)');
  assert.match(wake!.label, /closed/i, 'the entry names the closed child');
});

// NOTE (broker cut): the two NEGATIVE "CRUX" tests that used to live here — a
// child dormant while awaiting a live grandchild, and a child dormant on a
// pending self-wake — asserted the daemon's pane-gone routing chose idle-release
// (status 'idle', intent 'idle-release') over finalize, so it would not spuriously
// wake the parent. U7 DELETED that routing entirely: pane state is ignored, the
// daemon never finalizes/releases on liveness, and surfaceChildDeath is gone, so
// the daemon raises no liveness wake at all. The no-spurious-wake invariant they
// protected now holds by construction and is covered by the pid-only test above
// (PARENT inbox stays empty). Removed rather than adapted because the
// idle-release-vs-finalize distinction they asserted no longer exists.
