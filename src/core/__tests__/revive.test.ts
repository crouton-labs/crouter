// Run with: node --import tsx/esm --test src/core/__tests__/revive.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.13 + §E). Covers the session-picker fix
// (resume by ABSOLUTE session-file path, cwd-immune, falling back to the bare
// uuid for older nodes) AND the double-revive guard that keeps two pi processes
// off one session file. The argv selection is unit-tested via the pure
// `resumeArgs` + `buildPiArgv`; the guard + the cycle-counter bump are now driven
// against a fabricated BROKER-hosted node — ZERO real tmux, ZERO real boot.
//
// (1) BUG LOCKED — the double-revive guard (revive.ts:114): a node already up
//     (its engine container alive AND its pi pid live) must NOT be re-launched —
//     a second pi on the same .jsonl corrupts the conversation. The complement:
//     a revive that DOES proceed bumps the node's `cycles` BEFORE it spawns
//     (revive.ts cycles++, then transition('revive'), then launch).
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — the guard's `isAlive` is host-keyed: a
//     BROKER's container liveness IS `isPidAlive(pi_pid)` (host.ts headlessBrokerHost),
//     so a fabricated broker row carrying a LIVE pid reproduces the exact "already
//     up" state the guard short-circuits on — no pane, no window, no tmux server.
//     The old tmux assertion ("no NEW window opened") was a tmux artifact; the
//     real invariant is the model effect: `cycles` UNCHANGED on the guard path,
//     and bumped to 1 when the revive proceeds (revive.ts bumps cycles
//     synchronously before the detached launch — observable INSTANTLY, no
//     awaitBoot). The taint-ignoring WINDOW placement decision is a genuine tmux
//     concern and stays in full/placement-revive.test.ts.
//
// (3) HOW THE DRIVE STILL FAILS IF THE BUG REGRESSES — remove the guard's
//     short-circuit and the live-pid broker revive bumps cycles (1, not 0) → the
//     guard assert goes RED; break the cycles++ and the proceed test (expecting 1)
//     goes RED.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { createNode, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { buildPiArgv } from '../runtime/launch.js';
import { resumeArgs, reviveNode } from '../runtime/revive.js';
import { createHarness, type Harness } from './helpers/harness.js';
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

/** A pid that is guaranteed dead — a crashed broker the guard must NOT see as up. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

/** A pid ALIVE for the test but EXPENDABLE — NEVER process.pid: the harness's
 *  dispose() SIGKILLs every recorded pi_pid, which would take the test runner
 *  down. A detached `sleep` is the live-engine stand-in; dispose reaps it. */
const livePids: number[] = [];
function disposableLivePid(): number {
  const c = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  c.unref();
  livePids.push(c.pid!);
  return c.pid!;
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
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already reaped by dispose() — fine */
    }
  }
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
// Double-revive guard — reviveNode no-ops when the node's engine is already up
// (container alive AND pi pid live). Fabricated as a BROKER node, whose engine-
// container liveness IS its pi-pid liveness (host.ts), so the guard is exercised
// with NO tmux and NO real boot. A live pid → guard short-circuits (cycles flat);
// a dead pid → revive proceeds (cycles bumped before the detached launch).
// ---------------------------------------------------------------------------

test('reviveNode no-ops when the broker engine is already up (live pid) — double-revive guard', async () => {
  const h: Harness = await createHarness({ headless: true, sessionPrefix: 'crtr-revive-guard' });
  try {
    // pi_pid = this process: a genuinely LIVE engine. The guard keys on the host's
    // isAlive (a broker's IS isPidAlive(pi_pid)) AND pi-alive, so this models
    // "another path already revived it" — re-launching would double-spawn onto the
    // same .jsonl. reviveNode only READS isPidAlive here (never signals), so
    // process.pid is NOT safe (dispose SIGKILLs every recorded pi_pid), so use a
    // disposable live sleep as the alive-engine stand-in.
    const M = h.fabricateBrokerNode({
      status: 'active',
      intent: null,
      pi_pid: disposableLivePid(),
      pi_session_id: 'uuid-1',
    });
    const before = h.node(M)!.cycles ?? 0;

    const res = reviveNode(M, { resume: true });

    assert.equal(res.resumed, false, 'guard path does not re-resume');
    assert.equal(h.node(M)!.cycles ?? 0, before, 'cycle counter NOT bumped (guard returned early)');
  } finally {
    await h.dispose();
  }
});

test('reviveNode PROCEEDS when the broker engine is DOWN (dead pid) — cycle counter bumps 0→1', async () => {
  const h: Harness = await createHarness({ headless: true, sessionPrefix: 'crtr-revive-proceed' });
  try {
    // A crashed broker: container DOWN (dead pid) → the guard does NOT short-
    // circuit → reviveNode proceeds. It bumps cycles BEFORE the detached (fake-
    // engine) launch, so the bump is observable instantly; the throwaway broker is
    // killed by dispose().
    const M = h.fabricateBrokerNode({
      status: 'active',
      intent: null,
      pi_pid: deadPid(),
      pi_session_id: 'uuid-1',
    });
    assert.equal(h.node(M)!.cycles ?? 0, 0, 'fabricated at cycle 0 (no revive yet)');

    reviveNode(M, { resume: true });

    assert.equal(h.node(M)!.cycles, 1, 'a real (non-guard) revive bumped the cycle counter to 1');
  } finally {
    await h.dispose();
  }
});
