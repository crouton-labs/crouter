// Run with: node --import tsx/esm --test src/core/__tests__/flagship-lifecycle.test.ts
//
// FLAGSHIP end-to-end lifecycle test — the faithful integration harness driving
// a full node-graph scenario through the REAL CLI, a REAL isolated tmux session,
// the REAL extension hooks (fired inside the fake-pi vehicle), and the REAL
// daemon decision pass (superviseTick, in-process). Every assertion reads the
// canvas data layer and is checked against the state-model ORACLE.
//
// Scenario (each hop asserted):
//   A (base→orchestrator, RESIDENT root) spawns terminal child B.
//   B spawns child C, then goes DORMANT (terminal idle-release, unfocused→pane closes).
//   C finishes → ONE-HOP wakes B (A is NOT woken — the oracle's wake contract).
//   B PROMOTES to orchestrator (terminal), takes a turn (persona drift), then
//   YIELDS and revives in place (refresh-yield).
//   B spawns child D; D finishes; B pushes its final up to A.
//
// 2×2 coverage (mode {base,orchestrator} × lifecycle {terminal,resident}):
//   • base×resident       — A's PERSISTED ROW SHAPE at S1 (a harness-set fixture,
//                           NOT a real bootRoot — see S1 + MINOR-1 caveat below).
//                           The resident BEHAVIOR (does not idle-release) is
//                           exercised faithfully in live-mutation.test.ts.
//   • orchestrator×resident — A after promote (top-level orchestrator)
//   • base×terminal       — B/C/D workers (GENUINE managed-child birth at S3)
//   • orchestrator×terminal — B after promote (sub-orchestrator)
//
// ── Known coverage boundaries (DELIBERATE, documented gaps) ────────────────
// This flagship + the live-mutation/cascade/subscription siblings cover the
// HAPPY-PATH lifecycle and the live-mutation axis faithfully. The following
// fault/grace/focus paths are OUT OF SCOPE for the faithful tier in this pass
// (some are backstopped at the in-process unit tier, cited):
//   • crash → dead (a vehicle that boots then its pane vanishes mid-run) — unit:
//     daemon-liveness.test.ts "pane GONE … crash → dead".
//   • boot-failure push (a vehicle that never boots → surfaceBootFailure urgent
//     push up the spine) — no faithful coverage here.
//   • focused-FREEZE (F3: a focused-dormant node frozen via remain-on-exit,
//     pane-alive but pi-dead) — unit: daemon-liveness.test.ts "idle-release +
//     live (frozen) pane …"; the grace-window double-spawn guard around it is
//     exercised faithfully in grace-clock.test.ts.
//   • node lifecycle --detach (A3: orphaned-focus-row hazard) — faithful E2E:
//     detach-focus.test.ts (the real verb on a FOCUSED live node → terminal +
//     pane relocated to the backstage + focus row CLOSED).
//   • focused-finish → manager-TAKEOVER (handFocusToManager swap) — NOT harness-
//     reachable: the harness root is a paneless never-booted row, so the done-
//     branch only ever hits the paneless-manager false guard (closeFocusToShell),
//     never a live/dormant-idle-release takeover. Unit: placement-teardown.test.ts.
//   • node msg / focus / cycle wake of a dormant node (A7) — untested faithfully.
// These are intentional boundaries, not oversights.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { STALL_REPROMPT } from '../runtime/stop-guard.js';

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

