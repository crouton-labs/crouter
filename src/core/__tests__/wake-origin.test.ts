// Run with: node --import tsx/esm --test src/core/__tests__/wake-origin.test.ts
//
// Wake-origin self-knowledge at the DAEMON FIRING seams (the other half of the
// regression — wake-bearings.test.ts covers the pure block + the bare-revive
// kickoff). The observed gap: a scheduled wake arrived indistinguishable from an
// ordinary message/spawn (Invariant D). These lock the daemon's third pass:
//   • noted  — the delivered inbox label carries the ⏰ scheduled-wake marker, so
//     a timed note is distinguishable from a plain `node msg` (no tmux needed).
//   • spawn  — a node BORN by a spawn wake gets the <crtr-wake> block prepended
//     to its kickoff prompt (naming the armer + cadence); an ordinary `node new`
//     spawn does NOT. The headline. (tmux-gated integration via the harness.)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNode } from '../canvas/canvas.js';
import { armWake } from '../canvas/wakeups.js';
import { closeDb } from '../canvas/db.js';
import { readInboxSince } from '../feed/inbox.js';
import { superviseTick } from '../../daemon/crtrd.js';
import { hasTmux, createHarness } from './helpers/harness.js';
import type { NodeMeta } from '../canvas/types.js';

const CROUTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

// --- noted seam (no tmux) ---------------------------------------------------

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

// --- spawn seam (the headline; tmux-gated integration) ----------------------

test(
  'a spawn scheduled wake births a node whose kickoff carries <crtr-wake>; node new does NOT',
  { skip: hasTmux() ? false : 'tmux unavailable' },
  async () => {
    const h = await createHarness();
    try {
      const armer = h.spawnRoot('armer');

      // Contrast: an ordinary `node new` spawn — its kickoff has NO wake block.
      const plainChild = await h.spawnChild(armer, 'plain task');
      const plainBoot = await h.awaitBoot(plainChild);
      assert.doesNotMatch(plainBoot.prompt ?? '', /<crtr-wake>/, 'node new carries no wake block');

      // Arm a recurring spawn-cron (detached), fire one tick, inspect the BORN
      // node's kickoff prompt (the message it actually wakes on).
      const before = new Set(readdirSync(join(h.home, 'nodes')));
      armWake({
        wakeup_id: 'wk-spawn-1',
        node_id: null, // canvas-detached deferred birth
        owner_id: armer,
        fire_at: new Date(Date.now() - 1000).toISOString(),
        kind: 'spawn',
        recur: JSON.stringify({ every: '6h' }),
        payload: { kind: 'general', cwd: CROUTER, prompt: 'do the recurring job', parent: armer },
      });
      await h.tick(Date.now());

      const born = readdirSync(join(h.home, 'nodes')).filter((d) => !before.has(d));
      assert.equal(born.length, 1, 'exactly one node born from the spawn wake');
      const bornBoot = await h.awaitBoot(born[0]!);
      const prompt = bornBoot.prompt ?? '';
      assert.match(prompt, /<crtr-wake>/, 'the born node learns a timer birthed it');
      assert.match(prompt, /recurring spawn-cron armed by node /, 'names the armer role-explicitly');
      assert.match(prompt, /firing every 6h/, 'surfaces the cadence');
      assert.match(prompt, new RegExp(armer), 'the still-alive armer is named');
      assert.match(prompt, /do the recurring job/, 'the real task follows the block');
    } finally {
      await h.dispose();
    }
  },
);
