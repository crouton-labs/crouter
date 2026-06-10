// Run with: node --import tsx/esm --test src/core/__tests__/live-mutation-verbs.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.11 + §E). AXIS: LIVE MUTATION, part 2 —
// the demote/recycle verb split and the A4 promote-then-yield boundary, driven
// against FABRICATED broker-hosted (paneless) nodes — no real tmux session, no
// pane chrome, and NO real broker boot. Split out of live-mutation.test.ts for
// node:test file-level parallelism; each test holds its OWN isolated harness.
//
// THREE-PART LOCK HEADER ──────────────────────────────────────────────────
// (1) BUG LOCKED — the demote/recycle SPLIT and the A4 steer-loss boundary:
//     • `node demote` flips lifecycle→TERMINAL IN PLACE — keeps MODE, parentage,
//       and a live (active) status; NOT finalized. It is NOT a mode flip.
//     • `node recycle` is FINISH+RECYCLE — pushes a final → done (mode KEPT), and
//       mints a DIFFERENT fresh general/base/resident root.
//     • A4: a base→orchestrator yield auto-promotes (mode→orchestrator) and sets
//       intent=refresh but NEVER commits persona_ack — the drift is left pending
//       and, because a yield's agent_end goes straight to the refresh-revive with
//       NO preceding turn_end, the only steer-delivery site is bypassed.
// (2) WHY MODEL-LEVEL, NOT PANE/WINDOW — demote writes lifecycle on the row
//     (setLifecycle→updateNode); recycle's FINISH+MINT half is pushFinal +
//     spawnNode (pure model) — only its pane-respawn is tmux (a deliberately-
//     skipped artifact here, recycled:false). yield's auto-promote + intent set
//     are row writes; persona_ack/personaDrift are pure. No pane is read for any
//     assertion.
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE FIX REGRESSES — if demote also
//     flipped MODE, the 'mode stays orchestrator' assert goes RED; if recycle
//     re-roled instead of finishing, 'recycled node → done' / 'fresh root born
//     base×resident' go RED; if yield committed the ack, the A4 'ack STILL base'
//     / pending-drift asserts go RED.
//
// STOPHOOK CAVEAT — split (option b). The original drove a LIVE fake-pi so the
// REAL stophook enacted recycle's viewer teardown and A4's refresh-revive ack-drain
// at agent_end. Fabrication cannot run those hooks. So: recycle is driven through
// the real recycleNode (its FINISH+MINT model half runs fully; the pane respawn
// is the only tmux artifact, intentionally skipped → recycled:false). For A4 the
// PURE pre-stop facts are asserted (auto-promote, intent=refresh, ack PENDING,
// personaDrift); the ack-commit-at-refresh-drain is locked by persona.test.ts
// ('… then clears on commit'), and the steer-bypass follows because no turn_end
// ever fires on the yield path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { recycleNode } from '../runtime/recycle.js';
import { commitPersonaAck, personaDrift } from '../runtime/persona.js';
import type { NodeMeta } from '../canvas/types.js';

/** Normalize the two persona axes off a NodeMeta for deepEqual. */
function persona(m: NodeMeta): { mode: string; lifecycle: string } {
  return { mode: m.mode, lifecycle: m.lifecycle };
}

// ===========================================================================
// (b) THE demote / recycle SPLIT — two DISTINCT verbs:
//   • `node demote`  flips a LIVE node's lifecycle→TERMINAL IN PLACE — it keeps
//     its MODE and parentage, keeps running (active), is NOT finalized; it now
//     merely owes a final up the spine (vision F5). MODE is untouched.
//   • `node recycle` is FINISH+RECYCLE — push final → done, then recycle the pane
//     into a FRESH general/base/resident root (a DIFFERENT node). The recycled
//     node keeps mode=orchestrator (it is merely `done`).
// This test drives demote via the real CLI verb and recycle via the real
// recycleNode, pinning each behavior at the model layer.
// ===========================================================================
test(
  'node demote flips lifecycle→terminal IN PLACE; node recycle is FINISH+RECYCLE',
  { timeout: 20_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-live-demote' });
    try {
      const A = h.spawnRoot('resident root');
      const B = h.fabricateBrokerNode({ parent: A, kind: 'developer', mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(A, B, true);
      // Make B resident + orchestrator so the demote's flip→terminal is visible
      // and we can prove MODE/parentage survive it.
      assert.equal(h.cli(B, ['node', 'lifecycle', 'resident', '--node', B]).code, 0, 'B → resident');
      assert.equal(h.cli(B, ['node', 'promote', '--kind', 'developer']).code, 0, 'promote B');
      {
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'resident', 'B resident before demote');
        assert.equal(b.mode, 'orchestrator', 'B orchestrator before demote');
      }
      const bParent = h.node(B)!.parent;

      // --- node demote: flip-to-terminal IN PLACE. Keeps B alive, MODE/parentage
      //     untouched, NOT finalized.
      const dem = h.cli(B, ['node', 'demote', '--node', B]);
      assert.equal(dem.code, 0, `node demote exit 0\n${dem.stderr}`);
      assert.match(dem.stdout, /^Demoted /, `demote rendered\n${dem.stdout}`);
      {
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'terminal', 'demote flips lifecycle→terminal IN PLACE');
        assert.equal(b.mode, 'orchestrator', 'demote leaves MODE untouched (not an orchestrator→base flip)');
        assert.equal(b.parent, bParent, 'demote leaves parentage unchanged');
        assert.equal(b.status, 'active', 'demote does NOT finish B — it keeps running in place');
        assert.notEqual(b.intent ?? null, 'done', 'demote does NOT finalize B');
      }

      // --- node recycle: FINISH + RECYCLE. Driven through the real recycleNode.
      //     Its FINISH+MINT model half runs fully; the pane respawn is the only
      //     tmux artifact (no pane for a broker node), so recycled:false while
      //     finalized:true and a fresh root IS minted — the bug-lock (recycle ≠
      //     demote) is entirely in that model half.
      const res = await recycleNode(B, '%recycle-headless');
      assert.equal(res.finalized, true, 'recycle pushed a final for the node (FINISH half ran)');
      assert.ok(typeof res.newRoot === 'string' && res.newRoot !== B, 'a fresh root (≠ B) was minted');

      // The recycled node is FINISHED, not mode-flipped.
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'done', 'recycled node → done (finished), NOT re-roled');
        assert.equal(b.intent, 'done', 'intent=done (finalize), per the push-final path');
        assert.equal(b.mode, 'orchestrator', 'recycled node KEEPS mode=orchestrator — recycle is NOT a mode flip');
      }

      // The fresh root is a DIFFERENT, BASE×RESIDENT node.
      {
        const fresh = h.node(res.newRoot!)!;
        assert.deepEqual(persona(fresh), { mode: 'base', lifecycle: 'resident' }, 'recycled root is born base×resident (general)');
        assert.deepEqual(fresh.persona_ack, { mode: 'base', lifecycle: 'resident' }, 'fresh root born acked base×resident');
        assert.equal(fresh.parent ?? null, null, 'the fresh root is a root (no parent)');
      }
    } finally {
      await h.dispose();
    }
  },
);

