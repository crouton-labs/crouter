// Run with: node --import tsx/esm --test src/core/__tests__/subscription-delivery.test.ts
//
// MULTI-LEVEL SUBSCRIPTION DELIVERY — the DELIVERY-vs-WAKE distinction across a
// graph >=2 levels deep. The whole split is pure canvas/feed/daemon model logic,
// so this is driven by FABRICATING the topology + dormant states directly
// (foundation-spec §E.2) and exercising the real model layer (feed.push,
// evaluateStop, superviseTick) — NO real tmux session, NO pane chrome, and NO
// real broker boot (which would cost ~5s each). Every assertion reads the canvas
// data layer and is checked against the state-model ORACLE (§3b, §5, §6).
//
// HEADLESS / FABRICATED RETARGET (foundation-spec §C.15 + §E). All nodes are
// broker-hosted (paneless). Dormancy, which a tmux node shows as a closed pane,
// a broker shows as an EXITED process (status=idle, intent=idle-release, pi_pid
// dead) — fabricated directly. A daemon revive is observed via getNode().cycles
// (reviveNode bumps cycles + transition('revive') BEFORE it spawns — revive.ts:
// 114,145 — so the model effect is instant, no awaitBoot), never a real boot.
//
// (1) BUG LOCKED — the DELIVERY-vs-WAKE split (Invariant D + stop-guard): an
//     ACTIVE subscriber's pointer lands in inbox.jsonl and the daemon's 2nd pass
//     REVIVES it on that unseen entry; a PASSIVE subscriber's pointer lands in
//     passive.jsonl and NEVER wakes; a PASSIVE-only tie does NOT legitimize an
//     idle-release (hasActiveLiveSubscription filters active=1).
// (2) WHY MODEL-LEVEL, NOT TMUX CHROME — routing (feed.ts), the active/passive
//     edge filter (canvas.ts), the 2nd-pass inbox gate (crtrd.ts), and one-hop
//     fan-out are all pure data-layer; the only thing a pane ever provided was a
//     visible "dormant" signal, which a broker expresses as a dead pid — and
//     which fabrication sets directly.
// (3) HOW THE FABRICATED DRIVE STILL FAILS IF THE BUG REGRESSES — after T's
//     pushFinal, one h.tick() must revive the ACTIVE subscriber B (cycles bumps,
//     status→active) while the PASSIVE subscriber P stays idle with cycles==0. If
//     inbox-vs-passive routing breaks, either B's entry never reaches its inbox
//     (the 2nd-pass gate finds nothing → B not revived → cycles stays 0) or P
//     gets an inbox entry and IS woken (its cycles/status asserts go RED).
//     Verified by routing passive deliveries into the inbox (see bug-injection
//     report).
//
// THE ORACLE CONTRACT under test:
//   • feed.push fans to subscribersOf(target): active → inbox.jsonl (wakes),
//     passive → passive.jsonl (accumulates, NEVER wakes). (state-model §5; feed.ts)
//   • The daemon's 2nd pass revives an idle-released node ONLY on an unseen INBOX
//     entry (crtrd.ts) — so a passive subscriber's idle-released node never wakes.
//   • hasActiveLiveSubscription excludes passive edges (canvas.ts active=1) — a
//     passive tie does NOT legitimize idle-release (stop-guard §3b).
//   • Wake is ONE HOP per push: a push fans to DIRECT subscribers only; an indirect
//     ancestor hears nothing until a middle node explicitly re-pushes. (state-model §5)
//
// Graph (>=2 levels; T is two hops under A):
//        A  (resident root — the user's virtual front door)
//        └── B  (terminal)         A→B active seed  ── ACTIVE subscriber of T
//            ├── T  (terminal)     B→T active seed  ── THE TARGET (level 2)
//            ├── K  (terminal)     B→K active seed  ── keepalive (stays active)
//            └── P  (terminal)     B→P active seed  ── PASSIVE subscriber of T
//                  P→T passive  (wired via subscribe(P,T,false))
//                  P→K active   (the ONLY tie that legitimizes P's release;
//                                P→T passive is excluded from the stop-guard)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, type Harness } from './helpers/harness.js';
import { closeDb } from '../canvas/db.js';
import { subscribe } from '../canvas/canvas.js';
import { pushFinal, pushUpdate } from '../feed/feed.js';
import { readPassive } from '../feed/passive.js';
import { evaluateStop, STALL_REPROMPT } from '../runtime/stop-guard.js';
import type { InboxEntry } from '../feed/inbox.js';

// A pid reaped (dead) by the time spawnSync returns — a released broker's exited
// process (the headless analog of a closed pane).
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  return r.pid ?? 0x7ffffffe;
}

// LOCAL helper: read a node's PASSIVE accumulator (passive.jsonl) straight off
// the data layer, mirroring the harness's own `inbox()` reader. The harness
// exposes inbox() but NOT passive() — this fills that gap.
function passive(nodeId: string): InboxEntry[] {
  closeDb();
  return readPassive(nodeId);
}

