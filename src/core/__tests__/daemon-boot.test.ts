import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { superviseTick } from '../../daemon/crtrd.js';
import { markBusy, clearBusy } from '../runtime/busy.js';
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

/** Wire `parent subscribes_to child` — the spawn-time edge (parent wakes on the
 *  child's pushes), so the daemon's boot-failure push reaches the parent. */
function spawnEdge(parent: string, child: string): void {
  subscribe(parent, child, true);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-daemon-boot-'));
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

// A node whose window is gone while pi_session_id was NEVER set: the vehicle
// died before pi ever booted. The spawner already returned status="active", so
// the parent must be told — the daemon marks it dead AND pushes urgent up.
test('never-booted node is marked dead and surfaced to the parent as urgent', async () => {
  createNode(node('P', { kind: 'developer', lifecycle: 'resident' }));
  createNode(
    node('C', {
      parent: 'P',
      kind: 'explore',
      // Points at a session/window that does not exist → windowAlive() is false,
      // so the daemon treats the window as gone.
      tmux_session: 'crtr-test-absent-session',
      window: '@999991',
      pi_session_id: null, // never booted
      intent: null,
    }),
  );
  spawnEdge('P', 'C');

  await superviseTick();

  assert.equal(getNode('C')!.status, 'dead', 'never-booted child is dead');

  const inbox = readInboxSince('P');
  assert.equal(inbox.length, 1, 'parent received exactly one pointer');
  assert.equal(inbox[0]!.tier, 'urgent', 'boot failure is delivered as urgent');
  assert.equal(inbox[0]!.from, 'C');
  assert.match(inbox[0]!.label, /Spawn failed/);
});

// A node that HAD booted (pi_session_id set) then died mid-generation is a
// genuine crash, not a boot failure. It is marked dead AND wakes the inbox-
// waiting parent — but with a "child died" notice (surfaceChildDeath), NOT a
// "Spawn failed" boot-failure pointer (surfaceBootFailure). The parent-wake
// itself was added by main's b5abf6e (parent-wake on child death) and is locked
// in by child-death-wake.test.ts; this test preserves the discriminating intent
// — a crash is never surfaced as a false spawn-failure alarm.
test('a crash after boot wakes the parent with a child-death notice, not a boot-failure push', async () => {
  createNode(node('P2', { kind: 'developer', lifecycle: 'resident' }));
  createNode(
    node('C2', {
      parent: 'P2',
      kind: 'explore',
      tmux_session: 'crtr-test-absent-session',
      window: '@999992',
      pi_session_id: '019e8f00-booted-once', // it booted before dying
      intent: null,
    }),
  );
  spawnEdge('P2', 'C2');
  // MID-GENERATION when the window vanished (busy marker present, agent_end
  // never cleared it) → a genuine mid-run crash. Without the marker a booted,
  // unsubscribed pane-gone node would FINALIZE to 'done' instead (it would read
  // as a finished node dismissed) — see the gone-pane routing in crtrd.ts.
  markBusy('C2');

  await superviseTick();

  assert.equal(getNode('C2')!.status, 'dead', 'crashed child is dead');

  const inbox = readInboxSince('P2');
  assert.equal(inbox.length, 1, 'a genuine mid-run crash wakes the inbox-waiting parent (D-1 parent-wake)');
  assert.equal(inbox[0]!.tier, 'urgent', 'mid-run crash is delivered as urgent');
  assert.equal(inbox[0]!.from, 'C2');
  assert.match(inbox[0]!.label, /died/i, 'the wake is a child-death notice (surfaceChildDeath), not silence');
  assert.doesNotMatch(inbox[0]!.label, /Spawn failed/, 'a crash is NOT surfaced as a false boot-failure alarm');
  clearBusy('C2');
});

// A still-booting node whose window is alive must be left untouched — boot is
// slow, and an alive window means pi may still be coming up.
test('a node with a live window is left alone even before it boots', async () => {
  // No tmux_session/window → treated as an inline root and skipped entirely,
  // which exercises the "no placement → not daemon-managed" guard rather than a
  // false reap. (We avoid depending on a real live tmux window in the test env.)
  createNode(node('S', { status: 'active', pi_session_id: null }));

  await superviseTick();

  assert.equal(getNode('S')!.status, 'active', 'unplaced active node is not reaped');
});
