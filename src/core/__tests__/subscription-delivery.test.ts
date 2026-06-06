// Run with: node --import tsx/esm --test src/core/__tests__/subscription-delivery.test.ts
//
// MULTI-LEVEL SUBSCRIPTION DELIVERY — the DELIVERY-vs-WAKE distinction across a
// graph >=2 levels deep, driven through the FAITHFUL integration harness (real
// CLI, real isolated tmux, real extension hooks in the fake-pi vehicle, real
// daemon decision pass via superviseTick). Every assertion reads the canvas
// data layer and is checked against the state-model ORACLE (§3b, §5, §6).
//
// This is the multi-level companion to the UNIT-level passive-subscription.test.ts
// (which pins push→inbox vs push→passive.jsonl routing in-process). What that test
// CANNOT show — and what is added here — is the runtime WAKE consequence of the
// split when BOTH an active and a passive subscriber sit on the SAME target and
// BOTH are DORMANT (terminal idle-released): the active one is daemon-REVIVED on
// its unseen inbox entry; the passive one is NOT (its pointer lands in the passive
// accumulator the daemon never reads), so it stays idle.
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
//                  P→T passive  (wired via `crtr node subscribe --passive`)
//                  P→K active   (wired — the ONLY tie that legitimizes P's release;
//                                P→T passive is excluded from the stop-guard)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { closeDb } from '../canvas/db.js';
import { readPassive } from '../feed/passive.js';
import { STALL_REPROMPT } from '../runtime/stop-guard.js';
import type { InboxEntry } from '../feed/inbox.js';

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

