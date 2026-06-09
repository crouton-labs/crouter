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

// A node that HAD booted (pi_session_id set) then lost its window mid-generation
// is a genuine crash — NOT a spawn failure — and the daemon surfaces it to the
// parent as an urgent crash notice (surfaceChildDeath, not surfaceBootFailure).
// The parent is woken exactly once, with tier=urgent, and the label must NOT
// match the "Spawn failed" boot-failure message (different human-visible text).
test('a crash after boot is marked dead and wakes the parent as urgent crash (not boot-failure)', async () => {
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
  assert.equal(inbox.length, 1, 'parent receives exactly one crash notice');
  assert.equal(inbox[0]!.tier, 'urgent', 'mid-run crash is delivered as urgent');
  assert.equal(inbox[0]!.from, 'C2');
  // Must NOT be the boot-failure message — this is a post-boot crash notice.
  assert.doesNotMatch(inbox[0]!.label, /Spawn failed/);
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
