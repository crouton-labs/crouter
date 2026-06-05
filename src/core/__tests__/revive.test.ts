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

test('reviveNode no-ops when the node window is already alive (double-revive guard)', { skip: !hasTmux() }, async () => {
  await withLiveWindow('guard', async (session, window) => {
    createNode(node('M', {
      tmux_session: session,
      window,
      cycles: 3,
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