// `{node_id, active}` arrays → a stable comparable set of `id:active|passive`.
function edgeSet(arr: { node_id: string; active: boolean }[]): Set<string> {
  return new Set(arr.map((e) => `${e.node_id}:${e.active ? 'active' : 'passive'}`));
}

test(
  'multi-level subscription delivery: active subscriber WOKEN vs passive subscriber DELIVERED-not-woken, on the same dormant target',
  { timeout: 30_000 },
  async () => {
    const h: Harness = await createHarness({ headless: true, sessionPrefix: 'crtr-subdeliv' });
    try {
      // ===================================================================
      // S1 — Build the graph by FABRICATION (no boots). A is a resident root
      //      (inline, daemon-untouched); B/T/K/P/X are broker nodes whose
      //      liveness fields are set directly. Each parent→child spine edge is
      //      wired ACTIVE.
      // ===================================================================
      const A = h.spawnRoot('front door'); // resident root, active, no placement
      // T (the target) and K (keepalive) are LIVE-active workers; B and P start
      // already DORMANT (idle-released, broker exited = dead pid) — exactly the
      // post-stop state the delivery split is judged against.
      const T = h.fabricateBrokerNode({ status: 'active', pi_pid: deadPid(), pi_session_id: 'sess-T' });
      const K = h.fabricateBrokerNode({ status: 'active', pi_pid: deadPid(), pi_session_id: 'sess-K' });
      const B = h.fabricateBrokerNode({ status: 'idle', intent: 'idle-release', pi_pid: deadPid(), pi_session_id: 'sess-B' });
      const P = h.fabricateBrokerNode({ status: 'idle', intent: 'idle-release', pi_pid: deadPid(), pi_session_id: 'sess-P' });

      // Spine seeds: A→B, B→T, B→K, B→P all ACTIVE (subscriber, publisher).
      subscribe(A, B, true);
      subscribe(B, T, true);
      subscribe(B, K, true);
      subscribe(B, P, true);
      // PASSIVE axis under test: P passively subscribes to T; P actively to K
      // (the only tie that legitimizes P's own idle-release).
      subscribe(P, T, false);
      subscribe(P, K, true);

      assert.deepEqual(
        edgeSet(h.subscribers(T)),
        new Set([`${B}:active`, `${P}:passive`]),
        'T has B(active) + P(passive) as subscribers — the same-target split',
      );
      assert.deepEqual(edgeSet(h.subscribers(B)), new Set([`${A}:active`]), 'A→B active seed');
      assert.deepEqual(
        edgeSet(h.subscriptions(P)),
        new Set([`${T}:passive`, `${K}:active`]),
        'P subscribes_to T(passive) + K(active)',
      );

      // ===================================================================
      // S2 — PASSIVE-EXCLUSION via the PURE stop-guard (the active/passive split
      //      half). evaluateStop is pure given the canvas; X holds a PASSIVE-only
      //      tie to the same live K that P holds ACTIVELY. hasActiveLiveSubscription
      //      filters active=1 (canvas.ts), so X's passive K-tie is invisible →
      //      'stalled' (STALL_REPROMPT); P's active K-tie → 'awaiting'. Same
      //      publisher K, opposite outcome purely by edge mode (oracle §3b, §5).
      // ===================================================================
      const X = h.fabricateBrokerNode({ status: 'active' });
      subscribe(X, K, false); // X→K PASSIVE-only — its ONLY subscription
      assert.deepEqual(
        edgeSet(h.subscriptions(X)),
        new Set([`${K}:passive`]),
        'X holds exactly one tie: K(passive) — no active live subscription',
      );
      {
        const xStop = evaluateStop(X, { pushedFinal: false, askedHuman: false });
        assert.equal(xStop.action, 'reprompt', 'X (passive-only) → reprompt, NOT awaiting');
        assert.equal(xStop.reason, 'stalled', 'X classified stalled — passive tie does not hold it');
        assert.equal(xStop.message, STALL_REPROMPT, 'X gets the stall re-prompt');

        const pStop = evaluateStop(P, { pushedFinal: false, askedHuman: false });
        assert.equal(pStop.action, 'allow', 'P (active K-tie) → allow');
        assert.equal(pStop.reason, 'awaiting', 'P classified awaiting on its ACTIVE K-sub — the discriminating positive');
      }

      // Pre-push baseline: keepalive up, grandparent untouched, nothing delivered.
      assert.equal(h.status(K), 'active', 'K active (keepalive holds P legitimately dormant)');
      assert.equal(h.status(A), 'active', 'A (resident root) untouched');
      assert.equal(h.inbox(A).length, 0, 'A inbox empty before the push');
      assert.equal(h.inbox(B).length, 0, 'B inbox empty before the push');
      assert.equal(passive(P).length, 0, 'P passive accumulator empty before the push');
      assert.equal(h.node(B)!.cycles ?? 0, 0, 'B not yet revived');
      assert.equal(h.node(P)!.cycles ?? 0, 0, 'P not yet revived');

      // ===================================================================
      // S3 — T FINISHES via the model layer (pushFinal). feed.push fans the
      //      pointer to subscribersOf(T) = {B(active), P(passive)} ONLY, by the
      //      delivery split: B's lands in inbox.jsonl, P's in passive.jsonl. A
      //      (the grandparent, NOT a subscriber of T) gets NOTHING — one-hop.
      // ===================================================================
      const TARGET_FINAL = 'TARGET-FINAL-BODY: the worker completed';
      await pushFinal(T, TARGET_FINAL);
      closeDb();
      {
        assert.equal(h.status(T), 'done', 'T done after pushFinal (transition finalize)');
        assert.equal(h.node(T)!.intent, 'done', 'T intent=done');

        // ACTIVE delivery → B's INBOX (the wake channel).
        const bFinal = h.inbox(B).find((e) => e.from === T && e.kind === 'final');
        assert.ok(bFinal, 'ACTIVE subscriber B: T-final pointer DELIVERED to inbox.jsonl');

        // PASSIVE delivery → P's ACCUMULATOR, NOT its inbox (no wake channel).
        const pPassive = passive(P);
        assert.equal(pPassive.length, 1, 'PASSIVE subscriber P: exactly one passive entry');
        assert.equal(pPassive[0]!.from, T, "P's passive entry is from T");
        assert.equal(pPassive[0]!.kind, 'final', "P's passive entry is the final");
        assert.equal(h.inbox(P).length, 0, 'PASSIVE subscriber P: inbox.jsonl stays EMPTY (no wake channel)');

        // ONE-HOP: the indirect ancestor and the non-subscriber sibling hear nothing.
        assert.equal(h.inbox(A).length, 0, 'A (grandparent, not a subscriber of T) NOT delivered — one-hop');
        assert.equal(h.inbox(K).length, 0, 'K (sibling, not a subscriber of T) NOT delivered');
      }

      // ===================================================================
      // S4 — The DAEMON decision pass. Its 2nd pass revives an idle-released node
      //      ONLY on an unseen INBOX entry. B has one (active) → REVIVED. P has
      //      none (its entry went to passive.jsonl) → stays idle. The WAKE half
      //      of delivery-vs-wake, decided in ONE tick — observed via cycles.
      // ===================================================================
      await h.tick();

      // ACTIVE subscriber: WOKEN — reviveNode bumped cycles + transition(revive).
      {
        const b = h.node(B)!;
        assert.equal(b.cycles ?? 0, 1, 'ACTIVE subscriber B: daemon pass-2 REVIVED (cycles bumped to 1)');
        assert.equal(b.status, 'active', 'B revive → active');
        assert.equal(b.intent ?? null, null, 'B intent cleared by revive');
      }

      // PASSIVE subscriber: NOT WOKEN — the same tick did NOT revive P.
      {
        const p = h.node(P)!;
        assert.equal(p.cycles ?? 0, 0, 'PASSIVE subscriber P: NOT revived (cycles still 0)');
        assert.equal(p.status, 'idle', 'P STILL idle — daemon did NOT wake it');
        assert.equal(p.intent, 'idle-release', 'P still intent=idle-release (untouched)');
      }
      assert.equal(passive(P).length, 1, "P's passive entry is still pending (drained only on its next message)");
      assert.equal(h.inbox(P).length, 0, "P's inbox still empty");

      // The grandparent is STILL untouched even though B woke — one-hop confirmed.
      assert.equal(h.inbox(A).length, 0, 'A inbox STILL empty after B woke — wake did not propagate up');
      assert.equal(h.status(A), 'active', 'A unchanged');

      // ===================================================================
      // S5 — SECOND SITE: one-hop fan-out on a re-push. The indirect ancestor A
      //      hears B ONLY when B explicitly re-pushes up its own spine. B (now
      //      active) pushes an UPDATE → it fans to subscribersOf(B) = {A} only.
      // ===================================================================
      await pushUpdate(B, 'B re-pushing the rolled-up result');
      closeDb();
      {
        const aInbox = h.inbox(A);
        assert.equal(aInbox.length, 1, "A inbox now has exactly B's update (one hop, on B's explicit re-push)");
        assert.equal(aInbox[0]!.from, B, "A's entry is from B");
        assert.equal(aInbox[0]!.kind, 'update', "A's entry is the update");
      }
      // The re-push reached its DIRECT subscriber A only — siblings/observer untouched.
      assert.equal(h.inbox(P).length, 0, "P inbox untouched by B's re-push (P does not subscribe to B)");
      assert.equal(h.inbox(K).length, 0, "K inbox untouched by B's re-push");
      assert.equal(passive(P).length, 1, "P's passive backlog unchanged by B's re-push");
    } finally {
      await h.dispose();
    }
  },
);