// ===========================================================================
// (b) A4 BOUNDARY — promote-then-yield emits a steer that is discarded. A
//     `node yield` on a base node auto-promotes (mode→orchestrator, ack NOT
//     committed) and its agent_end goes STRAIGHT to the refresh-revive with NO
//     preceding turn_end — so the only steer-delivery site (turn_end) is
//     BYPASSED. The deterministic, host-independent facts the yield verb leaves
//     behind pin the boundary:
//       (1) auto-promote: mode→orchestrator.
//       (2) intent=refresh set.
//       (3) persona_ack STILL base — the verb never commits it (only an injector
//           or the refresh drain does); the drift is left PENDING.
//     The ack's silent advance at the refresh drain (refresh-revive→drainBearings
//     →commitPersonaAck) is locked by persona.test.ts; because no turn_end ever
//     fires on the yield path, that ack moves WITHOUT the orchestration steer
//     ever being delivered — the A4 LOSS.
// ===========================================================================
test(
  'A4: a base→orchestrator yield auto-promotes + sets refresh but leaves persona_ack PENDING (the steer is never delivered)',
  { timeout: 20_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-live-a4' });
    try {
      const A = h.spawnRoot('resident root');
      const B = h.fabricateBrokerNode({ parent: A, kind: 'developer', mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(A, B, true);
      // Born acked to its own persona (mirroring a real birth) → no spurious
      // drift before the yield.
      commitPersonaAck(B, { mode: 'base', lifecycle: 'terminal' });
      assert.deepEqual(persona(h.node(B)!), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');
      assert.equal(personaDrift(B), null, 'no drift before the yield');

      // `crtr node yield` (base → auto-promote → intent=refresh). State AFTER the
      // verb, BEFORE any agent_end: mode flipped, ack NOT yet committed (the
      // turn_end injector has not run), intent=refresh, drift PENDING.
      const y = h.cli(B, ['node', 'yield', 'refresh against the roadmap']);
      assert.equal(y.code, 0, `node yield exit 0\n${y.stderr}`);
      {
        const b = h.node(B)!;
        assert.equal(b.mode, 'orchestrator', 'yield auto-promoted base→orchestrator');
        assert.equal(b.intent, 'refresh', 'intent=refresh set by the yield');
        assert.deepEqual(
          b.persona_ack,
          { mode: 'base', lifecycle: 'terminal' },
          'ack STILL base — promote/yield never commits it; only an injector or the refresh drain does',
        );
      }

      // THE A4 PENDING-DRIFT LOCK — the base→orchestrator guidance is left
      // PENDING (personaDrift reports it) and is the ONLY thing the (bypassed)
      // turn_end injector would have delivered as a steer. The ack's silent
      // advance at the refresh drain — NOT via a steer — is locked by
      // persona.test.ts; the steer is lost because no turn_end fires on this path.
      {
        const drift = personaDrift(B);
        assert.ok(drift !== null, 'the orchestration guidance is PENDING after the yield (drift detected)');
        assert.deepEqual(drift?.to, { mode: 'orchestrator', lifecycle: 'terminal' }, 'pending drift → orchestrator×terminal');
        assert.match(drift?.guidance ?? '', /ORCHESTRATOR/i, 'the pending (lost) steer carries the orchestration guidance');
      }
    } finally {
      await h.dispose();
    }
  },
);
