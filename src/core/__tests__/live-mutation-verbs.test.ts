// Run with: node --import tsx/esm --test src/core/__tests__/live-mutation-verbs.test.ts
//
// AXIS: LIVE MUTATION, part 2 — the demote/recycle verb split and the A4
// promote-then-yield boundary. Split out of live-mutation.test.ts (see its
// header for the coverage rationale and the oracle reference) so node:test's
// file-level parallelism applies; each test builds its OWN isolated harness and
// is moved here UNCHANGED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness, type Injected } from './helpers/harness.js';
import type { NodeMeta } from '../canvas/types.js';

const SKIP = !hasTmux() ? 'tmux unavailable' : false;

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

// --- pure test-local helpers (shared verbatim with live-mutation.test.ts) ---
/** The injected entries delivered as a turn-boundary `steer`. */
function steers(inj: Injected[]): Injected[] {
  return inj.filter((e) => e.deliverAs === 'steer');
}
/** A steer carrying the base→orchestrator orchestration guidance. */
function orchestrationSteers(inj: Injected[]): Injected[] {
  return steers(inj).filter((e) => /ORCHESTRATOR/i.test(e.content));
}
/** Normalize the two persona axes off a NodeMeta for deepEqual. */
function persona(m: NodeMeta): { mode: string; lifecycle: string } {
  return { mode: m.mode, lifecycle: m.lifecycle };
}
/** The first %pane_id of a tmux window. The spawn path records window+session
 *  but NOT pane (spawn.ts: pane is null until a reconcile/focus), so a node's
 *  live pane must be resolved from its window here. */
