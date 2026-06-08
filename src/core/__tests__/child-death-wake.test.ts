// Run with: node --import tsx/esm --test src/core/__tests__/child-death-wake.test.ts
//
// D-1 BUG REGRESSION + node/canvas LIFECYCLE — "the runtime wakes a dormant
// parent on ANY terminal child outcome."
//
// The bug (D-1 finding, context/d1-finding.md): a parent that delegates and
// then JUST STOPS — retaining its inbox-wait, arming no self-wake — was woken
// ONLY when a child `push final`s or never boots. A child that crashes AFTER
// booting, is daemon-finalized after a quiet turn, or is `node close`d marked
// the child dead/done/canceled with NO push to the parent, so a purely-inbox-
// waiting parent hung dormant forever. The wake doctrine ("delegate and stop;
// the runtime wakes you") is only honest if EVERY terminal child outcome reaches
// the parent — this locks that in.
//
// The fix fans a system inbox entry to subscribersOf(child) on three previously-
// silent terminal outcomes — mirroring surfaceBootFailure:
//   • daemon CRASH after boot   (crtrd pane-gone, mid-generation → 'dead')
//   • daemon FINALIZE on quiet   (crtrd pane-gone, turn ended, nothing live → 'done')
//   • `node close`               (close.ts, the surviving manager outside the set)
//
// THE CRUX (the whole risk): the wake must fire ONLY on genuine death/close —
// NEVER on healthy dormancy. A child that ended its turn STILL waiting (an active
// live grandchild, or a pending self-wake) is alive-and-dormant, not dead; waking
// its parent then would re-create the spurious-wake storm the doctrine exists to
// kill (the concrete case: a developer child that finished its edits, spawned its
// own reviewer, and went dormant waiting on it — its parent must stay asleep).
// The daemon draws that boundary EXACTLY where the stop-guard does:
// hasActiveLiveSubscription || hasPendingSelfWake ⇒ healthy dormancy ⇒ release,
// no wake.
//
// Faithful: REAL canvas data layer, REAL tmux panes, the REAL daemon decision
// pass (superviseTick) and the REAL closeNode. The wake travels through the ONE
// channel the d1-finding identified — an entry appended to the parent's
// inbox.jsonl — so each direction asserts that channel: the system entry appears
// (parent woken: its dormant pi is then revived by the daemon's second pass,
// observed via a cycles bump) or it does NOT (parent stays asleep, cycles flat).

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

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

/** A pid that is guaranteed dead. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

const cyclesOf = (id: string): number => getNode(id)?.cycles ?? 0;

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

/** Run `fn` with a real, live tmux session + its window's live `%pane_id`. The
 *  PARENT occupies this (frozen) pane while pi-dead + idle-released — the
 *  faithful shape of an unfocused dormant orchestrator the daemon's second pass
 *  revives on an unseen inbox entry. */
