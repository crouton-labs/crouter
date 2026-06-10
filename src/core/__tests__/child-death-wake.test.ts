// Run with: node --import tsx/esm --test src/core/__tests__/child-death-wake.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.7 + §E). D-1 BUG REGRESSION — "the
// runtime wakes a dormant parent on EVERY terminal child outcome, and ONLY on a
// genuine one." Drives the REAL daemon decision pass (superviseTick) + the REAL
// closeNode against canvas rows fabricated DIRECTLY in an isolated home — NO real
// tmux session, NO remain-on-exit pane, NO broker boot.
//
// (1) BUG LOCKED — the D-1 finding (context/d1-finding.md): a parent that
//     delegated and then JUST STOPPED (inbox-wait retained, no self-wake armed)
//     was woken ONLY when a child `push final`d or never booted. A child that
//     CRASHED after booting, was daemon-FINALIZED on a quiet turn, or was `node
//     close`d marked the child dead/done/canceled with NO push to the parent — so
//     a purely-inbox-waiting parent hung dormant forever. The fix fans a system
//     inbox entry to subscribersOf(child) on those three previously-silent
//     terminal outcomes (surfaceChildDeath crash/finalize + close.ts), mirroring
//     surfaceBootFailure. THE CRUX: it must fire ONLY on genuine death — NEVER on
//     healthy dormancy (a child that ended its turn still awaiting a LIVE
//     grandchild, or holding a pending self-wake, is alive-and-dormant; waking its
//     parent then re-creates the spurious-wake storm the doctrine exists to kill).
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — the wake travels through ONE pure
//     data-layer channel the d1-finding identified: a system entry appended to
//     the parent's inbox.jsonl (push() → appendInbox, no tmux). The death-vs-
//     dormancy boundary is pure daemon logic — finishedTurn (isBusy) +
//     hasActiveLiveSubscription || hasPendingSelfWake, the SAME boundary the
//     stop-guard draws (crtrd.ts). The daemon reaches the pane-gone routing for
//     ANY node whose pane is not alive; a row carrying a bogus pane id reads
//     "gone" (paneExists echoes empty for an unknown/absent pane — and with no
//     tmux server at all, the probe simply fails to false) with NO live session
//     to stand up. So the exact "booted child, pane gone, branch on what it was
//     doing" state reproduces with no real pane, and the parent stays an inline
//     node (no placement → the supervise loop's inline-root carve-out skips it),
//     so nothing in the test opens or needs a window.
//
// (3) HOW THE FABRICATED DRIVE STILL FAILS IF THE BUG REGRESSES — each direction
//     asserts the inbox channel: a genuine terminal outcome (crash/finalize/close)
//     MUST land a system entry from the child in the parent's inbox; healthy
//     dormancy MUST leave it empty. Drop the crash-branch surfaceChildDeath call
//     and the CRASH assertion goes RED (no entry); drop the stillWaiting guard and
//     a healthy-dormant child finalizes → the CRUX asserts go RED (a spurious
//     entry appears). Verified by reverting the crash-branch surfaceChildDeath
//     call (see bug-injection report).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { armWake } from '../canvas/wakeups.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { markBusy, clearBusy } from '../runtime/busy.js';
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

/** A pid that is guaranteed dead. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

// A pane id no tmux server knows: paneExists echoes empty for it → isNodePaneAlive
// is false → the supervise loop routes the row down its pane-gone branch with NO
// live session required (and with no server at all the probe fails to false too).
const GONE_PANE = '%999999';

/** A booted child whose pane is GONE — the daemon's pane-gone routing input.
 *  `intent:null` so it takes the user-close branch (neither refresh nor
 *  idle-release); pi dead so the zombie-kill is skipped; pi_session_id set so it
 *  is "booted" (not the never-booted boot-failure leg). The caller layers on the
 *  busy marker / subscriptions that decide crash vs finalize vs release. */
