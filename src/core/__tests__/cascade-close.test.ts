// Run with: node --import tsx/esm --test src/core/__tests__/cascade-close.test.ts
//
// CASCADE CLOSE + exclusive-subtree ownership — a FAITHFUL integration test of
// `crtr node close` on a MIDDLE node, driven through the REAL CLI against a REAL
// isolated tmux session with REAL fake-pi vehicles in REAL panes, asserting off
// the canvas data layer and checked against the state-model ORACLE
// (state-model.md §4 `node close`, §5 cascade-close ownership, invariant 3,
// ambiguity A5).
//
// WHY this exists alongside the unit `close.test.ts`: that test exercises
// `closeNode()` in-process against the data layer with FABRICATED pane strings
// (`pane:'%x'`) — it proves the closing-set fixpoint and the status flip, but it
// never kills a real tmux pane, never boots a real vehicle, and never closes a
// MIDDLE node with a live sideways-sibling subtree. This test fills exactly that
// gap: it builds a real tree, closes the middle, and proves the reap is EXACTLY
// the closed node's own subtree — nothing above (the ancestor) or sideways (a
// sibling subtree) is touched, and real panes actually die.
//
// The tree (covers BOTH required shapes in one topology):
//
//     A (resident root, in-process)
//     ├── B   ◄── CLOSE TARGET (the middle node)
//     │   ├── C
//     │   │   └── E        depth  : A→B→C→E  (deep chain)
//     │   └── D            breadth: B has two children {C, D}
//     └── S                sideways sibling subtree — MUST survive
//         └── G
//
//   close(B) ⇒ exclusive subtree {B,C,D,E} reaped; A,S,G untouched.
//
// CRITICAL DELIVERABLE (ambiguity A5): the EXACT terminal status a cascade-
// reaped descendant receives under `node close`. CURRENT behavior, asserted
// end-to-end below: status === 'canceled', intent === null (cleared) — for the
// cascade ROOT and EVERY descendant alike (`transition(id,'cancel')`,
// close.ts → lifecycle.ts cancel row: status='canceled', intent=null, from '*').
// This differs from the ancestor-RESET path (`reapDescendants` → `reap` → 'done')
// — same act, different terminal status: A5's open question. We assert the close
// side and report the confirmed fact; we do NOT change it.
//
// FLAG vs the task brief: the brief expected "subscription+parent edges removed"
// on close. CURRENT behavior + the ORACLE (§4: "Nothing is deleted: pi sessions +
// edges persist → revivable") + the CLI help ("their pi sessions and canvas edges
// persist for a later revive") all say edges PERSIST. This test asserts the
// CURRENT (persist) behavior and the report flags the contradiction; production
// is NOT changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