// LOCAL helper (candidate for harness consolidation — see report): read a node's
// PASSIVE accumulator (passive.jsonl) straight off the data layer, mirroring the
// harness's own `inbox()` reader. closeDb() keeps it consistent with the harness's
// cross-process WAL discipline (the push that wrote passive.jsonl ran in a `cli`
// subprocess). The harness exposes inbox() but NOT passive() — this fills that gap.
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
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 180_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-subdeliv' });
    try {
      // ===================================================================
      // S1 — Build the graph. A (resident root, virtual) ► B ► {T,K,P}.
      //      Each spawn seeds an ACTIVE parent→child subscription (the spine).
      // ===================================================================
      const A = h.spawnRoot('front door');
      const B = await h.spawnChild(A, 'mid manager', { kind: 'developer' });
      const T = await h.spawnChild(B, 'the target worker');
      const K = await h.spawnChild(B, 'a keepalive worker');
      const P = await h.spawnChild(B, 'the passive observer');

      // Spine seeds: A→B, B→T, B→K, B→P all ACTIVE. T's sole subscriber so far is B.
      assert.deepEqual(
        edgeSet(h.subscribers(T)),
        new Set([`${B}:active`]),
        "T's only subscriber at birth is B (active spawn seed)",
      );
      assert.deepEqual(edgeSet(h.subscribers(B)), new Set([`${A}:active`]), 'A→B active seed');

      // ===================================================================
      // S2 — Wire the PASSIVE subscriber. P passively subscribes to T (the axis
      //      under test), and ACTIVELY subscribes to K (the only tie that will
      //      legitimize P's own idle-release — its passive tie to T does NOT count).
      // ===================================================================
      {
        const passiveRes = h.cli(P, ['node', 'subscribe', T, '--passive']);
        assert.equal(passiveRes.code, 0, `P→T passive subscribe exit 0\n${passiveRes.stderr}`);
        assert.match(passiveRes.stdout, /mode="passive"/, 'P→T wired PASSIVE');
        const activeRes = h.cli(P, ['node', 'subscribe', K]);
        assert.equal(activeRes.code, 0, `P→K active subscribe exit 0\n${activeRes.stderr}`);
        assert.match(activeRes.stdout, /mode="active"/, 'P→K wired ACTIVE');
      }

      // T now has BOTH an active (B) and a passive (P) subscriber — the crux.
      assert.deepEqual(
        edgeSet(h.subscribers(T)),
        new Set([`${B}:active`, `${P}:passive`]),
        'T has B(active) + P(passive) as subscribers — the same-target split',
      );
      assert.deepEqual(
        edgeSet(h.subscriptions(P)),
        new Set([`${T}:passive`, `${K}:active`]),
        'P subscribes_to T(passive) + K(active)',
      );

      // ===================================================================
      // S2b — PASSIVE-EXCLUSION, demonstrated directly (the stop-guard half of
      //       the active/passive split). X subscribes PASSIVE-ONLY to the very
      //       same live K that P subscribes to ACTIVELY. On stop, X holds NO
      //       active live subscription — hasActiveLiveSubscription filters
      //       active=1 (canvas.ts), so the passive K-tie is invisible to it →
      //       the stop-guard returns 'stalled', NOT 'awaiting': X is re-prompted
      //       (STALL_REPROMPT) and stays ACTIVE; it does NOT idle-release. Same
      //       publisher K, opposite outcome purely by edge mode — ACTIVE holds a
      //       node alive to await, PASSIVE does not (oracle §3b, §5). This is the
      //       discriminating negative the rest of the test relies on.
      // ===================================================================
      const X = await h.spawnChild(B, 'a passive-only observer');
      {
        const res = h.cli(X, ['node', 'subscribe', K, '--passive']);
        assert.equal(res.code, 0, `X→K passive subscribe exit 0\n${res.stderr}`);
        assert.match(res.stdout, /mode="passive"/, 'X→K wired PASSIVE-only (its ONLY subscription)');
      }
      assert.deepEqual(
        edgeSet(h.subscriptions(X)),
        new Set([`${K}:passive`]),
        'X holds exactly one tie: K(passive) — no active live subscription',
      );
      const injBeforeStall = h.injected(X).length;
      await h.stop(X);
      // The PASSIVE tie does NOT legitimize a release → 'stalled' → re-prompt.
      await h.waitFor(
        () => h.injected(X).slice(injBeforeStall).find((e) => e.content.includes(STALL_REPROMPT)),
        { timeoutMs: 15_000, label: 'X (passive-only) → STALL_REPROMPT, not awaiting' },
      );
      assert.equal(h.status(X), 'active', 'X stays ACTIVE — a PASSIVE-only tie does NOT hold it as awaiting');
      assert.equal(h.node(X)!.intent ?? null, null, 'X intent untouched — it did NOT idle-release');

      // ===================================================================
      // S3 — P goes DORMANT. P stops while holding an ACTIVE live sub to K →
      //      stop-guard 'awaiting' → idle-release. (Its PASSIVE sub to T is
      //      EXCLUDED from hasActiveLiveSubscription — proven directly by S2b:
      //      a passive-only tie stalls; only the ACTIVE K-tie releases P here.)
      // ===================================================================
      await h.stop(P);
      await h.waitForStatus(P, 'idle');
      {
        const p = h.node(P)!;
        assert.equal(p.status, 'idle', 'P idle (released on the strength of its ACTIVE K-sub)');
        assert.equal(p.intent, 'idle-release', 'P intent=idle-release');
      }
      await h.waitForPaneGone(P);
      assert.equal(h.paneAlive(P), false, 'P unfocused → pane closed on idle-release (dormant)');

      // ===================================================================
      // S4 — B (the ACTIVE subscriber of T) goes DORMANT too. B awaits T,K
      //      (active) and P (now idle) → 'awaiting' → idle-release, pane closes.
      //      Now BOTH subscribers of T are dormant — one active, one passive.
      // ===================================================================
      await h.stop(B);
      await h.waitForStatus(B, 'idle');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'idle', 'B idle (released, awaiting its live children)');
        assert.equal(b.intent, 'idle-release', 'B intent=idle-release');
      }
      await h.waitForPaneGone(B);
      assert.equal(h.paneAlive(B), false, 'B unfocused → pane closed on idle-release');

      // Pre-push baseline: the keepalive is up, the grandparent is untouched.
      assert.equal(h.status(K), 'active', 'K still active (keepalive holds P legitimately dormant)');
      assert.equal(h.status(A), 'active', 'A (resident root) untouched');
      assert.equal(h.inbox(A).length, 0, 'A inbox empty before the push');
      assert.equal(h.inbox(B).length, 0, 'B inbox empty before the push (nothing delivered yet)');
      assert.equal(passive(P).length, 0, 'P passive accumulator empty before the push');

      // ===================================================================
      // S5 — T FINISHES (push final). feed.push fans the pointer to
      //      subscribersOf(T) = {B(active), P(passive)} ONLY, by the delivery
      //      split: B's lands in inbox.jsonl, P's in passive.jsonl. A (the
      //      grandparent, NOT a subscriber of T) gets NOTHING — one-hop fan-out.
      // ===================================================================
      const TARGET_FINAL = 'TARGET-FINAL-BODY: the worker completed';
      await h.finish(T, TARGET_FINAL);
      {
        const t = h.node(T)!;
        assert.equal(t.status, 'done', 'T done after push final');
        assert.equal(t.intent, 'done', 'T intent=done');
        assert.equal(h.paneAlive(T), false, 'T pane closed on done');

        // ACTIVE delivery → B's INBOX (the wake channel).
        const bInbox = h.inbox(B);
        const bFinal = bInbox.find((e) => e.from === T && e.kind === 'final');
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
      // S6 — The DAEMON decision pass. Its 2nd pass revives an idle-released
      //      node ONLY on an unseen INBOX entry. B has one (active) → REVIVED
      //      (resume). P has none (its entry went to passive.jsonl) → stays idle.
      //      This is the WAKE half of delivery-vs-wake, decided in ONE tick.
      // ===================================================================
      const injBeforeWake = h.injected(B).length;
      await h.tick();

      // ACTIVE subscriber: WOKEN — status flips to active and a fresh pi resumes.
      await h.waitForStatus(B, 'active');
      {
        const b = h.node(B)!;
        assert.equal(b.status, 'active', 'ACTIVE subscriber B: daemon-REVIVED → active');
        assert.equal(b.intent ?? null, null, "B intent cleared by revive");
      }
      await h.awaitBoot(B, { minCount: 2 }); // spawn boot + resume boot
      // awaitWake THROWS on a 15s timeout unless an injected entry matching T's
      // body arrives — that match-or-timeout IS the load-bearing oracle here. The
      // resume-boot injects persona/bearings, never the report body, so only the
      // real inbox-watcher delivery of T's final can satisfy the match.
      await h.awaitWake(B, { sinceCount: injBeforeWake, match: /TARGET-FINAL-BODY/ });

      // PASSIVE subscriber: NOT WOKEN — the synchronous tick that revived B did
      // NOT revive P; P remains idle-released with its pane gone. (The tick's
      // loop completed before tick() returned, so P's non-revive is settled.)
      assert.equal(h.status(P), 'idle', 'PASSIVE subscriber P: STILL idle — daemon did NOT wake it');
      assert.equal(h.node(P)!.intent, 'idle-release', 'P still intent=idle-release (untouched)');
      assert.equal(h.paneAlive(P), false, 'P pane STILL gone — no resume happened');
      assert.equal(passive(P).length, 1, "P's passive entry is still pending (drained only on its next message)");
      assert.equal(h.inbox(P).length, 0, "P's inbox still empty");

      // The grandparent is STILL untouched even though B woke — one-hop confirmed.
      assert.equal(h.inbox(A).length, 0, 'A inbox STILL empty after B woke — wake did not propagate up');
      assert.equal(h.status(A), 'active', 'A unchanged');

      // ===================================================================
      // S7 — SECOND SITE: one-hop fan-out on a re-push. The indirect ancestor A
      //      hears B ONLY when B explicitly re-pushes up its own spine. B (now
      //      active) pushes an UPDATE → it fans to subscribersOf(B) = {A} only.
      //      This corroborates the flagship one-hop finding at an independent site.
      // ===================================================================
      {
        const res = h.cli(B, ['push', 'update', 'B re-pushing the rolled-up result']);
        assert.equal(res.code, 0, `B push update exit 0\n${res.stderr}`);
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
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