function firstPaneOf(window: string): string | null {
  const r = spawnSync('tmux', ['list-panes', '-t', window, '-F', '#{pane_id}'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null;
}

// ===========================================================================
// (b) THE demote / recycle SPLIT — two DISTINCT verbs after the rename:
//   • `node demote`  flips a LIVE node's lifecycle→TERMINAL IN PLACE — it keeps
//     its pane, its MODE, and its parentage, keeps running, is NOT finalized; it
//     now merely owes a final up the spine (vision F5). It is NOT an
//     orchestrator→base mode flip — MODE is untouched (so persona.ts
//     `baseModeGuidance` stays unreachable via live mutation, as before).
//   • `node recycle` is FINISH+RECYCLE — push final → done, then recycle the
//     pane into a FRESH general/base/resident root (a DIFFERENT node). The
//     recycled node keeps mode=orchestrator (it is merely `done`).
// This test drives BOTH real verbs on one live node and pins each behavior.
// ===========================================================================
test(
  'node demote flips lifecycle→terminal IN PLACE; node recycle is FINISH+RECYCLE',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-live-demote' });
    try {
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
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

      // --- node recycle: FINISH + RECYCLE the SAME pane into a fresh root.
      //     Resolve B's live %pane_id from its window (the row's `pane` is null
      //     until a reconcile; the spawn path records only window+session).
      const pane = firstPaneOf(h.node(B)!.window!);
      assert.ok(typeof pane === 'string' && pane !== '', 'B has a live pane to recycle');
      // RECYCLE via the real verb (TMUX_PANE is scrubbed from child env → pass --pane).
      const res = h.cli(B, ['node', 'recycle', '--node', B, '--pane', pane!]);
      assert.equal(res.code, 0, `recycle exit 0\n${res.stderr}`);
      // The leaf renders plain markdown: a lead sentence + `- finalized:` / `- new root:` bullets.
      assert.match(res.stdout, /^Recycled the pane /, `recycle recycled the pane\n${res.stdout}`);
      const newRoot = /- new root: (\S+)/.exec(res.stdout)?.[1];
      const finalized = /- finalized: true/.test(res.stdout);

      // The recycled node is FINISHED, not mode-flipped.
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'done', 'recycled node → done (finished), NOT re-roled');
        assert.equal(b.intent, 'done', 'intent=done (finalize), per the push-final path');
        assert.equal(b.mode, 'orchestrator', 'recycled node KEEPS mode=orchestrator — recycle is NOT a mode flip');
        assert.ok(finalized, 'recycle pushed a final for the node');
      }

      // The fresh root is a DIFFERENT, BASE×RESIDENT node.
      assert.ok(typeof newRoot === 'string' && newRoot !== B, 'a fresh root (≠ B) was minted');
      {
        const fresh = h.node(newRoot!)!;
        assert.deepEqual(persona(fresh), { mode: 'base', lifecycle: 'resident' }, 'recycled root is born base×resident (general)');
        assert.deepEqual(fresh.persona_ack, { mode: 'base', lifecycle: 'resident' }, 'fresh root born acked base×resident');
      }
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);

// ===========================================================================
// (b) A4 BOUNDARY — promote-then-yield emits a steer that is discarded. The
//     oracle/flagship boundary: the base→orchestrator guidance lands as a STEER
//     only if a turn_end fires while the drift is pending. A `node yield` on a
//     base node auto-promotes (mode→orchestrator, ack NOT committed) and its
//     agent_end goes STRAIGHT to reviveInPlace (b') with NO preceding turn_end —
//     so the only steer-delivery site (turn_end) is BYPASSED. Two deterministic
//     facts pin the boundary, both confirmed by direct observation:
//       (1) NO orchestration STEER is ever delivered (the LOSS).
//       (2) The ack is silently advanced base→orchestrator at the refresh DRAIN
//           (reviveInPlace→drainBearings→commitPersonaAck), NOT via a steer — so
//           neither this turn nor (per A4) the fresh revive re-offers it as a
//           steer; the guidance survives only in the kickoff PROMPT it built.
//     ⚑ FLAGGED (not fixed): the in-place refresh of this LARGE pending-drift
//        kickoff prompt did NOT complete a fresh fake-pi boot in the harness (it
//        stayed at 1 boot, intent=refresh, ack=orchestrator, pane alive) — a
//        base→orchestrator yield's giant <persona-transition> kickoff pushed
//        through respawn-pane did not bring up the fresh vehicle. Whether a real
//        edge (oversized argv through respawn-pane) or a harness artifact, it is
//        out of scope to fix; this test asserts only the deterministic boundary.
// ===========================================================================
test(
  'A4: a base→orchestrator yield with no preceding turn_end loses the orchestration STEER (ack advances silently at the refresh drain)',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-live-a4' });
    try {
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      assert.deepEqual(persona(h.node(B)!), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');

      const injBefore = h.injected(B).length;

      // `crtr node yield` (base → auto-promote → intent=refresh). INTERMEDIATE
      // state, BEFORE any agent_end: mode flipped, ack NOT yet committed (the
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
          'ack STILL base — promote/yield never commits it; only an injector does',
        );
      }

      // Fire the stop: agent_end sees intent=refresh → (b') reviveInPlace, whose
      // drainBearings commits the ack synchronously BEFORE the respawn. NO
      // turn_end fires this turn, so the turn_end steer site is bypassed.
      await h.stop(B);

      // (2) The ack is silently advanced to orchestrator at the refresh DRAIN —
      // not by any steer. (waitFor: the agent_end handler runs after h.stop
      // observes the recorded event.)
      await h.waitFor(
        () => {
          const a = h.node(B)?.persona_ack;
          return a?.mode === 'orchestrator' && a?.lifecycle === 'terminal';
        },
        { timeoutMs: 20_000, label: 'persona_ack advanced at the refresh drain (not via a steer)' },
      );
      assert.deepEqual(
        h.node(B)!.persona_ack,
        { mode: 'orchestrator', lifecycle: 'terminal' },
        'ack committed base→orchestrator by drainBearings during reviveInPlace',
      );

      // (1) ⚑ LOSS site: across the whole yield→refresh, NO orchestration
      // guidance was ever delivered as a turn-boundary STEER (the only steer
      // site, turn_end, never ran). The ack moved without the agent ever being
      // steered with the new-role guidance — it survives only in the kickoff
      // prompt drainBearings built for the (here, non-booting) fresh vehicle.
      assert.equal(
        orchestrationSteers(h.injected(B).slice(injBefore)).length,
        0,
        '⚑ A4: no orchestration STEER delivered — the turn_end injector was bypassed by the yield',
      );
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
