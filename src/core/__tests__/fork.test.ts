// Run with: node --import tsx/esm --test src/core/__tests__/fork.test.ts
//
// Covers `crtr node new --fork-from`: the spawn-time branch where a new node is
// born as a COPY of an existing pi conversation. Two pure layers are unit-tested
// here — `buildPiArgv` emitting `--fork` (vs `--session`), and `resolveForkSource`
// turning a node id / path / uuid into the `--fork <path|id>` argument. The tmux
// spawn itself is exercised elsewhere (it needs a live pi + tmux).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { buildPiArgv } from '../runtime/launch.js';
import { resolveForkSource } from '../runtime/spawn.js';
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

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-fork-'));
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
// buildPiArgv — `--fork` is the spawn-time branch (not `--session`)
// ---------------------------------------------------------------------------

test('buildPiArgv emits --fork <src> and delivers the kickoff prompt', () => {
  const m = node('n');
  const { argv } = buildPiArgv(m, { prompt: 'continue from here', forkFrom: '/abs/src.jsonl' });
  const i = argv.indexOf('--fork');
  assert.ok(i >= 0, 'argv carries --fork');
  assert.equal(argv[i + 1], '/abs/src.jsonl', 'forks from the resolved source');
  assert.ok(!argv.includes('--session'), 'a fork never also resumes');
  assert.equal(argv[argv.length - 1], 'continue from here', 'the kickoff prompt is the last positional');
});

test('buildPiArgv prefers --fork over --session when both are somehow set', () => {
  const m = node('n');
  const { argv } = buildPiArgv(m, { forkFrom: '/abs/src.jsonl', resumeSessionPath: '/abs/own.jsonl' });
  assert.ok(argv.includes('--fork'), 'fork wins');
  assert.ok(!argv.includes('--session'), 'resume is suppressed when forking');
});

test('buildPiArgv without forkFrom is unchanged (fresh launch, no --fork)', () => {
  const m = node('n');
  const { argv } = buildPiArgv(m, { prompt: 'go' });
  assert.ok(!argv.includes('--fork'), 'no fork on an ordinary fresh launch');
  assert.ok(!argv.includes('--session'), 'no resume either');
});

// ---------------------------------------------------------------------------
// resolveForkSource — node id / path / uuid → the `--fork` argument
// ---------------------------------------------------------------------------

test('resolveForkSource resolves a node id to its absolute session FILE', () => {
  createNode(node('src', { pi_session_id: 'uuid-1', pi_session_file: '/abs/src.jsonl' }));
  assert.equal(resolveForkSource('src'), '/abs/src.jsonl');
});

test('resolveForkSource falls back to the bare session id when no file captured', () => {
  createNode(node('src', { pi_session_id: 'uuid-1' }));
  assert.equal(resolveForkSource('src'), 'uuid-1');
});

test('resolveForkSource throws when the node has no pi session to fork yet', () => {
  createNode(node('fresh'));
  assert.throws(() => resolveForkSource('fresh'), /no pi session yet/);
});

test('resolveForkSource passes a path straight through', () => {
  assert.equal(resolveForkSource('/some/where/sess.jsonl'), '/some/where/sess.jsonl');
});

test('resolveForkSource passes an unknown bare/partial uuid through to pi', () => {
  assert.equal(resolveForkSource('019e8ce3-322e'), '019e8ce3-322e');
});

test('resolveForkSource rejects an empty reference', () => {
  assert.throws(() => resolveForkSource('   '), /requires a node id/);
});