async function withLivePane(
  tag: string,
  fn: (session: string, window: string, pane: string) => Promise<void>,
): Promise<void> {
  const session = `crtr-cdw-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', '/tmp', 'sleep 600']);
  try {
    const w = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_id}'], { encoding: 'utf8' });
    const window = (w.stdout ?? '').trim().split('\n')[0]!;
    const p = spawnSync('tmux', ['display-message', '-p', '-t', `${session}:${window}`, '#{pane_id}'], { encoding: 'utf8' });
    const pane = (p.stdout ?? '').trim();
    await fn(session, window, pane);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  }
}

/** A guaranteed-DEAD pane id inside `window`: split a fresh pane, then kill it.
 *  The window survives via its original pane. This is how a child's pane reads
 *  "gone" to the daemon while the session/window are still alive. */
function deadPaneIn(session: string, window: string): string {
  const sp = spawnSync('tmux', ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600'], { encoding: 'utf8' });
  const dead = (sp.stdout ?? '').trim();
  spawnSync('tmux', ['kill-pane', '-t', dead], { stdio: 'ignore' });
  return dead;
}

/** A dormant, unfocused PARENT: pi-dead, idle-released, frozen on the live pane,
 *  home_session set so the daemon's second pass can revive it. */
function dormantParent(id: string, session: string, window: string, pane: string): void {
  createNode(node(id, {
    pane,
    tmux_session: session,
    window,
    pi_pid: deadPid(),
    pi_session_id: 'booted',
    intent: 'idle-release',
    status: 'idle',
    home_session: session,
  }));
}

// ===========================================================================
// POSITIVE — a genuine terminal child outcome WAKES the dormant parent.
// ===========================================================================

test(
  'CRASH after boot (mid-generation, pane gone) wakes the dormant inbox-waiting parent',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    await withLivePane('crash', async (session, window, pane) => {
      dormantParent('PARENT', session, window, pane);
      const dead = deadPaneIn(session, window);
      createNode(node('CHILD', {
        pane: dead, tmux_session: session, window,
        pi_pid: deadPid(), pi_session_id: 'booted', intent: null, status: 'active',
      }));
      subscribe('PARENT', 'CHILD', true); // the spawn-time spine edge
      markBusy('CHILD'); // pane died INSIDE a turn → genuine mid-run crash

      const before = cyclesOf('PARENT');
      await superviseTick();

      assert.equal(getNode('CHILD')!.status, 'dead', 'CHILD crashed → dead');
      // THE WAKE CHANNEL: a system entry from CHILD lands in PARENT's inbox.
      const wake = readInboxSince('PARENT').find((e) => e.from === 'CHILD');
      assert.ok(wake, 'crash fanned a system inbox entry to the dormant parent (mirrors surfaceBootFailure)');
      assert.match(wake!.label, /died/i, 'the entry tells the parent WHICH child died and how');
      // END-TO-END: the dormant parent is REVIVED on the same tick (second pass).
      assert.equal(cyclesOf('PARENT'), before + 1, 'dormant PARENT revived on the same tick — no longer hangs');
      clearBusy('CHILD');
    });
  },
);

test(
  'quiet-turn FINALIZE (pane gone, nothing live to wait for) wakes the dormant parent',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    await withLivePane('finalize', async (session, window, pane) => {
      dormantParent('PARENT', session, window, pane);
      const dead = deadPaneIn(session, window);
      // Booted, turn finished (NO busy marker), no live subscription, no pending
      // self-wake → the daemon finalizes it (done): a dismissal of a finished node.
      createNode(node('CHILD', {
        pane: dead, tmux_session: session, window,
        pi_pid: deadPid(), pi_session_id: 'booted', intent: null, status: 'active',
      }));
      subscribe('PARENT', 'CHILD', true);

      const before = cyclesOf('PARENT');
      await superviseTick();

      assert.equal(getNode('CHILD')!.status, 'done', 'CHILD finalized → done');
      const wake = readInboxSince('PARENT').find((e) => e.from === 'CHILD');
      assert.ok(wake, 'finalize fanned a system inbox entry to the dormant parent');
      assert.match(wake!.label, /without a final report/i, 'the entry tells the parent the child ended with no final');
      assert.equal(cyclesOf('PARENT'), before + 1, 'dormant PARENT revived on the same tick');
    });
  },
);

test(
  'node close of a child wakes its SURVIVING manager (the parent outside the closing set)',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    await withLivePane('close', async (session, window, pane) => {
      dormantParent('PARENT', session, window, pane);
      const childPane = deadPaneIn(session, window); // any pane handle; closeNode tears it down
      createNode(node('CHILD', {
        pane: childPane, tmux_session: session, window,
        pi_session_id: 'booted', status: 'active',
      }));
      subscribe('PARENT', 'CHILD', true); // PARENT is a manager OUTSIDE the close set

      // Closing CHILD: closingSet({CHILD}) cannot pull in PARENT (PARENT is a
      // SUBSCRIBER of CHILD, never a descendant), so PARENT survives + must wake.
      const res = closeNode('CHILD');
      assert.deepEqual(res.closed, ['CHILD'], 'only CHILD is closed; PARENT spared');
      assert.equal(getNode('CHILD')!.status, 'canceled', 'CHILD canceled by close');

      const wake = readInboxSince('PARENT').find((e) => e.from === 'CHILD');
      assert.ok(wake, 'node close fanned a child-closed entry to the surviving manager (D-1: previously none)');
      assert.match(wake!.label, /closed/i, 'the entry names the closed child');

      // The dormant parent is then revived by the daemon's second pass.
      const before = cyclesOf('PARENT');
      await superviseTick();
      assert.equal(cyclesOf('PARENT'), before + 1, 'dormant PARENT revived on the close entry — no longer hangs');
    });
  },
);

// ===========================================================================
// NEGATIVE — HEALTHY DORMANCY must NOT wake the parent (the correctness crux).
// ===========================================================================

test(
  'CRUX: a child dormant while awaiting its OWN live grandchild does NOT wake the parent',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    await withLivePane('dorm-sub', async (session, window, pane) => {
      dormantParent('PARENT', session, window, pane);
      const dead = deadPaneIn(session, window);
      // CHILD finished its turn (no busy) and its pane is gone, BUT it actively
      // subscribes to a LIVE grandchild — exactly the developer-spawned-reviewer
      // case. This is HEALTHY dormancy, not death.
      createNode(node('CHILD', {
        pane: dead, tmux_session: session, window,
        pi_pid: deadPid(), pi_session_id: 'booted', intent: null, status: 'active',
      }));
      createNode(node('GRANDCHILD', { status: 'active', pi_session_id: 'booted' })); // live, no pane (inline)
      subscribe('PARENT', 'CHILD', true);
      subscribe('CHILD', 'GRANDCHILD', true); // CHILD awaits a LIVE grandchild

      const before = cyclesOf('PARENT');
      await superviseTick();

      // CHILD is RELEASED (revivable), NOT finalized — the daemon must not orphan
      // its in-flight grandchild and must not wake the parent.
      assert.equal(getNode('CHILD')!.status, 'idle', 'CHILD released (revivable), NOT finalized');
      assert.equal(getNode('CHILD')!.intent, 'idle-release', 'CHILD routed to idle-release');
      assert.equal(readInboxSince('PARENT').length, 0, 'PARENT inbox EMPTY — healthy dormancy raises no wake');
      assert.equal(cyclesOf('PARENT'), before, 'dormant PARENT stays asleep (no revive) — no spurious wake');
    });
  },
);

test(
  'CRUX: a child dormant on a pending self-wake (no live sub) does NOT wake the parent',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    await withLivePane('dorm-wake', async (session, window, pane) => {
      dormantParent('PARENT', session, window, pane);
      const dead = deadPaneIn(session, window);
      createNode(node('CHILD', {
        pane: dead, tmux_session: session, window,
        pi_pid: deadPid(), pi_session_id: 'booted', intent: null, status: 'active',
      }));
      subscribe('PARENT', 'CHILD', true);
      // CHILD has NO live subscription, but holds a pending self-wake (far-future
      // so the wakeups pass never fires it this tick). hasPendingSelfWake(CHILD)
      // ⇒ the daemon treats it as STILL WAITING (the stop-guard's boundary), so
      // it RELEASES instead of finalizing. NON-VACUOUS: drop the hasPendingSelfWake
      // guard and CHILD finalizes → PARENT is spuriously woken.
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      armWake({ wakeup_id: 'wk-cdw-child', node_id: 'CHILD', owner_id: 'CHILD', fire_at: future, kind: 'bare' });

      const before = cyclesOf('PARENT');
      await superviseTick();

      assert.equal(getNode('CHILD')!.status, 'idle', 'CHILD with a pending self-wake is RELEASED, not finalized');
      assert.equal(getNode('CHILD')!.intent, 'idle-release', 'CHILD routed to idle-release (its clock will wake it)');
      assert.equal(readInboxSince('PARENT').length, 0, 'PARENT inbox EMPTY — a pending clock is healthy dormancy');
      assert.equal(cyclesOf('PARENT'), before, 'dormant PARENT stays asleep — pending self-wake is not death');
    });
  },
);
