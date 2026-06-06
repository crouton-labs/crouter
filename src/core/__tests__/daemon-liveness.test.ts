import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { appendInbox } from '../feed/inbox.js';
import { markBusy, clearBusy } from '../runtime/busy.js';
import {
  superviseTick,
  isPidAlive,
  livenessVerdict,
} from '../../daemon/crtrd.js';
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

/** A pid that is guaranteed dead: spawn a no-op and wait for it to exit. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  // spawnSync has reaped it by the time it returns; pid may be on r.pid.
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

// ---------------------------------------------------------------------------
// superviseTick + a REAL live tmux window (gated on tmux availability)
// ---------------------------------------------------------------------------

/** Run `fn` with a real, live tmux window held open for its whole duration, then
 *  tear the session down. Gives superviseTick a genuinely-alive window to judge. */
async function withLiveWindow(
  tag: string,
  fn: (session: string, window: string) => Promise<void>,
): Promise<void> {
  const session = `crtr-livetest-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', '/tmp', 'sleep 600']);
  try {
    const r = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_id}'], { encoding: 'utf8' });
    const window = (r.stdout ?? '').trim().split('\n')[0]!;
    await fn(session, window);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  }
}

/** Like withLiveWindow but also resolves the window's live `%pane_id` — the v3
 *  pane-anchored handle the daemon now keys liveness on. */
async function withLivePane(
  tag: string,
  fn: (session: string, window: string, pane: string) => Promise<void>,
): Promise<void> {
  await withLiveWindow(tag, async (session, window) => {
    const r = spawnSync('tmux', ['display-message', '-p', '-t', `${session}:${window}`, '#{pane_id}'], { encoding: 'utf8' });
    const pane = (r.stdout ?? '').trim();
    await fn(session, window, pane);
  });
}

test('window alive + ALIVE pi pid → healthy, untouched', { skip: !hasTmux() }, async () => {
  await withLiveWindow('a', async (session, window) => {
    // pi_pid = this test process: definitely alive.
    createNode(node('A', { tmux_session: session, window, pi_pid: process.pid, pi_session_id: 'booted' }));
    await superviseTick();
    assert.equal(getNode('A')!.status, 'active', 'a node with a live pi is left active');
  });
});

test('window alive + dead pi pid → pending on first observation (not reaped, not revived)', { skip: !hasTmux() }, async () => {
  await withLiveWindow('b', async (session, window) => {
    createNode(node('D', {
      tmux_session: session,
      window,
      pi_pid: deadPid(),
      pi_session_id: 'booted-once',
      intent: null,
      status: 'active',
    }));
    await superviseTick();
    // First observation: inside the grace window → pending. The node must NOT be
    // reaped to 'dead' (its window is alive) nor revived yet (no new pi spawned).
    assert.equal(getNode('D')!.status, 'active', 'pending node stays active on first tick');
  });
});

// ---------------------------------------------------------------------------
// Step 3 (Q6): PANE-existence drives the daemon verdict, not window-existence.
// A manual move-pane/join-pane/break-pane must never read as a death; and a
// pane that is genuinely gone fires the existing gone-branch even when the
// window it used to live in is still alive.
// ---------------------------------------------------------------------------

test('pane alive but window/session cache STALE → LIVE (reconciled, not revived/reaped)', { skip: !hasTmux() }, async () => {
  await withLivePane('p1', async (session, window, pane) => {
    // The pane is live, the pi is alive (this process) — but the row's window
    // cache is bogus (as if a manual move desynced it). Pane-existence must win:
    // the node stays active and reconcile FOLLOWS the pane back to its real window.
    createNode(node('M', {
      pane,
      tmux_session: session,
      window: '@99999', // stale/bogus — windowAlive() would call this gone
      pi_pid: process.pid,
      pi_session_id: 'booted',
    }));
    await superviseTick();
    const m = getNode('M')!;
    assert.equal(m.status, 'active', 'a live pane keeps the node active despite a stale window cache');
    assert.equal(m.window, window, 'reconcile FOLLOWED the live pane back to its real window');
    assert.equal(m.pane, pane, 'the durable pane id is unchanged');
  });
});

test('pane GONE while its old window is still alive → the gone-branch fires (crash → dead)', { skip: !hasTmux() }, async () => {
  await withLivePane('p2', async (session, window) => {
    // Make a guaranteed-DEAD pane id inside the still-live window: split a fresh
    // pane, then kill it (the window survives via its original pane).
    const sp = spawnSync('tmux', ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600'], { encoding: 'utf8' });
    const dead = (sp.stdout ?? '').trim();
    spawnSync('tmux', ['kill-pane', '-t', dead], { stdio: 'ignore' });

    // The window is alive, but the node is anchored on that dead pane. Under the
    // old window-keyed liveness this node would read healthy (window alive + live
    // pid). Pane-keyed: the pane is gone → the gone-branch fires. The node is
    // MID-GENERATION (busy marker present — agent_start touched it, agent_end
    // never cleared it), so the gone-branch routes to crash → 'dead'.
    createNode(node('G', {
      pane: dead,
      tmux_session: session,
      window,
      pi_pid: process.pid, // alive — irrelevant once the pane reads gone
      pi_session_id: 'booted',
      intent: null,
    }));
    markBusy('G'); // pane killed inside a turn → genuine mid-run crash
    await superviseTick();
    assert.equal(getNode('G')!.status, 'dead', 'a gone pane mid-generation fires the gone-branch → crash (dead)');
    clearBusy('G');
  });
});

// ---------------------------------------------------------------------------
// Gone-pane routing: a pane-gone node in the crash branch is no longer an
// unconditional 'dead'. It routes on what the node was DOING at pane-kill time:
//   • mid-generation (busy marker PRESENT)               → crash  ('dead')
//   • finished its turn, awaiting nothing live           → finalize ('done')
//   • finished its turn, still awaiting a LIVE child     → crash  ('dead'), for now
// (The mid-generation → dead leg is covered by node 'G' above.)
// ---------------------------------------------------------------------------

test('pane gone + booted + busy ABSENT + no live subscription → finalize (done): the pane was closed to dismiss a finished node', { skip: !hasTmux() }, async () => {
  await withLivePane('fin1', async (session, window) => {
    const sp = spawnSync('tmux', ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600'], { encoding: 'utf8' });
    const dead = (sp.stdout ?? '').trim();
    spawnSync('tmux', ['kill-pane', '-t', dead], { stdio: 'ignore' });

    // Booted (pi_session_id set), no busy marker (agent_end cleared it → the turn
    // finished), and no subscription to any live node. Closing the pane was a
    // dismissal of a node that already did its own work → finalize to 'done'.
    createNode(node('FIN', {
      pane: dead,
      tmux_session: session,
      window,
      pi_pid: process.pid,
      pi_session_id: 'booted',
      intent: null,
    }));
    // no markBusy: the turn ended cleanly.
    await superviseTick();
    assert.equal(getNode('FIN')!.status, 'done', 'a finished, unsubscribed node whose pane was closed finalizes to done');
  });
});

test('pane gone + booted + busy ABSENT but AWAITING a LIVE child → crash (dead), for now', { skip: !hasTmux() }, async () => {
  await withLivePane('fin2', async (session, window) => {
    const sp = spawnSync('tmux', ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:${window}`, 'sleep 600'], { encoding: 'utf8' });
    const dead = (sp.stdout ?? '').trim();
    spawnSync('tmux', ['kill-pane', '-t', dead], { stdio: 'ignore' });

    // A live child the parent is subscribed to: hasActiveLiveSubscription === true.
    createNode(node('CHILD', { status: 'active', pi_session_id: 'booted' }));
    createNode(node('PARENT', {
      pane: dead,
      tmux_session: session,
      window,
      pi_pid: process.pid,
      pi_session_id: 'booted',
      intent: null,
    }));
    subscribe('PARENT', 'CHILD', true); // active subscription to a LIVE node
    // Parent finished its turn (no busy marker) but is still awaiting a live
    // child → NOT a finalize. Routes to crash ('dead') for now.
    await superviseTick();
    assert.equal(getNode('PARENT')!.status, 'dead', 'a finished node still awaiting a live child crashes (dead), not finalizes');
  });
});

