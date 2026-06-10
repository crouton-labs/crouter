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
// This test drives the BROKER's OWN fork branch (broker.ts buildBrokerSession,
// the `forking` branch ~1106) end to end: it calls `buildBrokerSession` with
// `cfg.forkFrom` set to a real source session .jsonl — the EXACT path a
// `node new --fork-from <id>` boot takes through the broker — and asserts the
// resulting live session is a genuine fork: a NEW session id (not a colliding
// copy) and a `parentSession` header pointing at the source, with the source's
// history copied in. Because it invokes `buildBrokerSession` (not
// `SessionManager.forkFrom` directly), it goes RED if broker.ts's fork branch
// reverts to `throw "--fork is not supported by the headless broker"` — it
// guards its own stated regression.
//
// Like the C3/C4 real-SDK wiring tests, it drives the REAL engine (broker-sdk's
// static SDK re-exports) — NOT the CRTR_BROKER_ENGINE fake the lifecycle suite
// uses, whose fixture omits forkFrom and so could never exercise this branch. It
// runs offline (fork + session/services assembly are all local: no network/auth).
//
// (fork.test.ts covers the pure argv/resolve layers — buildPiArgv emitting
// `--fork`, resolveForkSource turning a ref into a path. THIS file covers the
// broker runtime branch those layers feed.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
  type BrokerEngine,
} from '../runtime/broker-sdk.js';
import { buildBrokerSession } from '../runtime/broker.js';
import type { BrokerSdkConfig } from '../runtime/launch.js';

// The REAL engine — bypasses the CRTR_BROKER_ENGINE fake entirely (the whole
// point: the fake omits forkFrom, so only the real SDK can prove the branch).
const realEngine: BrokerEngine = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
};

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

test('D2 broker fork branch: buildBrokerSession(cfg.forkFrom) yields a NEW id + parentSession header, copying history (never throws "fork not supported")', async () => {
  // 1. A real source session on disk.
  const srcFile = join(dir, 'src.jsonl');
  const srcId = '019eb338-029b-7536-b3eb-d33bd6f641a8';
  const srcEntryCount = writeSourceSession(srcFile, srcId);

  // 2. Drive the BROKER's fork branch: buildBrokerSession with cfg.forkFrom set —
  //    the same recipe a `node new --fork-from <id>` boot produces. The OLD broker
  //    THREW in this branch ("--fork is not supported by the headless broker"), so
  //    if broker.ts:~1106 reverts to that throw, this rejects and the test goes RED.
  const cfg: BrokerSdkConfig = { cwd: dir, extensionPaths: [], forkFrom: srcFile };
  let session: Awaited<ReturnType<typeof buildBrokerSession>>['session'] | undefined;
  let resuming: boolean | undefined;
  await assert.doesNotReject(async () => {
    const built = await buildBrokerSession(realEngine, cfg);
    session = built.session;
    resuming = built.resuming;
  }, 'the broker fork branch must NOT throw "fork is not supported by the headless broker"');
  assert.ok(session !== undefined, 'buildBrokerSession returned a live session for the fork');

  try {
    // 3. A fork boots as a FRESH spawn (resuming=false) so the kickoff firstPrompt
    //    fires — the new node gets the source history AND a new task to start on.
    assert.equal(resuming, false, 'a fork is a fresh spawn (resuming=false) so the kickoff fires');

    // 4. Real fork metadata on the broker's selected SessionManager, not a
    //    colliding .jsonl copy.
    const sm = session!.sessionManager;
    assert.notEqual(
      sm.getSessionId(),
      srcId,
      'the fork is a NEW session id (not a copy that would collide on resume)',
    );

    const header = sm.getHeader() as { parentSession?: string } | null;
    assert.equal(
      header?.parentSession,
      srcFile,
      'the fork header records parentSession pointing at the source .jsonl',
    );

    // 5. The source history is carried into the fork (fork copies, not empty
    //    start). The broker boot may append its own session-start entry, so the
    //    fork holds AT LEAST the source's messages — a naïve empty session would
    //    have zero.
    assert.ok(
      sm.getEntries().length >= srcEntryCount,
      `the fork carries the source conversation history forward ` +
        `(>= ${srcEntryCount} source entries; got ${sm.getEntries().length})`,
    );
  } finally {
    session!.dispose();
  }
});
