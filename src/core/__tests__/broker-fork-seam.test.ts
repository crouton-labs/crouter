// Run with: node --import tsx/esm --test src/core/__tests__/broker-fork-seam.test.ts
//
// BUG-REGRESSION (broker-universal-host cut, design §B.broker; U1 report
// mq8ftenr-5d55313d). Before the cut, the headless broker had NO fork path — its
// session selection THREW `--fork is not supported by the headless broker`. After
// the cut EVERY node is a broker, so `node new --fork-from <id>` would always hit
// that throw. The fix routes the broker's fork through pi's REAL fork seam,
// SessionManager.forkFrom (broker.ts buildBrokerSession, the `forking` branch) —
// the same method pi's own `--fork` CLI flag uses.
//
// This test drives that EXACT seam (the SDK method the broker calls) end to end:
// build a real source session .jsonl, fork it, and assert real fork metadata —
// a NEW session id (not a colliding copy) and a `parentSession` header pointing
// at the source, with the source's history copied in. That proves fork is NOT
// thrown and yields genuine fork lineage, not a naïve .jsonl copy.
//
// (fork.test.ts covers the pure argv/resolve layers — buildPiArgv emitting
// `--fork`, resolveForkSource turning a ref into a path. THIS file covers the
// runtime SDK seam those layers feed.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'crtr-fork-seam-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal but VALID pi session .jsonl (the exact on-disk shape v3 emits): a
 *  `session` header line + two `message` entries. This is what a node that has
 *  run a turn or two carries on disk — the source the broker forks from. */
function writeSourceSession(path: string, srcId: string): number {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: srcId, timestamp: '2026-06-10T20:27:32.891Z', cwd: dir }),
    JSON.stringify({ type: 'message', id: 'a42170e1', parentId: null, timestamp: '2026-06-10T20:27:32.893Z', message: { role: 'user', content: 'source turn one' } }),
    JSON.stringify({ type: 'message', id: 'f309b932', parentId: 'a42170e1', timestamp: '2026-06-10T20:27:32.893Z', message: { role: 'assistant', content: 'source reply one' } }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return 2; // entry count (the two message lines)
}

test('D2 broker fork seam: SessionManager.forkFrom yields a NEW id + parentSession header, copying history (never throws "fork not supported")', () => {
  // 1. A real source session on disk.
  const srcFile = join(dir, 'src.jsonl');
  const srcId = '019eb338-029b-7536-b3eb-d33bd6f641a8';
  const srcEntryCount = writeSourceSession(srcFile, srcId);

  // 2. The EXACT call the broker makes for a fork (broker.ts buildBrokerSession):
  //    SessionManager.forkFrom(sourcePath, targetCwd). The OLD broker threw here.
  let forked: ReturnType<typeof SessionManager.forkFrom> | undefined;
  assert.doesNotThrow(() => {
    forked = SessionManager.forkFrom(srcFile, dir);
  }, 'fork must NOT throw "fork is not supported by the headless broker"');
  assert.ok(forked !== undefined, 'forkFrom returned a SessionManager');

  // 3. Real fork metadata, not a colliding .jsonl copy.
  assert.notEqual(forked.getSessionId(), srcId, 'the fork is a NEW session id (not a copy that would collide on resume)');

  const header = forked.getHeader() as { parentSession?: string };
  assert.equal(header.parentSession, srcFile, 'the fork header records parentSession pointing at the source .jsonl');

  // 4. The source history is carried into the fork (fork copies, it does not start empty).
  assert.equal(forked.getEntries().length, srcEntryCount, 'the fork carries the source conversation history forward');
});