// ---------------------------------------------------------------------------
// Step 7 (§5.3, F3): a focused-dormant node frozen via remain-on-exit is
// PANE-alive but pi-DEAD with intent='idle-release'. The daemon must NOT
// grace-revive it on liveness (handleLiveWindow early-returns for idle-release);
// it revives ONLY when an unseen inbox entry arrives (second pass, gated on pi
// liveness — NOT pane existence, which would skip a frozen pane forever).
// ---------------------------------------------------------------------------

test('idle-release + live (frozen) pane + DEAD pi → handleLiveWindow does NOT grace-revive it', { skip: !hasTmux() }, async () => {
  await withLivePane('idle1', async (session, window, pane) => {
    createNode(node('F', {
      pane,
      tmux_session: session,
      window,
      pi_pid: deadPid(),     // pi is DEAD; the pane is frozen (remain-on-exit stand-in)
      pi_session_id: 'booted',
      intent: 'idle-release',
      status: 'idle',
      home_session: session,
    }));
    // Two ticks: the SECOND is far past REVIVE_GRACE_MS (20s). Without the
    // idle-release early-return in handleLiveWindow, tick 1 would mark the dead
    // pi 'pending' and tick 2 (now past grace) would grace-revive it, bumping
    // cycles. The early-return means it is never even marked pending. No inbox
    // entry, so the second pass never revives it either.
    await superviseTick(1_000_000);
    await superviseTick(1_000_000 + 60_000);
    const m = getNode('F')!;
    assert.equal(m.status, 'idle', 'still idle — the frozen focused-dormant node is left alone');
    assert.equal(m.cycles ?? 0, 0, 'cycles NOT bumped → reviveNode never fired');
    assert.equal(m.pane, pane, 'pane unchanged');
    assert.equal(m.window, window, 'window unchanged');
    // Non-vacuous: drop the `intent==='idle-release'` early-return and tick 2
    // (deadFor 60s > 20s grace) revives → cycles===1, status flips → both fail.
  });
});

test('idle-release + live (frozen) pane + DEAD pi + UNSEEN inbox → REVIVED on the second pass', { skip: !hasTmux() }, async () => {
  await withLivePane('idle2', async (session, window, pane) => {
    createNode(node('W', {
      pane,
      tmux_session: session,
      window,
      pi_pid: deadPid(),
      pi_session_id: 'booted',
      intent: 'idle-release',
      status: 'idle',
      home_session: session, // the revive window lands here (torn down with the session)
    }));
    appendInbox('W', { from: 'child', tier: 'normal', kind: 'update', label: 'work for you' });

    await superviseTick();

    // The OLD second-pass guard `if (isNodePaneAlive(r)) continue;` would SKIP a
    // pane-alive node forever; the new `if (r.pi_pid != null && isPidAlive(...))`
    // gate sees the DEAD pi and revives. reviveNode bumps cycles BEFORE placing
    // the window, so the bump is the observable even though the launch is a real
    // (short-lived, torn-down) window. Non-vacuous: the old pane-existence gate
    // leaves cycles unbumped.
    assert.equal(getNode('W')!.cycles, 1, 'reviveNode fired on the inbox push despite a live (frozen) pane');
  });
});
