// Run with: node --import tsx/esm --test src/core/__tests__/live-mutation.test.ts
//
// AXIS: LIVE MUTATION of the 2×2 state vector (mode {base,orchestrator} ×
// lifecycle {terminal,resident}) while a node is ACTIVE/LIVE — driven through
// the REAL `crtr node lifecycle` / `node promote` / `node demote` CLI verbs
// against a live fake-pi, with the REAL stophook / kickoff / daemon hooks doing
// the work. Every assertion reads the canvas data layer and is checked against
// the state-model ORACLE (mq1su40t .../state-model.md).
//
// This file is ADDITIVE and uses ONLY the public Harness API + a couple of pure
// test-local helpers (noted below). It does not edit harness.ts / fake-pi-host.ts
// or any production file.
//
// Coverage rationale (grep of src/core/__tests__/ before writing):
//   • persona.test.ts        — UNIT-level personaDrift/transitionGuidance (pure
//                              functions; no live pi, no turn_end firing).
//   • stop-guard.test.ts      — UNIT-level evaluateStop (no live flip via CLI).
//   • daemon-liveness.test.ts — superviseTick over BORN-terminal idle-release
//                              rows (never a live lifecycle FLIP).
//   • flagship-lifecycle      — B born terminal idle-releases; A born resident
//                              stays live; promote+turn fires the steer ONCE.
// GENUINELY MISSING (this file): the LIVE FLIP itself — flipping a running
// node's lifecycle/mode through the real verb and proving the runtime behavior
// (idle-release vs dormant; persona-ack recompose; the A4 boundary) changes
// accordingly. None of the above drives `crtr node lifecycle` on a live node,
// nor asserts persona_ack mutation across a live promote, nor the A4 loss site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness, type Injected } from './helpers/harness.js';
import type { NodeMeta } from '../canvas/types.js';

const SKIP = !hasTmux() ? 'tmux unavailable' : false;

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

// --- pure test-local helpers (candidates to fold into harness.ts later) -----
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
// (a) LIFECYCLE FLIP — `crtr node lifecycle` on a LIVE node, both directions,
//     observing the idle-release behavior change. A round-trip on ONE live
//     node (terminal→resident→terminal) proves both directions faithfully:
//     a flipped-resident node no longer idle-releases (stays live, daemon does
//     NOT release it); flipped-terminal it idle-releases again on pi-death.
// ===========================================================================
test(
  'live lifecycle flip: terminal→resident suppresses idle-release; resident→terminal restores it',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-live-life' });
    try {
      // A (resident root, data-layer) ─ B (base/terminal, live) ─ C (base/terminal, live).
      // B holds an ACTIVE live subscription to C → a TERMINAL B that stops is
      // legitimately 'awaiting' (stop-guard) and would idle-release. That live
      // sub is the precondition that makes the resident-vs-terminal flip the
      // ONLY variable.
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      const C = await h.spawnChild(B, 'a subtask');
      {
        const b = h.node(B)!;
        assert.deepEqual(persona(b), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');
        assert.equal(b.status, 'active', 'B active');
        assert.equal(b.intent ?? null, null, 'B no intent');
        assert.equal(h.status(C), 'active', 'C active — B holds a live sub to it');
        assert.ok(
          h.subscriptions(B).some((s) => s.node_id === C && s.active),
          'B subscribes_to C (active) — the awaiting precondition',
        );
      }

      // --- FLIP 1: terminal → RESIDENT (live). Oracle §4: sets lifecycle + the
      // launch spec, status/intent UNTOUCHED. ---
      {
        const res = h.cli(B, ['node', 'lifecycle', 'resident', '--node', B]);
        assert.equal(res.code, 0, `lifecycle resident exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'resident', 'B → resident');
        assert.equal(b.mode, 'base', 'mode UNCHANGED by a lifecycle flip (orthogonal axis)');
        assert.equal(b.status, 'active', 'status UNTOUCHED by node lifecycle (oracle §4)');
        assert.equal(b.intent ?? null, null, 'intent UNTOUCHED by node lifecycle (oracle §4)');
      }

      // B stops AS RESIDENT: agent_end runs the stop-guard, which keys on
      // lifecycle==='resident' → 'dormant' → the handler does NOT shut pi down
      // (oracle §3a). So B stays active, pi alive, pane held — it does NOT
      // idle-release despite holding the same live sub that would release a
      // terminal node.
      await h.stop(B);
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'resident B stays ACTIVE on stop (dormant, not released)');
        assert.equal(b.intent ?? null, null, 'resident B has NO idle-release intent');
        assert.equal(h.paneAlive(B), true, 'resident B keeps its live pi/pane (no shutdown)');
      }

      // The daemon must NOT release a live resident node either — a superviseTick
      // sees B active + pane-alive + pid-alive → handleLiveWindow 'leave'.
      await h.tick();
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'daemon leaves the live resident node active');
        assert.equal(b.intent ?? null, null, 'daemon does NOT idle-release a resident node');
        assert.equal(h.paneAlive(B), true, 'pi/pane still alive after a tick');
        assert.equal(h.status(C), 'active', 'C untouched');
      }

      // --- FLIP 2: resident → TERMINAL (live), on the now-resident live node. ---
      {
        const res = h.cli(B, ['node', 'lifecycle', 'terminal', '--node', B]);
        assert.equal(res.code, 0, `lifecycle terminal exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'terminal', 'B → terminal');
        assert.equal(b.status, 'active', 'status still UNTOUCHED by the flip');
        assert.equal(b.intent ?? null, null, 'intent still UNTOUCHED by the flip');
      }

      // B stops AS TERMINAL now: stop-guard sees terminal + an active live sub to
      // C → 'awaiting' → transition('release') + ctx.shutdown(). idle/idle-release;
      // pi dies; UNFOCUSED backstage pane closes (oracle §3b). The exact behavior
      // the resident flip had suppressed.
      await h.stop(B);
      await h.waitForStatus(B, 'idle');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'idle', 'terminal B idle-releases on stop');
        assert.equal(b.intent, 'idle-release', 'intent=idle-release (transition release)');
      }
      await h.waitForPaneGone(B);
      assert.equal(h.paneAlive(B), false, 'unfocused terminal B → pane closed on idle-release');
      assert.equal(h.status(C), 'active', 'C still active while B sleeps');
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);

