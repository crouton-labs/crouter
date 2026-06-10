// Run with: node --import tsx/esm --test src/core/__tests__/live-mutation.test.ts
//
// AXIS: LIVE MUTATION of the 2×2 state vector (mode {base,orchestrator} ×
// lifecycle {terminal,resident}) while a node is ACTIVE/LIVE — driven through
// the REAL `crtr node lifecycle` / `node promote` / `node demote` / `node recycle`
// CLI verbs against a live fake-pi, with the REAL stophook / kickoff / daemon hooks doing
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
//
// Part 2 of this axis — the demote/recycle verb split and the A4 promote-then-
// yield boundary — lives in live-mutation-verbs.test.ts (split for node:test
// file-level parallelism; each test holds its own isolated harness).

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
      // MINOR-2: asserting a NON-event (B must NOT idle-release) cannot be a single
      // immediate read — h.stop() resolves once agent_end is RECORDED, BEFORE the
      // handler completes, so a regression where the resident 'dormant' branch
      // wrongly ran transition('release') + ctx.shutdown() asynchronously would
      // still observe the pre-release state and false-pass. Instead POLL-STABLE:
      // sample repeatedly across a real settle (a daemon tick partway, so the
      // handler + a full superviseTick have both run) and assert the invariant
      // holds on EVERY sample. A regression that idle-releases within the window
      // is caught the moment it flips.
      {
        const deadline = Date.now() + 2_000;
        let ticked = false;
        for (;;) {
          const b = h.node(B)!;
          assert.equal(b.status, 'active', 'resident B stays ACTIVE on stop (dormant, not released)');
          assert.equal(b.intent ?? null, null, 'resident B has NO idle-release intent');
          assert.equal(h.paneAlive(B), true, 'resident B keeps its live pi/pane (no shutdown)');
          assert.equal(h.status(C), 'active', 'C untouched while B is dormant-resident');
          // Drive a real daemon decision pass midway: a superviseTick sees B
          // active + pane-alive + pid-alive → handleLiveWindow 'leave'. If the
          // daemon wrongly released a resident node, the next sample catches it.
          if (!ticked) {
            await h.tick();
            ticked = true;
          }
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
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

