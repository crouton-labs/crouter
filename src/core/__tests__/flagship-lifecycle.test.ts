// Run with: node --import tsx/esm --test src/core/__tests__/flagship-lifecycle.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.9 + §E). The flagship end-to-end
// lifecycle scenario, driven entirely at the MODEL layer against FABRICATED
// broker-hosted (paneless) nodes — no real tmux session, no pane chrome, and NO
// real broker boot. The full status×intent×lifecycle×mode state machine is host-
// independent: every hop is a CLI lifecycle verb (promote/yield) or a pure model
// op (fabricate + subscribe + transition + pushFinal + superviseTick), so the
// scenario never pays the ~5s SDK-boot cost.
//
// THREE-PART LOCK HEADER ──────────────────────────────────────────────────
// (1) BUG LOCKED — the full lifecycle state machine (state-model §2): each hop
//     (spawn → terminal idle-release dormancy → one-hop wake → promote → yield-
//     refresh → finish) must land in the correct durable (status,intent,
//     lifecycle,mode) and route completion ONE HOP up the spine (a push fans to
//     DIRECT subscribers only; an indirect ancestor hears nothing until a middle
//     node re-pushes).
// (2) WHY MODEL-LEVEL, NOT PANE/WINDOW — every transition lives in canvas.db +
//     the lifecycle table (transition()) + the daemon's second-pass wake gate +
//     the feed fan-out. A tmux node showed dormancy as a closed pane; a broker
//     shows it as an EXITED process (status=idle, intent=idle-release, pi_pid
//     dead) — fabricated directly. The only thing a pane ever added was a visible
//     dormancy signal, which a broker expresses as a dead pid. No pane is read.
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE FIX REGRESSES — the one-hop wake
//     is asserted via getNode(B).cycles (reviveNode bumps cycles +
//     transition('revive') BEFORE the detached, unawaited broker spawn — revive.
//     ts:114,145 — so the wake is observable INSTANTLY). If the daemon's second-
//     pass reviveNode is removed, the post-inbox tick never bumps cycles → S7's
//     "B revived" asserts go RED. If a push wrongly fanned past its direct
//     subscriber, the "A inbox empty" one-hop asserts go RED.
//
// STOPHOOK CAVEAT — split (option b). The original leaned on the REAL stophook
// committing idle-release / the stall reprompt / the persona steer INSIDE a live
// broker at agent_end/turn_end. Fabrication can set the post-stop row but cannot
// run that hook. So for each such point this test fabricates the post-stop MODEL
// state (or asserts the PURE decision the hook enacts — evaluateStop /
// personaDrift) and asserts the downstream lifecycle/daemon CONSEQUENCE, leaving
// the hook-commit proof to the already-pure siblings:
//   • idle-release commit at agent_end → canvas-stophook-agentend.test.ts
//     ('natural stop while awaiting a live worker → idle-release …').
//   • stall reprompt at agent_end     → canvas-stophook-agentend.test.ts
//     ('stalled leaf … is still reprompted').
//   • persona-drift steer + ack commit at turn_end → persona.test.ts
//     ('personaDrift detects base→orchestrator after promote, then clears on
//     commit'). Here we assert only the PENDING drift the injector would deliver.
//
// 2×2 coverage (mode {base,orchestrator} × lifecycle {terminal,resident}):
//   • base×resident         — A's fabricated row shape at S1 (a spawnRoot
//                             fixture; the real resident-birth boot path is
//                             structurally unreachable headlessly).
//   • orchestrator×resident — A after promote (top-level orchestrator).
//   • base×terminal         — B/C/D workers (fabricated managed children).
//   • orchestrator×terminal — B after promote (sub-orchestrator).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { transition } from '../runtime/lifecycle.js';
import { pushFinal } from '../feed/feed.js';
import { evaluateStop, STALL_REPROMPT } from '../runtime/stop-guard.js';
import { personaDrift, commitPersonaAck } from '../runtime/persona.js';

// A pid reaped (dead) by the time spawnSync returns — a released broker's exited
// process (the headless analog of a closed pane).
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

