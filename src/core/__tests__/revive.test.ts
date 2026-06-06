// Run with: node --import tsx/esm --test src/core/__tests__/revive.test.ts
//
// Covers the session-picker fix: a revive must resume by ABSOLUTE session-file
// path (cwd-immune) when one was captured, falling back to the bare uuid for
// older nodes — and the double-revive guard that keeps two pi processes off one
// session file. The argv selection is unit-tested via the pure `resumeArgs` +
// `buildPiArgv`; the guard is exercised against a REAL tmux window (gated on
// tmux availability, like daemon-liveness.test.ts).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createNode, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { buildPiArgv } from '../runtime/launch.js';
import { resumeArgs, reviveNode } from '../runtime/revive.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-revive-'));
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
// resumeArgs — the pure resume-source selection
// ---------------------------------------------------------------------------

test('resumeArgs prefers the absolute file path and keeps the id as fallback', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: '/abs/sess.jsonl' });
  assert.deepEqual(resumeArgs(m, true), {
    resumeSessionId: 'uuid-123',
    resumeSessionPath: '/abs/sess.jsonl',
  });
});

test('resumeArgs falls back to the bare id when no file was captured (older node)', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: null });
  assert.deepEqual(resumeArgs(m, true), {
    resumeSessionId: 'uuid-123',
    resumeSessionPath: undefined,
  });
});

test('resumeArgs selects neither source on a no-resume (refresh) revive', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: '/abs/sess.jsonl' });
  assert.deepEqual(resumeArgs(m, false), {});
});

// ---------------------------------------------------------------------------
// buildPiArgv — the `--session` argument the revive builds
// ---------------------------------------------------------------------------

test('buildPiArgv resumes by ABSOLUTE path when pi_session_file is set (not the uuid)', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: '/abs/sess.jsonl' });
  const { argv } = buildPiArgv(m, resumeArgs(m, true));
  const i = argv.indexOf('--session');
  assert.ok(i >= 0, 'argv carries --session');
  assert.equal(argv[i + 1], '/abs/sess.jsonl', 'resumes by absolute file path');
  assert.ok(!argv.includes('uuid-123'), 'the bare uuid is NOT used when a path exists');
});

test('buildPiArgv falls back to --session <uuid> when no path is stored', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: null });
  const { argv } = buildPiArgv(m, resumeArgs(m, true));
  const i = argv.indexOf('--session');
  assert.ok(i >= 0, 'argv carries --session');
  assert.equal(argv[i + 1], 'uuid-123', 'resumes by bare uuid (older node)');
});

test('buildPiArgv passes no --session on a fresh (no-resume) launch', () => {
  const m = node('n', { pi_session_id: 'uuid-123', pi_session_file: '/abs/sess.jsonl' });
  const { argv } = buildPiArgv(m, { prompt: 'go' });
  assert.ok(!argv.includes('--session'), 'a fresh launch never resumes');
  assert.ok(argv.includes('go'), 'the kickoff prompt is the last positional');
});

// ---------------------------------------------------------------------------
// buildPiArgv — the resumed argv replays the persisted launch spec faithfully
// (kind/mode/lifecycle come back as the node's *current* self).
// ---------------------------------------------------------------------------

test('a resumed revive replays the persisted LaunchSpec (model, tools, extensions, prompt, env)', () => {
  const m = node('n', {
    kind: 'developer',
    mode: 'orchestrator',
    pi_session_id: 'uuid-9',
    pi_session_file: '/abs/sess.jsonl',
    launch: {
      model: 'anthropic/sonnet',
      tools: ['bash', 'read'],
      extensions: ['/ext/a.js', '/ext/b.js'],
      systemPrompt: 'You are a developer orchestrator.',
      env: { FOO: 'bar' },
    },
  });
  createNode(m); // scaffolds the node dir so the system prompt persists to a file

  const { argv, env } = buildPiArgv(m, resumeArgs(m, true));

  // Persona extensions, in order.
  const ea = argv.indexOf('/ext/a.js');
  const eb = argv.indexOf('/ext/b.js');
  assert.ok(ea >= 0 && eb > ea, 'extensions replayed in order');
  assert.equal(argv[ea - 1], '-e');

  // Model + tools + system prompt + resume target.
  const mi = argv.indexOf('--model');
  assert.equal(argv[mi + 1], 'anthropic/sonnet');
  const ti = argv.indexOf('--tools');
  assert.equal(argv[ti + 1], 'bash,read');
  assert.ok(argv.includes('--append-system-prompt'), 'system prompt replayed');
  const si = argv.indexOf('--session');
  assert.equal(argv[si + 1], '/abs/sess.jsonl', 'still resumes by file path');

  // Env contract: launch-spec env merged over the node identity env.
  assert.equal(env['FOO'], 'bar');
  assert.equal(env['CRTR_NODE_ID'], 'n');
  assert.equal(env['CRTR_KIND'], 'developer');
  assert.equal(env['CRTR_MODE'], 'orchestrator');
});

