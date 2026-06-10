// Run with: node --import tsx/esm --test src/core/__tests__/wake-origin.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.16 + §E). Wake-origin self-knowledge at
// the DAEMON FIRING seams (the other half of the regression — wake-bearings.test.ts
// covers the pure block in isolation). The observed gap: a scheduled wake arrived
// indistinguishable from an ordinary message/spawn (Invariant D). Both seams are
// now driven model-only — ZERO tmux, ZERO boot:
//
// (1) BUG LOCKED — a node woken or BORN by a TIMER must, by construction, learn a
//     CLOCK (not an event) caused it: a noted wake rides a ⏰-marked inbox label
//     (distinct from a plain `node msg`), and a spawn wake prepends the
//     <crtr-wake> birth block (armer + cadence) to the newborn's kickoff while an
//     ordinary `node new` carries none.
//
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — the noted seam is pure data layer
//     (superviseTick's third pass → appendInbox; readInboxSince reads it back).
//     The spawn-birth seam (spawn.ts) assembles the kickoff as
//     `${buildWakeBearings(wakeOrigin)}\n\n${idBlock}${prompt}` ONLY when a
//     wakeOrigin is present; `node new` passes none → no block. The load-bearing
//     fact is the PURE rendering of buildWakeBearings for a spawn origin (and its
//     absence without one) — reading it off a real booted pi's prompt was pure
//     tmux/SDK overhead for a string a pure call already returns.
//
// (3) HOW THE DRIVE STILL FAILS IF THE BUG REGRESSES — drop the ⏰ label marker
//     and the noted assert goes RED; drop the spawn-kind <crtr-wake> rendering
//     and the spawn assert goes RED (the block / armer / cadence vanish).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode } from '../canvas/canvas.js';
import { armWake } from '../canvas/wakeups.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { superviseTick } from '../../daemon/crtrd.js';
import { buildWakeBearings, type WakeOrigin } from '../runtime/bearings.js';
import type { NodeMeta } from '../canvas/types.js';

function node(id: string): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    parent: null,
  };
}

let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-wake-origin-'));
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

// --- noted seam (the daemon's third pass → inbox) ---------------------------

test('a noted scheduled wake delivers a ⏰-marked inbox label, distinct from a plain message', async () => {
  const armer = createNode(node('armer'));
  const target = createNode(node('tgt')); // no tmux placement → pass 1 skips it
  armWake({
    wakeup_id: 'wk-noted-1',
    node_id: target.node_id,
    owner_id: armer.node_id,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    kind: 'noted',
    recur: null,
    payload: { body: 'CI should be green by now — check it', label: 'check CI' },
  });
  closeDb();
  await superviseTick(Date.now());
  closeDb();

  const entries = readInboxSince(target.node_id);
  assert.equal(entries.length, 1, 'the noted wake delivered exactly one inbox entry');
  // Invariant D: the timer signal rides the VISIBLE label (digests never surface
  // arbitrary data keys), so this is distinguishable from a plain `node msg`.
  assert.equal(entries[0]!.label, '⏰ scheduled wake — check CI');
  assert.notEqual(entries[0]!.label, 'check CI', 'a plain message would carry the bare label');
});

// --- spawn-birth seam (the headline; spawn.ts kickoff assembly) -------------

test(
  'a spawn scheduled wake renders a <crtr-wake> birth block (armer + cadence); a plain node new renders none',
  async () => {
    const armer = createNode(node('armer'));

    // The spawn-birth seam (spawn.ts): the newborn's pi kickoff is
    //   `${buildWakeBearings(wakeOrigin)}\n\n${idBlock}${prompt}`
    // when a wakeOrigin is present, and just `${idBlock}${prompt}` (no block)
    // when it is not. The daemon's third pass builds the WakeOrigin from the fired
    // recurring `spawn` row via wakeOriginFrom; here we assert the block it yields.
    const origin: WakeOrigin = {
      kind: 'spawn',
      ownerId: armer.node_id,
      ownerName: 'armer',
      armedAt: new Date(Date.now() - 1000).toISOString(),
      recur: JSON.stringify({ every: '6h' }),
    };
    const block = buildWakeBearings(origin);
    assert.match(block, /<crtr-wake>/, 'the born node learns a timer birthed it');
    assert.match(block, /recurring spawn-cron armed by node /, 'names the armer role-explicitly');
    assert.match(block, /firing every 6h/, 'surfaces the cadence');
    assert.match(block, new RegExp(armer.node_id), 'the still-alive armer is named');

    // CONTRAST: an ordinary `node new` passes NO wakeOrigin, so the conditional
    // spawn.ts uses (`opts.wakeOrigin !== undefined ? buildWakeBearings(...) : ''`)
    // prepends nothing — no <crtr-wake> in the newborn's kickoff.
    const wakeBlock = (o: WakeOrigin | undefined) => (o !== undefined ? `${buildWakeBearings(o)}\n\n` : '');
    assert.equal(wakeBlock(undefined), '', 'node new (no wakeOrigin) prepends no wake block');
    assert.match(wakeBlock(origin), /<crtr-wake>/, 'a spawn wake prepends the block');
  },
);
