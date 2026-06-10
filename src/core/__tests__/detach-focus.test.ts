// Run with: node --import tsx/esm --test src/core/__tests__/detach-focus.test.ts
//
// GAP CLOSE (flagship-lifecycle.test.ts coverage boundary): "node demote
// --detach (A3: orphaned-focus-row hazard)". An END-TO-END test that drives the
// REAL `crtr node demote --detach` verb (subprocess, AS the node) — the actual
// Alt+C → D menu path — against a live fake-pi node genuinely FOCUSED in a user
// viewport, and
// proves the three things the A3 hazard is about:
//   (a) lifecycle flips terminal IN PLACE,
//   (b) the still-running pi's pane is RELOCATED to the backstage crtr session
//       (the pi keeps generating off-screen, not killed),
//   (c) the focus row it occupied is CLOSED — no orphaned/phantom viewport row
//       lingering on the relocated %pane_id (Invariant P / Invariant F5).
//
// This is the harness-driven counterpart to placement-focus.test.ts's
// `detachToBackground` unit (which calls the function directly): here the FLIP
// and the detach both go through the real CLI leaf (node.ts nodeDemote →
// setLifecycle), so the whole `crtr node demote --detach` wiring — the Alt+C → D
// menu path — is exercised. Modeled on live-mutation.test.ts (harness +
// `crtr node demote` + firstPaneOf) and
// placement-focus.test.ts (user/back sessions + focus-row asserts).
//
// NOTE — the SIBLING focused-finish→manager-TAKEOVER path is NOT added here: the
// harness mints its root via in-process createNode (never a real bootRoot — see
// flagship S1), so a manager is always a paneless, never-booted row. Driving B
// through agent_end's done-branch (h.finish) with such a manager would only ever
// hit handFocusToManager's "live-but-paneless inline root → false" guard
// (closeFocusToShell), never a genuine takeover; a LIVE-backstage or dormant
// idle-release manager swap is unreachable through the harness. That swap is
// unit-covered in placement-teardown.test.ts (MAJOR 1 + the dormant idle-release
// case), so it is deliberately not re-driven here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { setPresence, getNode } from '../canvas/canvas.js';
import { openFocusRow, getFocusByNode, getFocusByPane, listFocuses } from '../canvas/focuses.js';
import { closeDb } from '../canvas/db.js';
import { markBusy } from '../runtime/busy.js';

const SKIP = !hasTmux() ? 'tmux unavailable' : false;

function sessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}
function tmuxOut(args: string[]): string {
  return (spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? '').trim();
}
/** The first %pane_id of a tmux window (spawn records window+session, not pane). */
function firstPaneOf(window: string): string | null {
  const r = spawnSync('tmux', ['list-panes', '-t', window, '-F', '#{pane_id}'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null;
}
/** A pane's CURRENT session/window (display-message on its durable %id). */
function paneLoc(pane: string): { session: string; window: string } | null {
  const out = tmuxOut(['display-message', '-p', '-t', pane, '#{session_name}\t#{window_id}']);
  const [session, window] = out.split('\t');
  if (!session || !window) return null;
  return { session, window };
}
function paneSessionReal(pane: string): string {
  return tmuxOut(['display-message', '-p', '-t', pane, '#{session_name}']);
}
function paneExistsReal(pane: string): boolean {
  return tmuxOut(['display-message', '-p', '-t', pane, '#{pane_id}']) === pane;
}

// ===========================================================================
// `crtr node demote --detach` on a FOCUSED node (A3 gap close; Alt+C → D).
// ===========================================================================
test(
  'node demote --detach on a FOCUSED node: flips terminal, relocates the pane to the backstage, CLOSES the focus row (A3 — no orphaned focus row)',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-detach-focus' });
    const user = `crtr-detach-user-${process.pid}-${Date.now().toString(36)}`;
    try {
      // A resident root + a live terminal child B (born into the backstage =
      // h.session, the harness's CRTR_NODE_SESSION). B holds an active live sub
      // to nothing extra — it just needs to be a live, focusable terminal node.
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      const b0 = h.node(B)!;
      assert.equal(b0.lifecycle, 'terminal', 'B born terminal');
      assert.equal(b0.status, 'active', 'B active after boot');

      // Resolve B's live %pane_id from its window (the spawn path records only
      // window+session; pane is null until a reconcile/focus).
      const bPane = firstPaneOf(b0.window!);
      assert.ok(typeof bPane === 'string' && bPane !== '', 'B has a live pane');

      // --- Put B into a USER viewport, FOCUSED. Create a separate user session
      //     and break B's live pi pane out into it (the pi keeps running; the
      //     %id survives the break), then anchor its presence + open a focus row.
      //     This is the genuine "focused in a user pane" precondition — distinct
      //     from the backstage (h.session) the detach will relocate it back to.
      spawnSync('tmux', ['new-session', '-d', '-s', user, '-c', '/tmp', 'sleep 600'], { stdio: 'ignore' });
      assert.equal(
        spawnSync('tmux', ['break-pane', '-d', '-a', '-s', bPane!, '-t', `${user}:`]).status,
        0,
        'B pane broke out into the user viewport (pi kept alive)',
      );
      const moved = paneLoc(bPane!);
      assert.equal(moved?.session, user, 'B pane physically in the user session now');
      assert.equal(paneExistsReal(bPane!), true, "B's pi is still alive after the move");
      closeDb();
      setPresence(B, { pane: bPane!, tmux_session: user, window: moved!.window });
      openFocusRow('f-detach', bPane!, user, B);
      assert.equal(getFocusByNode(B)?.focus_id, 'f-detach', 'precondition: B is FOCUSED in the user viewport');
      // B must read as GENERATING for the backstage-park path: isGenerating now
      // gates the break-pane (Bug 1 / Invariant P) on the mid-turn busy marker
      // AND a live pi_pid. The boot only recorded pi_pid (session_start); no turn
      // fired, so set the busy marker to model an agent genuinely mid-turn —
      // otherwise the new gate would RELEASE B (the non-generating path below).
      markBusy(B);

      // --- Drive the REAL verb on the FOCUSED node. The subprocess inherits
      //     CRTR_NODE_SESSION = h.session (the backstage), so detachToBackground
      //     breaks the pane back into h.session.
      const res = h.cli(B, ['node', 'demote', '--node', B, '--pane', bPane!, '--detach']);
      assert.equal(res.code, 0, `node demote --detach exit 0\n${res.stderr}`);
      assert.match(res.stdout, /relocated to the background/, `the agent was detached\n${res.stdout}`);

      closeDb();
      const b = getNode(B)!;
      // (a) lifecycle flipped to terminal IN PLACE.
      assert.equal(b.lifecycle, 'terminal', '(a) B lifecycle=terminal after the flip');
      assert.equal(b.status, 'active', "(a) detach does NOT end the pi — B stays active");

      // (b) the still-running pane was RELOCATED to the backstage crtr session
      //     (NOT killed): the pi keeps generating off-screen.
      assert.equal(paneExistsReal(bPane!), true, "(b) B's pi keeps generating (pane alive, relocated not killed)");
      assert.equal(paneSessionReal(bPane!), h.session, '(b) B pane relocated to the backstage crtr session');
      assert.equal(b.tmux_session, h.session, "(b) B's LOCATION followed the pane to the backstage");

      // (c) the focus row is CLOSED — no orphaned/phantom viewport (A3 hazard).
      assert.equal(getFocusByNode(B), null, '(c) B no longer occupies any focus (row CLOSED — Invariant P)');
      assert.equal(getFocusByPane(bPane!), null, '(c) NO phantom focus resolves on the relocated %id');
      assert.equal(listFocuses().length, 0, '(c) no dangling focus rows remain');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', user], { stdio: 'ignore' });
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);

// ===========================================================================
// Bug 1 (Invariant P / detach-idle-node): `crtr node demote --detach` on a
// NON-GENERATING focused node must NOT park it alive in the backstage — it must
// be RELEASED to dormant and its pane reaped.
//
// The backstage holds ONLY generating-but-unfocused nodes (Invariant P).
// detachToBackground used to break-pane to the backstage UNCONDITIONALLY, with no
// generating-ness check: a resident root parked idle between turns (pi alive,
// idle, NOT mid-turn) detached via Alt+C → D became unfocused + pi-alive-idle +
// holding a backstage pane forever — nothing re-enters agent_end to release it
// and, with no live subscription, nothing wakes it → a leaked live-idle pi that
// never reaps. The fix gates the break-pane on isGenerating() and RELEASES a
// non-generating node to dormant instead (mirrors retargetFocus's parked-viewer
// release on focus-away).
//
// This drives the SAME real verb as the happy-path test above, but on a node
// with NO busy marker (not mid-turn). isGenerating() = busy && pidAlive, so a
// freshly-booted node (pi_pid recorded at session_start, no turn fired) reads as
// NOT generating.
// ===========================================================================
test(
  'node demote --detach on a NON-GENERATING focused node: RELEASES to dormant (idle + idle-release), reaps the pane, closes the focus row — NOT parked in the backstage (Bug 1 — Invariant P)',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const h: Harness = await createHarness({ sessionPrefix: 'crtr-detach-idle' });
    const user = `crtr-detach-idle-user-${process.pid}-${Date.now().toString(36)}`;
    try {
      // A resident root + a live terminal child B. B is freshly booted: pi alive
      // (pi_pid recorded at session_start), status active, and — critically — NO
      // busy marker, since no turn ever fired. It is parked idle, not mid-turn:
      // exactly the non-generating occupant Bug 1 is about.
      const A = h.spawnRoot('resident root');
      const B = await h.spawnChild(A, 'do the work', { kind: 'developer' });
      const b0 = h.node(B)!;
      assert.equal(b0.status, 'active', 'B active after boot');

      const bPane = firstPaneOf(b0.window!);
      assert.ok(typeof bPane === 'string' && bPane !== '', 'B has a live pane');

      // --- Put B into a USER viewport, FOCUSED (same precondition as the happy
      //     path), but DO NOT mark it busy: it stays NOT generating.
      spawnSync('tmux', ['new-session', '-d', '-s', user, '-c', '/tmp', 'sleep 600'], { stdio: 'ignore' });
      assert.equal(
        spawnSync('tmux', ['break-pane', '-d', '-a', '-s', bPane!, '-t', `${user}:`]).status,
        0,
        'B pane broke out into the user viewport (pi kept alive)',
      );
      const moved = paneLoc(bPane!);
      assert.equal(moved?.session, user, 'B pane physically in the user session now');
      assert.equal(paneExistsReal(bPane!), true, "B's pi is alive (parked idle, not mid-turn)");
      closeDb();
      setPresence(B, { pane: bPane!, tmux_session: user, window: moved!.window });
      openFocusRow('f-detach-idle', bPane!, user, B);
      assert.equal(getFocusByNode(B)?.focus_id, 'f-detach-idle', 'precondition: B is FOCUSED, NON-generating');

      // --- Drive the REAL verb on the non-generating focused node.
      const res = h.cli(B, ['node', 'demote', '--node', B, '--pane', bPane!, '--detach']);
      assert.equal(res.code, 0, `node demote --detach exit 0\n${res.stderr}`);
      assert.match(res.stdout, /relocated to the background/, `the agent was detached\n${res.stdout}`);

      closeDb();
      const b = getNode(B)!;
      // (b) RELEASED to dormant — idle + intent='idle-release' (revivable via inbox
      //     / re-focus), NOT left active in the backstage.
      assert.equal(b.status, 'idle', '(b) B released to dormant (status idle)');
      assert.equal(b.intent, 'idle-release', "(b) B's intent is idle-release (daemon revives on inbox)");

      // (c) the pane is REAPED / presence nulled — NOT relocated to the backstage
      //     crtr session. The leaked live-idle pi must be gone.
      assert.equal(paneExistsReal(bPane!), false, '(c) B pane reaped (NOT parked alive in the backstage)');
      assert.equal(b.pane, null, "(c) B's presence pane is nulled");
      assert.equal(b.tmux_session, null, "(c) B's presence session is nulled (NOT the backstage crtr session)");

      // (a) the focus row is CLOSED — no orphaned/phantom viewport.
      assert.equal(getFocusByNode(B), null, '(a) B no longer occupies any focus (row CLOSED — Invariant P)');
      assert.equal(getFocusByPane(bPane!), null, '(a) NO phantom focus resolves on the reaped %id');
      assert.equal(listFocuses().length, 0, '(a) no dangling focus rows remain');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', user], { stdio: 'ignore' });
      const session = h.session;
      await h.dispose();
      assert.equal(sessionExists(session), false, 'isolated session killed — no stray');
    }
  },
);