test(
  'flagship: full node lifecycle — spawn, dormancy, one-hop wake, promote, yield, finish (headless)',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-flagship' });
    try {
      // ===================================================================
      // S1 — A's ROW SHAPE: base × RESIDENT (the user's front door). A spawnRoot
      //   fixture pins the PERSISTED row shape the scenario builds on; the real
      //   resident-birth boot path (bootRoot execs pi inline) is unreachable
      //   headlessly, exactly as in the tmux flagship. The resident BEHAVIOR (no
      //   idle-release) is exercised in live-mutation.test.ts.
      // ===================================================================
      const A = h.spawnRoot('top-level orchestrator');
      {
        const a = h.node(A)!;
        assert.equal(a.mode, 'base', 'A row shape: base');
        assert.equal(a.lifecycle, 'resident', 'A row shape: resident (fixture, not a real boot)');
        assert.equal(a.status, 'active', 'A active');
        assert.equal(a.intent ?? null, null, 'A no intent');
      }

      // ===================================================================
      // S2 — A promotes: orchestrator × RESIDENT (top-level orchestrator). The
      //      real `node promote` verb; mode flips, lifecycle/status/intent
      //      untouched (no transition()).
      // ===================================================================
      {
        const res = h.cli(A, ['node', 'promote']);
        assert.equal(res.code, 0, `promote A exit 0\n${res.stderr}`);
        const a = h.node(A)!;
        assert.equal(a.mode, 'orchestrator', 'A → orchestrator');
        assert.equal(a.lifecycle, 'resident', 'A stays resident (no --resident)');
        assert.equal(a.status, 'active', 'A still active (promote does not transition)');
        assert.equal(a.intent ?? null, null, 'A intent untouched by promote');
      }

      // ===================================================================
      // S3 — A spawns terminal child B: base × TERMINAL. Fabricated as a broker-
      //      hosted node (pi_pid dead + pi_session_id set, so its later dormant
      //      wake RESUMES that session); the spine seed is wired explicitly
      //      (fabrication does not auto-subscribe). B is born acked to its own
      //      persona (commitPersonaAck), mirroring a real birth.
      // ===================================================================
      const B = h.fabricateBrokerNode({
        parent: A, kind: 'developer', mode: 'base', lifecycle: 'terminal',
        status: 'active', pi_pid: deadPid(), pi_session_id: 'sess-B',
      });
      subscribe(A, B, true); // the load-bearing spine seed: A subscribes_to B (active).
      commitPersonaAck(B, { mode: 'base', lifecycle: 'terminal' }); // born acked to its persona
      {
        const b = h.node(B)!;
        assert.equal(b.host_kind, 'broker', 'B broker-hosted (paneless)');
        assert.equal(b.mode, 'base', 'B born base');
        assert.equal(b.lifecycle, 'terminal', 'B born terminal (managed child)');
        assert.equal(b.status, 'active', 'B active');
        assert.equal(b.intent ?? null, null, 'B no intent');
        assert.equal(b.parent, A, 'B spawned_by / parent = A');
        assert.deepEqual(
          h.subscribers(B),
          [{ node_id: A, active: true }],
          "A is B's sole ACTIVE subscriber (spine seed)",
        );
        assert.equal(h.inbox(A).length, 0, 'A inbox empty (spawn pushes nothing)');
      }

      // ===================================================================
      // S4 — B spawns child C (base × terminal). B now holds an active live
      //      subscription to C → B is legitimately "awaiting" if it stops.
      // ===================================================================
      const C = h.fabricateBrokerNode({ parent: B, mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(B, C, true);
      {
        const c = h.node(C)!;
        assert.equal(c.mode, 'base', 'C base');
        assert.equal(c.lifecycle, 'terminal', 'C terminal');
        assert.equal(c.status, 'active', 'C active');
        assert.deepEqual(h.subscribers(C), [{ node_id: B, active: true }], "B is C's sole ACTIVE subscriber");
        assert.deepEqual(h.subscriptions(B), [{ node_id: C, active: true }], 'B subscribes_to C (active)');
        assert.equal(h.status(B), 'active', 'B still active');
      }

      // ===================================================================
      // S5 — B goes DORMANT. PURE precondition: B is TERMINAL holding an active
      //      live sub to C, so the stop-guard classifies its stop 'awaiting'
      //      (legitimate idle-release). We then enact the post-stop MODEL state
      //      directly: transition('release') → idle / idle-release (a released
      //      broker is a dead pid; pi_pid was fabricated dead at S3). The actual
      //      agent_end idle-release COMMIT is locked by canvas-stophook-agentend
      //      ('natural stop while awaiting a live worker → idle-release …').
      // ===================================================================
      {
        const stop = evaluateStop(B, { pushedFinal: false, askedHuman: false });
        assert.equal(stop.action, 'allow', 'awaiting terminal B → allow (legit idle-release)');
        assert.equal(stop.reason, 'awaiting', "B classified awaiting on its ACTIVE live sub to C");
      }
      transition(B, 'release');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'idle', 'B idle (released)');
        assert.equal(b.intent, 'idle-release', 'B intent=idle-release');
      }
      assert.equal(h.status(C), 'active', 'C still active while B sleeps');
      assert.equal(h.status(A), 'active', 'A still active (a dormant worker does not disturb its manager)');
      assert.equal(h.inbox(A).length, 0, 'A inbox still empty');

      // ===================================================================
      // S6 — C FINISHES (pushFinal). The pointer fans to subscribersOf(C) = {B}
      //      ONLY. C → done/done. A is NOT a subscriber of C → A inbox stays
      //      empty — the one-hop wake contract at the push site.
      // ===================================================================
      await pushFinal(C, 'C result body');
      {
        const c = h.node(C)!;
        assert.equal(c.status, 'done', 'C done');
        assert.equal(c.intent, 'done', 'C intent=done');
        const cFinal = h.inbox(B).find((e) => e.from === C && e.kind === 'final');
        assert.ok(cFinal, "B inbox received C's final pointer (one hop)");
        assert.equal(h.inbox(A).length, 0, 'A inbox empty — A NOT woken by C (one-hop)');
      }

      // ===================================================================
      // S7 — WAKE B. The in-process daemon second pass sees B idle/idle-release,
      //      pi dead, an unseen inbox entry → reviveNode(resume). reviveNode
      //      bumps cycles + transition('revive') BEFORE the (detached, unawaited)
      //      broker spawn, so the wake is observable INSTANTLY via cycles — no
      //      awaitBoot. (The real inbox-watcher's redelivery of C's report on the
      //      fresh boot is an engine artifact, out of the model tier; the wake
      //      DECISION is locked here by cycles + the S6 inbox entry.)
      // ===================================================================
      assert.equal(h.node(B)!.cycles ?? 0, 0, 'B not yet revived');
      await h.tick();
      {
        const b = h.node(B)!;
        assert.equal(b.cycles ?? 0, 1, 'unseen inbox + tick → daemon pass-2 REVIVED (cycles bumped to 1)');
        assert.equal(b.status, 'active', 'B revived → active');
        assert.equal(b.intent ?? null, null, 'B intent cleared by revive');
      }
      assert.equal(h.inbox(A).length, 0, 'A inbox STILL empty after B woke (one-hop confirmed)');
      assert.equal(h.status(A), 'active', 'A unchanged');

      // ===================================================================
      // S8 — B PROMOTES: base → orchestrator, lifecycle TERMINAL unchanged
      //      (no --resident). orchestrator × terminal (the sub-orchestrator).
      // ===================================================================
      {
        const res = h.cli(B, ['node', 'promote', '--kind', 'developer']);
        assert.equal(res.code, 0, `promote B exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.mode, 'orchestrator', 'B → orchestrator');
        assert.equal(b.lifecycle, 'terminal', 'B stays TERMINAL (promote is mode-only)');
        assert.equal(b.status, 'active', 'B still active');
        assert.equal(b.intent ?? null, null, 'B intent untouched by promote');
      }

      // ===================================================================
      // S9 — The next turn's hooks, asserted as the PURE decisions they enact:
      //      (a) turn_end would inject the base→orchestrator persona-drift steer —
      //          personaDrift(B) reports that PENDING drift (the guidance the
      //          injector delivers). The actual delivery + ack commit is locked
      //          by persona.test.ts.
      //      (b) agent_end would stall (orchestrator, no live sub — C done, D not
      //          yet spawned — no final) → evaluateStop → 'stalled'/STALL_REPROMPT.
      //          The actual reprompt injection is locked by canvas-stophook-agentend.
      // ===================================================================
      {
        const drift = personaDrift(B);
        assert.ok(drift !== null, 'turn_end would inject a persona-drift steer (drift pending)');
        assert.deepEqual(drift?.from, { mode: 'base', lifecycle: 'terminal' }, 'drift.from = the acked base×terminal');
        assert.deepEqual(drift?.to, { mode: 'orchestrator', lifecycle: 'terminal' }, 'drift.to = the new orchestrator persona');
        assert.match(drift?.guidance ?? '', /ORCHESTRATOR/i, 'the steer carries the base→orchestrator guidance');

        const stop = evaluateStop(B, { pushedFinal: false, askedHuman: false });
        assert.equal(stop.action, 'reprompt', 'orchestrator B with no live sub, no final → reprompt');
        assert.equal(stop.reason, 'stalled', 'classified stalled');
        assert.equal(stop.action === 'reprompt' ? stop.message : '', STALL_REPROMPT, 'the stall reprompt nudge');
      }

      // ===================================================================
      // S10 — B YIELDS. The real `node yield` verb sets intent=refresh (already
      //       orchestrator → no auto-promote); persona survives the request. We
      //       then model the daemon's completed refresh-revive with transition
      //       ('revive') (the in-place fresh boot is engine; its model effect —
      //       active, intent cleared, persona preserved — is asserted here).
      // ===================================================================
      {
        const res = h.cli(B, ['node', 'yield', 'refresh against the roadmap']);
        assert.equal(res.code, 0, `node yield exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.intent, 'refresh', 'yield set intent=refresh');
        assert.equal(b.mode, 'orchestrator', 'B mode survives the yield request');
        assert.equal(b.lifecycle, 'terminal', 'B lifecycle survives the yield request');
      }
      transition(B, 'revive'); // model the completed refresh-revive (fresh boot is engine)
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'B active after the refresh-revive');
        assert.equal(b.intent ?? null, null, 'B intent=refresh cleared by the fresh boot');
        assert.equal(b.mode, 'orchestrator', 'B mode survives the refresh');
        assert.equal(b.lifecycle, 'terminal', 'B lifecycle survives the refresh');
      }

      // ===================================================================
      // S11 — B spawns child D (base × terminal). New spine seed B→D active.
      // ===================================================================
      const D = h.fabricateBrokerNode({ parent: B, mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(B, D, true);
      {
        const d = h.node(D)!;
        assert.equal(d.mode, 'base', 'D base');
        assert.equal(d.lifecycle, 'terminal', 'D terminal');
        assert.equal(d.status, 'active', 'D active');
        assert.ok(h.subscriptions(B).some((s) => s.node_id === D && s.active), 'B subscribes_to D (active)');
      }

      // ===================================================================
      // S12 — D FINISHES → pointer to B (its only subscriber).
      // ===================================================================
      await pushFinal(D, 'D result body');
      {
        assert.equal(h.node(D)!.status, 'done', 'D done');
        const dFinal = h.inbox(B).find((e) => e.from === D && e.kind === 'final');
        assert.ok(dFinal, "B inbox received D's final pointer");
      }

      // ===================================================================
      // S13 — B pushes its FINAL up the spine → done/done; the pointer fans to
      //       subscribersOf(B) = {A}. NOW A finally hears B (its own explicit
      //       push — the only way the chain propagates a hop).
      // ===================================================================
      await pushFinal(B, 'all work complete');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'done', 'B done after push final');
        assert.equal(b.intent, 'done', 'B intent=done');
        const aInbox = h.inbox(A);
        assert.equal(aInbox.length, 1, "A inbox now has exactly B's final (one hop, on B's push)");
        assert.equal(aInbox[0]!.from, B, "A's entry is from B");
        assert.equal(aInbox[0]!.kind, 'final', "A's entry is a final");
      }

      // A — the resident top-level orchestrator — is still alive and well.
      {
        const a = h.node(A)!;
        assert.equal(a.status, 'active', 'A still active at the end');
        assert.equal(a.mode, 'orchestrator', 'A still orchestrator');
        assert.equal(a.lifecycle, 'resident', 'A still resident');
      }
    } finally {
      await h.dispose();
    }
  },
);