// ===========================================================================
// (b) MODE FLIP — promote: base → orchestrator on a LIVE node. The flip itself
//     does NOT commit the persona ack; the turn_end injector recomposes (commits
//     the ack + delivers the steer) on the next turn, and a second turn is a
//     no-op (drift cleared). Flagship asserts the steer fires once; the NEW
//     assertions here are the persona_ack MUTATION across the live flip and the
//     idempotence — neither is covered elsewhere.
// ===========================================================================
test(
  'live mode flip: promote base→orchestrator recomposes persona_ack at turn_end (and is idempotent)',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-live-mode' });
    try {
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      {
        const b = h.node(B)!;
        assert.deepEqual(persona(b), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');
        // Invariant 11: born acked to its own persona → no spurious drift turn 1.
        assert.deepEqual(
          b.persona_ack,
          { mode: 'base', lifecycle: 'terminal' },
          'persona_ack born equal to the initial persona (invariant 11)',
        );
      }

      // PROMOTE (live): mode→orchestrator, lifecycle UNCHANGED, status/intent
      // untouched (no transition). Crucially promote does NOT commit the ack —
      // the drift is left PENDING for the injector.
      {
        const res = h.cli(B, ['node', 'promote', '--kind', 'developer']);
        assert.equal(res.code, 0, `promote exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.mode, 'orchestrator', 'B → orchestrator');
        assert.equal(b.lifecycle, 'terminal', 'lifecycle UNCHANGED (promote is mode-only)');
        assert.equal(b.status, 'active', 'status untouched by promote');
        assert.equal(b.intent ?? null, null, 'intent untouched by promote');
        assert.deepEqual(
          b.persona_ack,
          { mode: 'base', lifecycle: 'terminal' },
          'promote does NOT commit the ack — drift left PENDING for the injector',
        );
      }

      // A TURN fires turn_end: personaDrift base→orchestrator → inject the
      // orchestration guidance as a STEER, then commitPersonaAck. agent_end then
      // stalls (orchestrator, no live sub, no final) → reprompt → B stays alive.
      const injBefore = h.injected(B).length;
      await h.turn(B, 'orchestrating');
      const fresh = await h.waitFor(
        () => {
          const slice = h.injected(B).slice(injBefore);
          return orchestrationSteers(slice).length > 0 ? slice : null;
        },
        { timeoutMs: 15_000, label: 'base→orchestrator steer at turn_end' },
      );
      assert.ok(orchestrationSteers(fresh).length >= 1, 'turn_end delivered the orchestration guidance as a steer');
      {
        const b = h.node(B)!;
        assert.deepEqual(
          b.persona_ack,
          { mode: 'orchestrator', lifecycle: 'terminal' },
          'persona RECOMPOSE committed: persona_ack advanced to the new persona at turn_end',
        );
        assert.equal(b.status, 'active', 'B not stranded — reprompt keeps it alive');
      }

      // IDEMPOTENCE: a SECOND turn finds no drift (ack already committed) → NO
      // new persona steer is injected.
      const injBeforeSecond = h.injected(B).length;
      await h.turn(B, 'orchestrating again');
      const afterSecond = h.injected(B).slice(injBeforeSecond);
      assert.equal(
        orchestrationSteers(afterSecond).length,
        0,
        'no fresh orchestration steer on the second turn — drift cleared (idempotent recompose)',
      );
      assert.equal(h.node(B)!.mode, 'orchestrator', 'B still orchestrator');
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);

// ===========================================================================
// (b) MODE FLIP — demote. ⚑ FLAG vs the task framing ("demote orchestrator back
//     to base; assert the mode field changes"): the `node demote` verb does NOT
//     flip the SAME live node's mode orchestrator→base. Per ORACLE §4 (which
//     matches the code: demote.ts) it FINISHES the node (push final → done) and
//     RECYCLES the pane into a FRESH general/base/resident root — a DIFFERENT
//     node. The demoted node keeps mode=orchestrator (it is merely `done`).
//     There is NO live verb that flips a node orchestrator→base, so the
//     persona.ts `baseModeGuidance` (orchestrator→base) is effectively
//     UNREACHABLE via live mutation. This test pins the real behavior so the
//     contradiction is visible; production is NOT changed.
// ===========================================================================
test(
  'node demote is FINISH+RECYCLE, not an orchestrator→base mode flip (current behavior vs task framing)',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-live-demote' });
    try {
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      // Promote B so it is genuinely an orchestrator before we demote it.
      assert.equal(h.cli(B, ['node', 'promote', '--kind', 'developer']).code, 0, 'promote B');
      const b0 = h.node(B)!;
      assert.equal(b0.mode, 'orchestrator', 'B is orchestrator before demote');
      // Resolve B's live %pane_id from its window (the row's `pane` is null until
      // a reconcile; the spawn path records only window+session).
      const pane = firstPaneOf(b0.window!);
      assert.ok(typeof pane === 'string' && pane !== '', 'B has a live pane to recycle');

      // DEMOTE via the real verb (TMUX_PANE is scrubbed from child env → pass --pane).
      const res = h.cli(B, ['node', 'demote', '--node', B, '--pane', pane!]);
      assert.equal(res.code, 0, `demote exit 0\n${res.stderr}`);
      // The leaf renders `<demoted ... finalized=".." new_root=".."/>` (not JSON).
      assert.match(res.stdout, /<demoted /, `demote recycled the pane\n${res.stdout}`);
      const newRoot = /new_root="([^"]+)"/.exec(res.stdout)?.[1];
      const finalized = /finalized="true"/.test(res.stdout);

      // ⚑ The demoted node is FINISHED, not mode-flipped.
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'done', 'demoted node → done (finished), NOT re-roled');
        assert.equal(b.intent, 'done', 'intent=done (finalize), per the push-final path');
        assert.equal(
          b.mode,
          'orchestrator',
          '⚑ demoted node KEEPS mode=orchestrator — demote is NOT an orchestrator→base flip',
        );
        assert.ok(finalized, 'demote pushed a final for the node');
      }

      // The fresh root is a DIFFERENT, BASE×RESIDENT node — that is where "base"
      // comes from, not a mutation of B.
      assert.ok(typeof newRoot === 'string' && newRoot !== B, 'a fresh root (≠ B) was minted');
      {
        const fresh = h.node(newRoot!)!;
        assert.deepEqual(
          persona(fresh),
          { mode: 'base', lifecycle: 'resident' },
          'recycled root is born base×resident (general)',
        );
        // Born acked to its own persona → it will never see an orchestrator→base
        // drift steer: that persona path is unreachable through live mutation.
        assert.deepEqual(
          fresh.persona_ack,
          { mode: 'base', lifecycle: 'resident' },
          'fresh root born acked base×resident — no orchestrator→base drift will ever fire',
        );
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
