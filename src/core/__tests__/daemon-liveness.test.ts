import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
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
