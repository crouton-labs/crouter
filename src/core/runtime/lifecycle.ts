// lifecycle.ts — the node status×intent state machine.
//
// ONE place defines which (status, intent) moves are legal and enacts them.
// Before this, ~a dozen scattered setStatus()/setIntent() pairs across
// reset/close/revive/feed/daemon/stophook/queue/promote re-derived the lifecycle
// by hand, with no shared definition of "what move is legal." Here the legal
// transition TABLE is the definition, and `transition(id, event)` is the single
// writer of status+intent: it validates the from-status, then writes both fields
// in ONE atomic statement (built on Phase 2's WAL'd row setters) so the two can
// never disagree.
//
// This mirrors persona.ts: persona.ts is the single source of transition PROSE;
// lifecycle.ts is the single source of which status/intent move is LEGAL. Two
// parallel, legible state machines instead of scattered enactment.
//
// Crash-safety invariant (was a comment repeated in reset/close/reapDescendants):
// "flip status to a non-supervised value + clear intent BEFORE killing the
// host" (tmux pane or headless broker) — the daemon only ever revives
// active|idle nodes, so a teardown must
// leave the node done/canceled first to close the revive race. That invariant is
// now the DEFINITION of the `cancel` event: callers flip via transition()
// and only THEN tear the host down.
//
// Unification (A5, human-confirmed 2026-06-06): an externally-reaped node — torn
// down because the user moved on (close cascade) OR because a root reset/relaunch
// superseded it — ends `canceled`, NOT `done`. `done` is reserved for a node that
// finished its OWN work (finalize). The old `reap` event (→ done) was identical to
// `cancel` in every field and side effect once unified on status, so it was
// COLLAPSED into `cancel`; reset.ts's reapDescendants + relaunchRoot park-old now
// route through `cancel`.
//
// Layering note: lifecycle.ts is runtime, but it is the canvas write surface's
// `transition` verb (the only writer of status+intent), so it owns its atomic
// row UPDATE directly via openDb — the one sanctioned exception to "only
// canvas.ts touches the db" (see canvas/CLAUDE.md), exactly as db.ts's backfill
// is the sanctioned exception for a data migration.

import { openDb, getNode, cancelWakesFor, cancelSelfAlarms } from '../canvas/index.js';
import type { NodeMeta, NodeStatus, ExitIntent } from '../canvas/types.js';

/** The lifecycle events — the only vocabulary for moving a node's status/intent.
 *  Each maps (in the table below) to a target status and/or intent plus the set
 *  of from-statuses it is legal from. */
export type LifecycleEvent =
  | 'finalize'  // → done, intent='done'       (push --final / job complete / clean quit)
  | 'cancel'    // → canceled, intent cleared    (node close cascade · reapDescendants · relaunch park-old)
  | 'crash'     // → dead, intent unchanged      (daemon: engine container gone, no yield/release)
  | 'yield'     // intent='refresh', status unchanged (requestYield / relaunch new-node safety net)
  | 'release'   // → idle, intent='idle-release'       (idle-release: free the host, wake on inbox)
  | 'revive'    // → active, intent cleared      (reviveNode / resetRoot / boot-confirm clear)
  | 'boot';     // → active, intent unchanged    (reviveInPlace: re-exec in place, keep the refresh net)

/** One row of the transition table. A PRESENT `status`/`intent` key (even an
 *  explicit `null`) means "write this field"; an ABSENT key means "leave this
 *  field unchanged". `from` is the set of statuses the event is legal from
 *  (`'*'` = legal from any status — a forced teardown/revival). */
interface TransitionSpec {
  status?: NodeStatus;
  intent?: ExitIntent;
  from: readonly NodeStatus[] | '*';
}

const ANY = '*' as const;
/** The supervised statuses — a live node the daemon watches. */
const LIVE: readonly NodeStatus[] = ['active', 'idle'];

/** The legal transition table — derived directly from the (status, intent) pairs
 *  the runtime actually wrote at its audited call sites, so behavior is preserved
 *  by construction. Each entry's comment names its writer(s). */