function paneGoneChild(id: string, over: Partial<NodeMeta> = {}): void {
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

/** A dormant inbox-waiting PARENT — an INLINE node (no tmux placement), so the
 *  supervise loop's inline-root carve-out skips it entirely: it is only the wake
 *  TARGET, asserted via its inbox. */
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
// POSITIVE — a genuine terminal child outcome WAKES the inbox-waiting parent.
// ===========================================================================

test('CRASH after boot (mid-generation, pane gone) wakes the inbox-waiting parent', async () => {
  inboxWaitingParent('PARENT');
  paneGoneChild('CHILD');
  subscribe('PARENT', 'CHILD', true); // the spawn-time spine edge
  markBusy('CHILD'); // pane died INSIDE a turn → genuine mid-run crash

  await superviseTick();

  assert.equal(getNode('CHILD')!.status, 'dead', 'CHILD crashed → dead');
  // THE WAKE CHANNEL: a system entry from CHILD lands in PARENT's inbox.
  const wake = wakeFromChild('PARENT', 'CHILD');
  assert.ok(wake, 'crash fanned a system inbox entry to the dormant parent (mirrors surfaceBootFailure)');
  assert.match(wake!.label, /died/i, 'the entry tells the parent WHICH child died and how');
  clearBusy('CHILD');
});

test('quiet-turn FINALIZE (pane gone, nothing live to wait for) wakes the inbox-waiting parent', async () => {
  inboxWaitingParent('PARENT');
  // Booted, turn finished (NO busy marker), no live subscription, no pending
  // self-wake → the daemon finalizes it (done): a dismissal of a finished node.
  paneGoneChild('CHILD');
  subscribe('PARENT', 'CHILD', true);

  await superviseTick();

  assert.equal(getNode('CHILD')!.status, 'done', 'CHILD finalized → done');
  const wake = wakeFromChild('PARENT', 'CHILD');
  assert.ok(wake, 'finalize fanned a system inbox entry to the dormant parent');
  assert.match(wake!.label, /without a final report/i, 'the entry tells the parent the child ended with no final');
});

test('node close of a child wakes its SURVIVING manager (the parent outside the closing set)', async () => {
  inboxWaitingParent('PARENT');
  // A booted child; closeNode tears its (paneless-for-the-test) engine down.
  createNode(node('CHILD', { pane: GONE_PANE, tmux_session: 'crtr-cdw', window: '@1', pi_session_id: 'booted', status: 'active' }));
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

// ===========================================================================
// NEGATIVE — HEALTHY DORMANCY must NOT wake the parent (the correctness crux).
// ===========================================================================

test('CRUX: a child dormant while awaiting its OWN live grandchild does NOT wake the parent', async () => {
  inboxWaitingParent('PARENT');
  // CHILD finished its turn (no busy) and its pane is gone, BUT it actively
  // subscribes to a LIVE grandchild — exactly the developer-spawned-reviewer
  // case. This is HEALTHY dormancy, not death.
  paneGoneChild('CHILD');
  createNode(node('GRANDCHILD', { status: 'active', pi_session_id: 'booted' })); // live, inline
  subscribe('PARENT', 'CHILD', true);
  subscribe('CHILD', 'GRANDCHILD', true); // CHILD awaits a LIVE grandchild

  await superviseTick();

  // CHILD is RELEASED (revivable), NOT finalized — the daemon must not orphan
  // its in-flight grandchild and must not wake the parent.
  assert.equal(getNode('CHILD')!.status, 'idle', 'CHILD released (revivable), NOT finalized');
  assert.equal(getNode('CHILD')!.intent, 'idle-release', 'CHILD routed to idle-release');
  assert.equal(readInboxSince('PARENT').length, 0, 'PARENT inbox EMPTY — healthy dormancy raises no wake');
});

test('CRUX: a child dormant on a pending self-wake (no live sub) does NOT wake the parent', async () => {
  inboxWaitingParent('PARENT');
  paneGoneChild('CHILD');
  subscribe('PARENT', 'CHILD', true);
  // CHILD has NO live subscription, but holds a pending self-wake (far-future so
  // the wakeups pass never fires it this tick). hasPendingSelfWake(CHILD) ⇒ the
  // daemon treats it as STILL WAITING (the stop-guard's boundary), so it RELEASES
  // instead of finalizing. NON-VACUOUS: drop the hasPendingSelfWake guard and
  // CHILD finalizes → PARENT is spuriously woken.
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  armWake({ wakeup_id: 'wk-cdw-child', node_id: 'CHILD', owner_id: 'CHILD', fire_at: future, kind: 'bare' });

  await superviseTick();

  assert.equal(getNode('CHILD')!.status, 'idle', 'CHILD with a pending self-wake is RELEASED, not finalized');
  assert.equal(getNode('CHILD')!.intent, 'idle-release', 'CHILD routed to idle-release (its clock will wake it)');
  assert.equal(readInboxSince('PARENT').length, 0, 'PARENT inbox EMPTY — a pending clock is healthy dormancy');
});