// ---------------------------------------------------------------------------
// Double-revive guard — reviveNode no-ops when the window is already alive
// (gated on tmux, which CI may not have; the guard needs a genuinely-live window
// to short-circuit before any tmux mutation).
// ---------------------------------------------------------------------------

/** Hold a real, live tmux window open for the duration of `fn`, then tear down. */
async function withLiveWindow(
  tag: string,
  fn: (session: string, window: string) => Promise<void>,
): Promise<void> {
  const session = `crtr-revivetest-${process.pid}-${tag}`;
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', '/tmp', 'sleep 600']);
  try {
    const r = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_id}'], { encoding: 'utf8' });
    const window = (r.stdout ?? '').trim().split('\n')[0]!;
    await fn(session, window);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  }
}

function windowCount(session: string): number {
  const r = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_id}'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().split('\n').filter((s) => s !== '').length;
}

test('reviveNode no-ops when the node pane is alive AND its pi is LIVE (double-revive guard)', { skip: !hasTmux() }, async () => {
  await withLiveWindow('guard', async (session, window) => {
    // pi_pid = this process: a genuinely LIVE pi. The guard now keys on pane-
    // alive AND pi-alive (Step 7), so this models "another path already revived
    // it" — a no-op (re-launching would double-spawn onto the same session file).
    createNode(node('M', {
      tmux_session: session,
      window,
      cycles: 3,
      pi_pid: process.pid,
      pi_session_id: 'uuid-1',
      pi_session_file: '/abs/m.jsonl',
    }));
    const before = windowCount(session);

    const res = reviveNode('M', { resume: true });

    assert.equal(res.window, window, 'returns the existing live window');
    assert.equal(res.session, session, 'returns the existing session');
    assert.equal(res.resumed, false, 'guard path does not re-resume');
    assert.equal(windowCount(session), before, 'no new window opened');
    assert.equal(getNode('M')?.cycles, 3, 'cycle counter NOT bumped (guard returned early)');
  });
});

test('reviveNode PROCEEDS when the pane is alive but the pi is DEAD (F3 frozen-pane resume)', { skip: !hasTmux() }, async () => {
  // The Step-7 guard fix: a FROZEN focus pane (remain-on-exit) is pane-alive but
  // pi-DEAD — the resume-into-focus case. The OLD pane-only guard would no-op
  // here (the bug that left a frozen focused-dormant node stuck); the new guard
  // gates on pi liveness too, so reviveNode proceeds (bumps the cycle counter).
  await withLiveWindow('frozen', async (session, window) => {
    createNode(node('M', {
      tmux_session: session,
      window,
      cycles: 3,
      pi_pid: 0x7ffffffe, // implausible/dead pid → a frozen pane with no live pi
      pi_session_id: 'uuid-1',
      pi_session_file: '/abs/m.jsonl',
    }));
    reviveNode('M', { resume: true });
    assert.equal(getNode('M')?.cycles, 4, 'cycle counter BUMPED — the guard did NOT short-circuit a frozen pane');
  });
});

// ---------------------------------------------------------------------------
// Step 5 (§5.3): reviveNode DELEGATES placement to reviveIntoPlacement — a
// non-focused node targets its home_session, NEVER its (focus-tainted)
// tmux_session. This is the reviveNode-level bug-kill proof. Gated to run when
// tmux is ABSENT, so openNodeWindow no-ops (returns null) and no real pi is
// launched — the placement DECISION (session + LOCATION) is set synchronously
// regardless of whether a window actually opens, so the assertions are exact.
// (The WITH-tmux window-placement behaviour is proven in placement-revive.test.ts.)
// ---------------------------------------------------------------------------

test('reviveNode delegates to home_session for a non-focused node, IGNORING the tainted tmux_session (§5.3)', { skip: hasTmux() }, async () => {
  const back = `crtr-back-${process.pid}`;
  const tainted = `crtr-user-${process.pid}`; // the focus taint that must be ignored
  // A non-focused child: home_session is the backstage; tmux_session was tainted
  // to a user session by a prior focus and never corrected. No focus row exists.
  createNode(node('M', { home_session: back, tmux_session: tainted, window: '@7', pane: null }));

  const res = reviveNode('M', { resume: false });

  assert.equal(res.session, back, 'revive targets home_session, not the tainted user session');
  assert.notEqual(res.session, tainted, 'NEVER the tainted tmux_session');
  const m = getNode('M')!;
  assert.equal(m.tmux_session, back, 'LOCATION repointed to the backstage (taint overwritten)');
  assert.equal(m.window, null, 'no tmux present → openNodeWindow no-op, window null (decision still recorded)');
  assert.equal(m.cycles, 1, 'a real (non-guard) revive bumped the cycle counter');
});