const TRANSITIONS: Readonly<Record<LifecycleEvent, TransitionSpec>> = {
  // feed.push(final) · queue.cancelJob · markCleanExitDone (clean quit).
  finalize: { status: 'done', intent: 'done', from: LIVE },
  // closeNode cascade · reapDescendants · relaunchRoot park-old. Forced teardown
  // of a node that did NOT finish its own work → canceled, intent cleared. (A5:
  // done is reserved for finalize; every external reap unifies on canceled.)
  cancel: { status: 'canceled', intent: null, from: ANY },
  // daemon superviseTick: engine container gone (tmux pane or broker process)
  // with no yield/release intent. Intent KEPT (the dead log line still reports it).
  crash: { status: 'dead', from: LIVE },
  // requestYield · relaunchRoot new-node safety net. Status KEPT (already active).
  yield: { intent: 'refresh', from: LIVE },
  // stophook idle-release: free the host, stay woken by the inbox.
  release: { status: 'idle', intent: 'idle-release', from: LIVE },
  // reviveNode · resetRoot · stophook boot-confirm (clear a pending refresh net).
  revive: { status: 'active', intent: null, from: ANY },
  // reviveInPlace: re-exec a fresh pi in the SAME pane. Status (re)affirmed
  // active; intent KEPT so a pending refresh survives as proof-of-boot until the
  // fresh pi's session_start clears it (a premature clear is how a failed
  // respawn became a silent death — see revive.ts).
  boot: { status: 'active', from: LIVE },
};

/** Enact a lifecycle event on a node: validate the from-status against the
 *  table, then write status+intent in ONE atomic statement (so they can never
 *  disagree). Returns the hydrated node view after the write.
 *
 *  Throws on an unknown node, or on an ILLEGAL move (e.g. `finalize` on a `dead`
 *  node) — illegal states are unrepresentable. The throw is a real signal:
 *  callers that previously swallowed db-mutation errors now surface them. */
export function transition(nodeId: string, event: LifecycleEvent): NodeMeta {
  const spec = TRANSITIONS[event];
  const cur = getNode(nodeId);
  if (cur === null) throw new Error(`transition: unknown node ${nodeId}`);
  if (spec.from !== ANY && !spec.from.includes(cur.status)) {
    throw new Error(
      `illegal lifecycle transition: '${event}' from status='${cur.status}' (node ${nodeId})`,
    );
  }

  const writeStatus = Object.prototype.hasOwnProperty.call(spec, 'status');
  const writeIntent = Object.prototype.hasOwnProperty.call(spec, 'intent');
  const db = openDb();
  if (writeStatus && writeIntent) {
    db.prepare('UPDATE nodes SET status = ?, intent = ? WHERE node_id = ?')
      .run(spec.status as string, spec.intent ?? null, nodeId);
  } else if (writeStatus) {
    db.prepare('UPDATE nodes SET status = ? WHERE node_id = ?').run(spec.status as string, nodeId);
  } else if (writeIntent) {
    db.prepare('UPDATE nodes SET intent = ? WHERE node_id = ?').run(spec.intent ?? null, nodeId);
  }

  // Wakeups cleanup — writes a DIFFERENT table (wakeups) AFTER the atomic
  // status/intent write above, so the single-(status,intent)-writer rule holds.
  // Event-gated; exactly ONE delegated wakeups helper per event, never inline
  // wakeups SQL here (design §6.7 / D2 / D6, Q1/Q2):
  //   cancel   → cancelWakesFor: reap node-anchored AND owner-armed detached
  //              wakes this node armed (ruling A) — covers all three cancel
  //              sites uniformly (close cascade · reapDescendants · relaunch
  //              park-old).
  //   finalize → cancelSelfAlarms: clear this node's one-shot self-alarms only;
  //              node-anchored declarative crons SURVIVE a finishing instance (Q1).
  //   crash    → NOTHING. A fault is not a deliberate end-of-waiting; self-alarms
  //              and crons MUST survive instance death (D2 / Invariant E / AC-R3).
  if (event === 'cancel') cancelWakesFor(nodeId);
  else if (event === 'finalize') cancelSelfAlarms(nodeId);

  return getNode(nodeId) as NodeMeta;
}
