// Run with: node --import tsx/esm --test src/core/__tests__/human-stranded-deliver.test.ts
//
// BUG REGRESSION (human-ask broker round-trip): a headless-broker asker strips
// $TMUX, so the detached `crtr human _run` worker — whose `pushFinal` is the SOLE
// deliver-back + reap step — never spawned. Worse, the `crtr human inbox` drain
// path writes response.json directly (humanloop's inbox()) and ALSO never calls
// pushFinal, so an answered deck strands on disk: the asker never learns the
// answer and the bridge node leaks active forever.
//
// This locks the SECONDARY heal: finalizeResolvedInteraction must, for a still-
// LIVE bridge node whose interaction is resolved on disk, deliver the answer to
// the asker (parent auto-subscribed) and reap the bridge node — exactly what the
// _run worker's pushFinal would have done. Idempotent (no double-deliver once
// done); a canceled-on-disk response reaps without delivering a result.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, subscribe, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { interactionDir, interactionsRoot } from '../artifact.js';
import { atomicWriteJson, deckPath } from '@crouton-kit/humanloop';
import type { NodeMeta } from '../canvas/types.js';
import { finalizeResolvedInteraction, acquireInteractionClaim } from '../../commands/human/queue.js';

let home: string;
// A unique cwd so interactionDir (keyed off the REAL homedir + mangled cwd, NOT
// CRTR_HOME) lands in an isolated, cleanable subtree.
let workCwd: string;

function node(id: string, parent: string | null): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: workCwd,
    kind: 'developer',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    parent,
  } as NodeMeta;
}

/** Seed an interaction dir on disk the way the kickoff + a resolution would. */
function seed(jobId: string, run: object, response: object): void {
  const idir = interactionDir(jobId, workCwd);
  mkdirSync(idir, { recursive: true });
  atomicWriteJson(deckPath(idir), { interactions: [] });
  atomicWriteJson(join(idir, 'run.json'), run);
  atomicWriteJson(join(idir, 'response.json'), response);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-stranded-'));
  process.env['CRTR_HOME'] = home;
  workCwd = mkdtempSync(join(tmpdir(), 'crtr-stranded-cwd-'));
});
beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(interactionsRoot(workCwd), { recursive: true, force: true });
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(interactionsRoot(workCwd), { recursive: true, force: true });
  rmSync(workCwd, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

test('answered-but-undelivered ask delivers back to the asker and reaps the bridge', async () => {
  // Asker A, bridge B under A (parent auto-subscribes to its child bridge).
  createNode(node('A', null));
  createNode(node('B', 'A'));
  subscribe('A', 'B');
  seed(
    'B',
    { mode: 'ask', job_id: 'B' },
    { responses: [{ id: 'q', selectedOptionId: 'resync', freetext: 'go ahead' }], completedAt: '2026-06-10T22:27:07.000Z' },
  );

  const acted = await finalizeResolvedInteraction('B');
  assert.equal(acted, true, 'should have delivered + reaped');

  // Bridge reaped.
  assert.equal(getNode('B')?.status, 'done', 'bridge node must be reaped to done');

  // Answer fanned into the asker's inbox, carrying the choice.
  const inbox = readInboxSince('A');
  assert.equal(inbox.length >= 1, true, 'asker inbox must receive the answer pointer');
  const blob = JSON.stringify(inbox);
  assert.match(blob, /resync/, 'delivered answer should carry the human selection');

  // Idempotent: a second sweep is a no-op (node already done — no double-deliver).
  const again = await finalizeResolvedInteraction('B');
  assert.equal(again, false, 'must not re-deliver an already-finalized interaction');
});

test('a canceled-on-disk response reaps the bridge without delivering a result', async () => {
  createNode(node('A', null));
  createNode(node('B', 'A'));
  subscribe('A', 'B');
  seed('B', { mode: 'ask', job_id: 'B' }, { canceled: true, canceledAt: '2026-06-10T22:42:04.000Z', reason: 'stale' });

  const acted = await finalizeResolvedInteraction('B');
  assert.equal(acted, true);
  assert.equal(getNode('B')?.status, 'done', 'a canceled stranded bridge must still be reaped');

  // The asker gets a quiet "no answer is coming" note, not a result.
  const blob = JSON.stringify(readInboxSince('A'));
  assert.match(blob, /no answer is coming/);
});

test('the _run held-claim path delivers, and finalize without the claim self-conflicts', async () => {
  // BUG REGRESSION (_run ask self-claim): the detached `_run` ask worker holds
  // the exclusive resolve.lock across the blocking ask(), then must deliver the
  // answer. If it calls finalizeResolvedInteraction WITHOUT passing its held
  // claim, finalize re-acquires the same lock, sees this very process's live
  // lock (EEXIST, owner.pid == self, pidAlive true) -> 'claimed' -> returns
  // false, and the human's answer never reaches the asker. Passing the held
  // claim lets finalize run under the worker's own lock.
  createNode(node('A', null));
  createNode(node('B', 'A'));
  subscribe('A', 'B');
  // Set up the deck + run.json but NOT the answer yet, then hold the claim
  // exactly as the _run worker does (no opts) BEFORE ask() resolves the deck.
  const idir = interactionDir('B', workCwd);
  mkdirSync(idir, { recursive: true });
  atomicWriteJson(deckPath(idir), { interactions: [] });
  atomicWriteJson(join(idir, 'run.json'), { mode: 'ask', job_id: 'B' });
  const claim = acquireInteractionClaim(idir, 'B');
  assert.equal(typeof claim === 'object', true, 'claim must be acquired');
  if (typeof claim !== 'object') return;
  // ask() then writes the human's answer to disk while the claim is held.
  atomicWriteJson(join(idir, 'response.json'), {
    responses: [{ id: 'q', selectedOptionId: 'resync', freetext: 'go ahead' }],
    completedAt: '2026-06-10T22:27:07.000Z',
  });

  // Without the held claim, finalize from the SAME pid self-conflicts on the
  // live lock and must NOT deliver (this is the stranding regression).
  assert.equal(await finalizeResolvedInteraction('B'), false, 'self-held lock must block claimless finalize');
  assert.equal(getNode('B')?.status, 'active', 'bridge must still be live after the self-conflicting call');

  // Passing the held claim lets finalize run under the worker's own lock and
  // deliver the answer back to the asker, then reap the bridge.
  assert.equal(await finalizeResolvedInteraction('B', claim), true, 'held claim must deliver');
  assert.equal(getNode('B')?.status, 'done', 'bridge reaped after held-claim deliver');
  assert.match(JSON.stringify(readInboxSince('A')), /resync/, 'asker must receive the human selection');

  claim.release();
});

test('an unresolved (no response.json) live bridge is left untouched', async () => {
  createNode(node('A', null));
  createNode(node('B', 'A'));
  subscribe('A', 'B');
  const idir = interactionDir('B', workCwd);
  mkdirSync(idir, { recursive: true });
  atomicWriteJson(join(idir, 'run.json'), { mode: 'ask', job_id: 'B' });

  assert.equal(await finalizeResolvedInteraction('B'), false);
  assert.equal(getNode('B')?.status, 'active', 'still-pending bridge must stay live');
});
