// Run with: node --import tsx/esm --test src/core/__tests__/live-mutation.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.12 + §E). AXIS: LIVE MUTATION of the
// 2×2 state vector (mode {base,orchestrator} × lifecycle {terminal,resident})
// driven through the REAL `node lifecycle` / `node promote` CLI verbs against
// FABRICATED broker-hosted (paneless) nodes — no real tmux session, no pane
// chrome, and NO real broker boot. The mutation verbs and the decisions they
// gate are host-independent model logic, so the file never pays the ~5s SDK-boot
// cost. Every assertion reads the canvas data layer / a PURE decision function.
//
// THREE-PART LOCK HEADER ──────────────────────────────────────────────────
// (1) BUG LOCKED — (a) a live lifecycle flip changes the idle-release decision:
//     a resident node is NEVER forced dormant (suppressed), a terminal one with
//     an active live sub IS legitimately awaiting (restored). (b) a live promote
//     flips mode but leaves persona_ack PENDING for the injector — it never
//     commits the ack itself.
// (2) WHY MODEL-LEVEL, NOT PANE/WINDOW — the flip writes lifecycle/mode on the
//     row (updateNode) and the idle-release call is decided by the PURE
//     evaluateStop (stop-guard.ts), which keys on lifecycle + active live subs,
//     never on a pane. persona_ack lives in meta.json; personaDrift is pure. No
//     pane/window is read anywhere.
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE FIX REGRESSES — (a) after the
//     terminal→resident flip, evaluateStop(B) must read 'dormant' NOT 'awaiting';
//     if the resident-suppression branch in stop-guard regresses (lifecycle
//     ignored), B still has its active live sub to C so evaluateStop returns
//     'awaiting' → the 'dormant' assert goes RED (verified by bug-injection
//     below). (b) after promote, personaDrift(B) must still report base→
//     orchestrator PENDING; if promote wrongly committed the ack, drift reads
//     null → the pending-drift assert goes RED.
//
// STOPHOOK CAVEAT — split (option b). The original drove a LIVE fake-pi turn so
// the REAL stophook enacted the idle-release at agent_end and committed
// persona_ack at turn_end. Fabrication cannot run those hooks. So this test
// asserts the PURE decisions the hooks enact (evaluateStop / personaDrift) and
// leaves the hook-commit proof to the already-pure siblings:
//   • idle-release / resident-suppression commit at agent_end → canvas-stophook-
//     agentend.test.ts ('natural stop while awaiting a live worker → idle-release'
//     and '§5.1.7 resident attended … nothing happens').
//   • persona_ack recompose at turn_end → persona.test.ts ('personaDrift detects
//     base→orchestrator after promote, then clears on commit').

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { subscribe } from '../canvas/canvas.js';
import { commitPersonaAck, personaDrift } from '../runtime/persona.js';
import { evaluateStop } from '../runtime/stop-guard.js';
import type { NodeMeta } from '../canvas/types.js';

/** Normalize the two persona axes off a NodeMeta for deepEqual. */
function persona(m: NodeMeta): { mode: string; lifecycle: string } {
  return { mode: m.mode, lifecycle: m.lifecycle };
}
const SIGNALS = { pushedFinal: false, askedHuman: false };