test(
  'flagship: full node lifecycle — spawn, dormancy, one-hop wake, promote, yield, finish',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 180_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-flagship' });
    try {
      // ===================================================================
      // S1 — A's PERSISTED ROW SHAPE: base × RESIDENT (the user's front door).
      //   ⚠ MINOR-1 caveat: this is NOT a real root birth. The harness mints A
      //   via in-process createNode over a hand-built meta whose defaults ARE
      //   mode:'base'/lifecycle:'resident' — the REAL birth/boot path (bootRoot)
      //   execs pi inline and never returns, so it is structurally unreachable
      //   from the harness (harness-design Wall #7). These four asserts therefore
      //   PIN THE PERSISTED ROW SHAPE the rest of the scenario builds on — they
      //   do NOT prove the real resident-birth path. The resident-at-birth 2×2
      //   quadrant is out of reach; the resident *behavior* (no idle-release) is
      //   exercised faithfully in live-mutation.test.ts, and the genuine real
      //   birth of a managed child (→ terminal) IS exercised at S3 below.
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
      // S2 — A promotes: orchestrator × RESIDENT (top-level orchestrator).
      //      mode flips; lifecycle/status/intent untouched (no transition()).
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
      // S3 — A spawns terminal child B: base × TERMINAL. The spawn seed wires
      //      the spine — A auto-subscribes ACTIVE to B, B spawned_by A.
      // ===================================================================
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      {
        const b = h.node(B)!;
        assert.equal(b.mode, 'base', 'B born base');
        assert.equal(b.lifecycle, 'terminal', 'B born terminal (managed child)');
        assert.equal(b.status, 'active', 'B active after boot');
        assert.equal(b.intent ?? null, null, 'B no intent');
        assert.equal(b.parent, A, 'B spawned_by / parent = A');
        // The load-bearing spine seed: A subscribes_to B (active).
        const subsToB = h.subscribers(B);
        assert.deepEqual(
          subsToB,
          [{ node_id: A, active: true }],
          'A is B\'s sole ACTIVE subscriber (spawn seed)',
        );
        assert.equal(h.inbox(A).length, 0, 'A inbox empty (spawn pushes nothing)');
      }

      // ===================================================================
      // S4 — B spawns child C (base × terminal). B now holds an active live
      //      subscription to C → B is legitimately "awaiting" if it stops.
      // ===================================================================
      const C = await h.spawnChild(B, 'a subtask');
      {
        const c = h.node(C)!;
        assert.equal(c.mode, 'base', 'C base');
        assert.equal(c.lifecycle, 'terminal', 'C terminal');
        assert.equal(c.status, 'active', 'C active');
        assert.deepEqual(
          h.subscribers(C),
          [{ node_id: B, active: true }],
          'B is C\'s sole ACTIVE subscriber (spawn seed)',
        );
        assert.deepEqual(
          h.subscriptions(B),
          [{ node_id: C, active: true }],
          'B subscribes_to C (active)',
        );
        assert.equal(h.status(B), 'active', 'B still active');
      }

      // ===================================================================
      // S5 — B goes DORMANT. It stops while awaiting C → terminal idle-release:
      //      transition('release') → idle / idle-release; ctx.shutdown kills pi;
      //      UNFOCUSED → the backstage pane CLOSES (fully dormant).
      // ===================================================================
      await h.stop(B);
      await h.waitForStatus(B, 'idle');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'idle', 'B idle (released)');
        assert.equal(b.intent, 'idle-release', 'B intent=idle-release');
      }
      await h.waitForPaneGone(B);
      assert.equal(h.paneAlive(B), false, 'B unfocused → pane closed on idle-release');
      assert.equal(h.status(C), 'active', 'C still active while B sleeps');
      // A untouched — a dormant terminal worker does not disturb its manager.
      assert.equal(h.status(A), 'active', 'A still active');
      assert.equal(h.inbox(A).length, 0, 'A inbox still empty');

      // ===================================================================
      // S6 — C FINISHES (push final). Pointer fans to subscribersOf(C) = {B}
      //      ONLY. C → done/done. A is NOT a subscriber of C → A inbox stays
      //      empty. This is the one-hop wake contract at the push site.
      // ===================================================================
      await h.finish(C, 'C result body');
      {
        const c = h.node(C)!;
        assert.equal(c.status, 'done', 'C done');
        assert.equal(c.intent, 'done', 'C intent=done');
        assert.equal(h.paneAlive(C), false, 'C pane closed on done');
        const bInbox = h.inbox(B);
        const cFinal = bInbox.find((e) => e.from === C && e.kind === 'final');
        assert.ok(cFinal, 'B inbox received C\'s final pointer (one hop)');
        // ORACLE: ONE-HOP. A is not woken — only B (the direct subscriber) hears C.
        assert.equal(h.inbox(A).length, 0, 'A inbox empty — A NOT woken by C (one-hop)');
      }

      // ===================================================================
      // S7 — WAKE B. The in-process daemon second pass sees B idle/idle-release,
      //      pi dead, an unseen inbox entry → reviveNode(resume). B → active,
      //      intent cleared (revive). Its FRESH watcher delivers C's report.
      // ===================================================================
      const injBeforeWake = h.injected(B).length;
      await h.tick(); // one superviseTick: 1st pass nulls the stale window, 2nd revives on inbox
      await h.waitForStatus(B, 'active');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'B revived → active');
        assert.equal(b.intent ?? null, null, 'B intent cleared by revive');
      }
      await h.awaitBoot(B, { minCount: 2 }); // the resume boot (spawn boot + wake boot)
      const wakeDigests = await h.awaitWake(B, { sinceCount: injBeforeWake, match: /C result body/ });
      assert.ok(
        wakeDigests.some((d) => /C result body/.test(d)),
        'B\'s real inbox-watcher delivered C\'s report after the wake',
      );
      // Still one-hop: A remained dormant-as-resident and was never touched.
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
      // S9 — B takes a TURN. turn_end detects the base→orchestrator persona
      //      drift and injects the orchestration guidance as a 'steer', then
      //      commits the ack. agent_end then stalls (no live sub, no final) →
      //      STALL_REPROMPT (followUp). Both are real stophook branches.
      // ===================================================================
      const injBeforeTurn = h.injected(B).length;
      await h.turn(B, 'orchestrating');
      const turnInjected = await h.waitFor(
        () => {
          const fresh = h.injected(B).slice(injBeforeTurn);
          // MINOR-3: match the steer by CONTENT (/ORCHESTRATOR/i), not deliverAs
          // alone — mirroring live-mutation.test.ts's orchestrationSteers() — so
          // this pins the orchestration guidance specifically, not "some steer."
          const steer = fresh.find((e) => e.deliverAs === 'steer' && /ORCHESTRATOR/i.test(e.content));
          const reprompt = fresh.find((e) => e.content.includes(STALL_REPROMPT));
          return steer && reprompt ? fresh : null;
        },
        { timeoutMs: 15_000, label: 'B turn injected persona-drift steer + stall reprompt' },
      );
      assert.ok(
        turnInjected.some((e) => e.deliverAs === 'steer' && /ORCHESTRATOR/i.test(e.content)),
        'turn_end injected the base→orchestrator persona-drift guidance (steer with ORCHESTRATOR content)',
      );
      assert.ok(
        turnInjected.some((e) => e.content.includes(STALL_REPROMPT)),
        'agent_end stalled (orchestrator, no live sub, no final) → STALL_REPROMPT',
      );
      assert.equal(h.status(B), 'active', 'B still active after the turn (reprompt keeps it alive)');

      // ===================================================================
      // S10 — B YIELDS + revives. node yield → intent=refresh (active kept);
      //       agent_end (b') runs reviveInPlace (respawn-pane -k) IN the fake-pi
      //       pane; the fresh pi's session_start clears refresh → active. mode
      //       and lifecycle survive the refresh.
      // ===================================================================
      await h.yieldNode(B, 'refresh against the roadmap');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'B active after refresh-yield');
        assert.equal(b.intent ?? null, null, 'B intent=refresh cleared by the fresh boot');
        assert.equal(b.mode, 'orchestrator', 'B mode survives the refresh');
        assert.equal(b.lifecycle, 'terminal', 'B lifecycle survives the refresh');
      }

      // ===================================================================
      // S11 — B spawns child D (base × terminal). New spine seed B→D active.
      // ===================================================================
      const D = await h.spawnChild(B, 'a second subtask');
      {
        const d = h.node(D)!;
        assert.equal(d.mode, 'base', 'D base');
        assert.equal(d.lifecycle, 'terminal', 'D terminal');
        assert.equal(d.status, 'active', 'D active');
        assert.ok(
          h.subscriptions(B).some((s) => s.node_id === D && s.active),
          'B subscribes_to D (active)',
        );
      }

      // ===================================================================
      // S12 — D FINISHES → pointer to B (its only subscriber).
      // ===================================================================
      await h.finish(D, 'D result body');
      {
        assert.equal(h.node(D)!.status, 'done', 'D done');
        const dFinal = h.inbox(B).find((e) => e.from === D && e.kind === 'final');
        assert.ok(dFinal, 'B inbox received D\'s final pointer');
      }

      // ===================================================================
      // S13 — B pushes its FINAL up the spine → done/done; the pointer fans to
      //       subscribersOf(B) = {A}. NOW A finally hears B (its own explicit
      //       push — the only way the chain propagates a hop).
      // ===================================================================
      {
        const res = h.cli(B, ['push', 'final', 'all work complete']);
        assert.equal(res.code, 0, `B push final exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.status, 'done', 'B done after push final');
        assert.equal(b.intent, 'done', 'B intent=done');
        const aInbox = h.inbox(A);
        assert.equal(aInbox.length, 1, 'A inbox now has exactly B\'s final (one hop, on B\'s push)');
        assert.equal(aInbox[0]!.from, B, 'A\'s entry is from B');
        assert.equal(aInbox[0]!.kind, 'final', 'A\'s entry is a final');
      }
      // Close B's window faithfully (done branch shutdown).
      await h.stop(B);
      await h.waitForPaneGone(B);
      assert.equal(h.paneAlive(B), false, 'B pane closed on done');

      // A — the resident top-level orchestrator — is still alive and well.
      {
        const a = h.node(A)!;
        assert.equal(a.status, 'active', 'A still active at the end');
        assert.equal(a.mode, 'orchestrator', 'A still orchestrator');
        assert.equal(a.lifecycle, 'resident', 'A still resident');
      }
    } finally {
      const session = h.session;
      await h.dispose();
      // Teardown leaves NO stray session.
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