test(
  'cascade close: middle-node close reaps EXACTLY its subtree (canceled), ancestor + sideways untouched, edges persist',
  { skip: !hasTmux() ? 'tmux unavailable' : false, timeout: 180_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-cascade' });
    try {
      // ===================================================================
      // BUILD — the real tree. A is the in-process resident root (no pane);
      // B,C,D,E,S,G are real managed children, each a real fake-pi in a real
      // backstage pane (spawnChild awaits each boot). Every `node new` seeds the
      // spine edge parent→child (active) + the spawned_by/parent provenance.
      // ===================================================================
      const A = h.spawnRoot('cascade-close root');
      const B = await h.spawnChild(A, 'middle node — the close target', { kind: 'developer' });
      const C = await h.spawnChild(B, 'B child one');
      const E = await h.spawnChild(C, 'deep leaf under C'); // depth: A→B→C→E
      const D = await h.spawnChild(B, 'B child two'); // breadth: B has {C, D}
      const S = await h.spawnChild(A, 'sideways sibling of B'); // sideways subtree
      const G = await h.spawnChild(S, 'child of the sideways sibling');

      const subtree = [B, C, D, E]; // B's exclusive subtree (the expected reap set)
      const sideways = [S, G]; // a sibling subtree — must be wholly untouched

      // Pre-close sanity: every node live + present, spine wired as drawn.
      {
        for (const id of [B, C, D, E, S, G]) {
          assert.equal(h.status(id), 'active', `${id} active before close`);
          assert.equal(h.paneAlive(id), true, `${id} has a live pane before close`);
        }
        assert.equal(h.status(A), 'active', 'A (root) active before close');
        // Spine: A→{B,S}, B→{C,D}, C→{E}, S→{G} (all active spawn-seed edges).
        const subIds = (n: string): string[] => h.subscriptions(n).map((s) => s.node_id).sort();
        assert.deepEqual(subIds(A), [B, S].sort(), 'A subscribes_to B and S');
        assert.deepEqual(subIds(B), [C, D].sort(), 'B subscribes_to C and D');
        assert.deepEqual(subIds(C), [E], 'C subscribes_to E');
        assert.deepEqual(subIds(S), [G], 'S subscribes_to G');
        // provenance edges (spawned_by / parent)
        for (const [child, parent] of [[B, A], [C, B], [E, C], [D, B], [S, A], [G, S]] as const) {
          assert.equal(h.node(child)!.parent, parent, `${child}.parent = ${parent}`);
        }
      }

      // Make A's inbox NON-EMPTY before the close so "ancestor inbox intact" is a
      // non-vacuous assertion: B pushes a routine update up its spine → A (B's
      // sole active subscriber). A is the in-process root with no live watcher,
      // so the pointer simply accumulates and must survive the close untouched.
      {
        const res = h.cli(B, ['push', 'update', 'progress from B before close']);
        assert.equal(res.code, 0, `B push update exit 0\n${res.stderr}`);
      }
      const aInboxBefore = h.inbox(A);
      assert.ok(
        aInboxBefore.some((e) => e.from === B && e.kind === 'update'),
        "A's inbox holds B's pre-close update (non-vacuous 'intact' baseline)",
      );

      // ===================================================================
      // CLOSE the MIDDLE node B, through the REAL CLI (`crtr node close --node B`,
      // run AS the root A). closeNode is synchronous in the subprocess: by the
      // time it returns, rows are flipped and panes are killed.
      // ===================================================================
      const closeRes = h.cli(A, ['node', 'close', '--node', B]);
      assert.equal(closeRes.code, 0, `node close exit 0\n${closeRes.stderr}`);
      // The CLI's own rendered report: cascade root B, exactly 4 closed, 0 spared.
      assert.match(
        closeRes.stdout,
        new RegExp(`<closed id="${B}" count="4" spared="0"\\s*/>`),
        `close report names B as root, count=4, spared=0\n${closeRes.stdout}`,
      );

      // ===================================================================
      // ASSERT 1 — the A5 DELIVERABLE: the EXACT terminal status of every
      // cascade-reaped node. CURRENT behavior: status='canceled', intent=null,
      // for the ROOT (B) and EVERY descendant {C,D,E} identically.
      // ===================================================================
      for (const id of subtree) {
        const n = h.node(id)!;
        assert.equal(n.status, 'canceled', `${id} terminal status === 'canceled' (cancel event)`);
        assert.strictEqual(n.intent ?? null, null, `${id} intent cleared to null on cancel`);
      }
      // Pin the exact field tuple once more, explicitly, for the human decision:
      // a cascade-reaped descendant under `node close` reads (canceled, null) —
      // NOT (done, done) and NOT (done, null). This is the confirmed A5 fact.
      {
        const e = h.node(E)!; // the deepest descendant
        assert.deepEqual(
          { status: e.status, intent: e.intent ?? null },
          { status: 'canceled', intent: null },
          "deepest reaped descendant E: (status,intent) === ('canceled', null)",
        );
      }

      // ===================================================================
      // ASSERT 2 — real panes destroyed for the ENTIRE subtree (invariant 12-ish:
      // a torn-down node owns no pane). tearDownNode killed each real tmux pane.
      // ===================================================================
      for (const id of subtree) {
        await h.waitForPaneGone(id);
        assert.equal(h.paneAlive(id), false, `${id} real pane destroyed by close`);
      }

      // ===================================================================
      // ASSERT 3 — EXCLUSIVE-SUBTREE OWNERSHIP: nothing ABOVE (A) and nothing
      // SIDEWAYS (S, G) was reaped. close(B) reaped EXACTLY B's own subtree.
      // ===================================================================
      // Ancestor A — fully untouched: still the live resident root, inbox intact.
      {
        const a = h.node(A)!;
        assert.equal(a.status, 'active', 'A (ancestor) still active — untouched by the cascade');
        assert.equal(a.lifecycle, 'resident', 'A still resident');
        assert.equal(a.intent ?? null, null, 'A intent untouched');
        assert.deepEqual(
          h.inbox(A),
          aInboxBefore,
          "A's inbox is byte-for-byte intact across the close (cascade touches only closed nodes' inboxes)",
        );
      }
      // Sideways subtree S→G — wholly alive: status active AND real panes alive.
      for (const id of sideways) {
        assert.equal(h.status(id), 'active', `${id} (sideways) still active — not reaped`);
        assert.equal(h.paneAlive(id), true, `${id} (sideways) real pane still alive`);
      }
      // The strong "EXACTLY its own subtree" closure: every node in the graph is
      // either in B's subtree (canceled) or untouched (active) — no over-reach.
      {
        const reaped = new Set(subtree);
        for (const id of [A, B, C, D, E, S, G]) {
          const want = reaped.has(id) ? 'canceled' : 'active';
          assert.equal(h.status(id), want, `${id} status === '${want}' (no over-/under-reach)`);
        }
      }

      // ===================================================================
      // ASSERT 4 — EDGES PERSIST (CURRENT behavior + ORACLE §4). close is a pause,
      // not a delete: a closed node keeps its spine + provenance edges so it can
      // be revived. (FLAGGED in the report: the task brief expected "edges
      // removed" — that contradicts current behavior; we assert persistence.)
      // ===================================================================
      {
        const subIds = (n: string): string[] => h.subscriptions(n).map((s) => s.node_id).sort();
        // Ancestor's spine edge to the closed middle node survives.
        assert.ok(
          h.subscriptions(A).some((s) => s.node_id === B && s.active),
          'A→B subscription edge PERSISTS after close (revivable)',
        );
        // Intra-subtree spine edges survive too.
        assert.deepEqual(subIds(B), [C, D].sort(), 'B→{C,D} edges persist');
        assert.deepEqual(subIds(C), [E], 'C→E edge persists');
        // Provenance (spawned_by / parent) survives.
        for (const [child, parent] of [[B, A], [C, B], [E, C], [D, B]] as const) {
          assert.equal(h.node(child)!.parent, parent, `${child}.parent = ${parent} persists`);
        }
        // Sideways edges obviously untouched.
        assert.deepEqual(subIds(S), [G], 'S→G edge untouched');
      }

      // ===================================================================
      // ASSERT 5 — each closed node got its cancellation notice (the resume
      // breadcrumb), appended AFTER its watcher died (close.ts step 3). The root
      // B reads "CLOSED by the user"; descendants read "CANCELED — an ancestor…".
      // ===================================================================
      {
        const bNotice = h.inbox(B).at(-1)!;
        assert.equal(bNotice.from, null, "B's cancel notice is a system message");
        assert.match(bNotice.label, /CLOSED by the user/, 'B (cascade root) reads the CLOSED notice');
        assert.equal(bNotice.data?.['cascade_root'], B, "B notice records the cascade root");
        const eNotice = h.inbox(E).at(-1)!;
        assert.match(eNotice.label, /CANCELED/, 'E (descendant) reads the CANCELED notice');
        assert.equal(eNotice.data?.['cascade_root'], B, "E notice records B as the cascade root");
      }
    } finally {
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
