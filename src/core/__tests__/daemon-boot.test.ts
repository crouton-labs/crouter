import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

/** A pid that is guaranteed dead (models a crashed engine). */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
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

  // BROKER CUT: liveness is pid-only — the bogus window/session is irrelevant. A
  // never-booted broker (pi_pid null AND pi_session_id null) is caught by the
  // in-memory boot-grace clock, so the boot-failure fires on the SECOND tick,
  // once REVIVE_GRACE_MS (~20s) of "still no pid, no session" has elapsed.
  const t0 = Date.now();
  await superviseTick(t0); // first observation: starts the boot-grace clock
  await superviseTick(t0 + 60_000); // grace elapsed → crash + surfaceBootFailure

  assert.equal(getNode('C')!.status, 'dead', 'never-booted child is dead');

  const inbox = readInboxSince('P');
  assert.equal(inbox.length, 1, 'parent received exactly one pointer');
  assert.equal(inbox[0]!.tier, 'urgent', 'boot failure is delivered as urgent');
  assert.equal(inbox[0]!.from, 'C');
  assert.match(inbox[0]!.label, /Spawn failed/);
});

// BROKER CUT: surfaceChildDeath was DELETED and liveness is pid-only. A crashed
// booted child (engine pid DEAD, pi_session_id set) is no longer marked `dead`
// and no longer fans a "child died" notice — the daemon now grace-REVIVES it on
// its saved session, so the row stays active/revivable and the doctrine wake
// relocated (the revived child pushes when it truly finishes; a deliberate close
// is woken by close.ts). This test preserves the discriminating intent in the
// new model: a crash is never reaped to `dead` and never raises a false
// boot-failure alarm.
test('a crashed booted child is revivable, not reaped, and raises no false boot-failure alarm', async () => {
  createNode(node('P2', { kind: 'developer', lifecycle: 'resident' }));
  createNode(
    node('C2', {
      parent: 'P2',
      kind: 'explore',
      pi_pid: deadPid(), // engine crashed — its recorded pid is dead
      pi_session_id: '019e8f00-booted-once', // it booted before dying
      intent: null,
    }),
  );
  spawnEdge('P2', 'C2');
  markBusy('C2'); // died mid-generation

  await superviseTick();

  // pid-only liveness: a dead engine pid is REVIVABLE (grace-revive RESUME on the
  // saved session), not reaped to `dead`; the row stays active across the grace.
  assert.equal(getNode('C2')!.status, 'active', 'crashed booted child stays revivable, NOT marked dead');
  // surfaceChildDeath is gone and this is not a never-booted node, so the daemon
  // fans NO push here — no false boot-failure / child-death alarm on a crash.
  assert.equal(readInboxSince('P2').length, 0, 'no false boot-failure / child-death push on a crash (wake relocated to push/close)');
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