// ===========================================================================
// (a) LIFECYCLE FLIP — `crtr node lifecycle` on a LIVE node, both directions,
//     observing the idle-release DECISION change. A round-trip on ONE node
//     (terminal→resident→terminal) proves both directions: a flipped-resident
//     node no longer idle-releases (evaluateStop → dormant); flipped-terminal it
//     idle-releases again (evaluateStop → awaiting, on its active live sub).
// ===========================================================================
test(
  'live lifecycle flip: terminal→resident suppresses idle-release; resident→terminal restores it',
  { timeout: 20_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-live-life' });
    try {
      // A (resident root) ─ B (base/terminal) ─ C (base/terminal). B holds an
      // ACTIVE live sub to C → a TERMINAL B that stops is legitimately 'awaiting'
      // and would idle-release. That live sub is the precondition that makes the
      // resident-vs-terminal flip the ONLY variable in the stop decision.
      const A = h.spawnRoot('resident root');
      const B = h.fabricateBrokerNode({ parent: A, kind: 'developer', mode: 'base', lifecycle: 'terminal', status: 'active' });
      const C = h.fabricateBrokerNode({ parent: B, mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(A, B, true);
      subscribe(B, C, true);
      {
        const b = h.node(B)!;
        assert.deepEqual(persona(b), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');
        assert.equal(b.status, 'active', 'B active');
        assert.equal(b.intent ?? null, null, 'B no intent');
        assert.equal(h.status(C), 'active', 'C active — B holds a live sub to it');
        assert.ok(h.subscriptions(B).some((s) => s.node_id === C && s.active), 'B subscribes_to C (active) — the awaiting precondition');
      }

      // BASELINE — as a TERMINAL node with the active live sub, B's stop is
      // 'awaiting' (it would idle-release).
      {
        const stop = evaluateStop(B, SIGNALS);
        assert.equal(stop.action, 'allow', 'terminal B → allow');
        assert.equal(stop.reason, 'awaiting', 'terminal B with an active live sub → awaiting (would idle-release)');
      }

      // --- FLIP 1: terminal → RESIDENT (live). Oracle §4: sets lifecycle + the
      //     launch spec, status/intent UNTOUCHED. ---
      {
        const res = h.cli(B, ['node', 'lifecycle', 'resident', '--node', B]);
        assert.equal(res.code, 0, `lifecycle resident exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'resident', 'B → resident');
        assert.equal(b.mode, 'base', 'mode UNCHANGED by a lifecycle flip (orthogonal axis)');
        assert.equal(b.status, 'active', 'status UNTOUCHED by node lifecycle (oracle §4)');
        assert.equal(b.intent ?? null, null, 'intent UNTOUCHED by node lifecycle (oracle §4)');
      }

      // THE SUPPRESSION LOCK — as RESIDENT, B's stop is 'dormant' (NOT awaiting):
      // a resident node is never forced to submit a final, so it does NOT idle-
      // release even though it still holds the SAME active live sub to C that
      // would release a terminal node. evaluateStop is the PURE decision the
      // stophook enacts (the actual no-release commit is locked by canvas-
      // stophook-agentend §5.1.7). NON-VACUOUS: revert the resident branch in
      // stop-guard and B reads 'awaiting' → this goes RED (see bug-injection).
      {
        const stop = evaluateStop(B, SIGNALS);
        assert.equal(stop.action, 'allow', 'resident B → allow');
        assert.equal(stop.reason, 'dormant', 'resident B → dormant, NOT awaiting — idle-release SUPPRESSED by the live flip');
      }

      // --- FLIP 2: resident → TERMINAL (live), on the now-resident node. ---
      {
        const res = h.cli(B, ['node', 'lifecycle', 'terminal', '--node', B]);
        assert.equal(res.code, 0, `lifecycle terminal exit 0\n${res.stderr}`);
        const b = h.node(B)!;
        assert.equal(b.lifecycle, 'terminal', 'B → terminal');
        assert.equal(b.status, 'active', 'status still UNTOUCHED by the flip');
        assert.equal(b.intent ?? null, null, 'intent still UNTOUCHED by the flip');
      }

      // THE RESTORE LOCK — terminal again, B's stop is 'awaiting' once more: the
      // exact idle-release behavior the resident flip had suppressed.
      {
        const stop = evaluateStop(B, SIGNALS);
        assert.equal(stop.action, 'allow', 'terminal B → allow');
        assert.equal(stop.reason, 'awaiting', 'terminal B with the active live sub → awaiting AGAIN (idle-release RESTORED)');
      }
      assert.equal(h.status(C), 'active', 'C untouched throughout the round-trip');
    } finally {
      await h.dispose();
    }
  },
);

// ===========================================================================
// (b) MODE FLIP — promote: base → orchestrator on a LIVE node. The flip itself
//     does NOT commit the persona ack; the turn_end injector recomposes (commits
//     the ack + delivers the steer) on the next turn. The NEW assertions here
//     are that promote leaves the ack PENDING (not committed) and personaDrift
//     reports the exact base→orchestrator transition the injector would deliver —
//     the model precondition of the recompose (whose commit is locked by
//     persona.test.ts).
// ===========================================================================
test(
  'live mode flip: promote base→orchestrator leaves persona_ack PENDING for the turn_end injector',
  { timeout: 20_000 },
  async () => {
    const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-live-mode' });
    try {
      const A = h.spawnRoot('resident root');
      const B = h.fabricateBrokerNode({ parent: A, kind: 'developer', mode: 'base', lifecycle: 'terminal', status: 'active' });
      subscribe(A, B, true);
      // Born acked to its own persona (mirroring a real birth) → no spurious
      // drift before the promote (invariant 11).
      commitPersonaAck(B, { mode: 'base', lifecycle: 'terminal' });
      {
        const b = h.node(B)!;
        assert.deepEqual(persona(b), { mode: 'base', lifecycle: 'terminal' }, 'B born base×terminal');
        assert.deepEqual(b.persona_ack, { mode: 'base', lifecycle: 'terminal' }, 'persona_ack born equal to the initial persona (invariant 11)');
        assert.equal(personaDrift(B), null, 'no drift before the promote');
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
        assert.deepEqual(b.persona_ack, { mode: 'base', lifecycle: 'terminal' }, 'promote does NOT commit the ack — drift left PENDING for the injector');
      }

      // THE PENDING-DRIFT LOCK — personaDrift(B) reports the exact base→
      // orchestrator transition the turn_end injector would deliver as a steer
      // (and then commit). NON-VACUOUS: if promote wrongly committed the ack,
      // personaDrift reads null and the asserts below go RED. The actual delivery
      // + commit (and its idempotence on a second turn) is locked by
      // persona.test.ts ('… then clears on commit').
      {
        const drift = personaDrift(B);
        assert.ok(drift !== null, 'a recompose is pending after the live promote');
        assert.deepEqual(drift?.from, { mode: 'base', lifecycle: 'terminal' }, 'drift.from = the acked base×terminal');
        assert.deepEqual(drift?.to, { mode: 'orchestrator', lifecycle: 'terminal' }, 'drift.to = the new orchestrator persona');
        assert.match(drift?.guidance ?? '', /ORCHESTRATOR/i, 'the steer carries the base→orchestrator orchestration guidance');
      }

      // And the recompose IS the injector's job, committed at turn_end — modeled
      // here by commitPersonaAck (what the injector calls), proving drift then
      // clears (idempotent). The firing of that commit inside the live stophook
      // is locked by persona.test.ts.
      commitPersonaAck(B, { mode: 'orchestrator', lifecycle: 'terminal' });
      assert.deepEqual(h.node(B)!.persona_ack, { mode: 'orchestrator', lifecycle: 'terminal' }, 'persona_ack recomposed to the new persona');
      assert.equal(personaDrift(B), null, 'no fresh drift after the ack commit (idempotent recompose)');
    } finally {
      await h.dispose();
    }
  },
);
