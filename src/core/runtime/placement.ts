// placement.ts — the Placement MODEL layer (Steps 3–5).
//
// Above tmux.ts (the Surface/driver), below the daemon and the runtime ops. This
// is the first module under the §2.1 rule: "only placement.ts / tmux-chrome.ts
// import the tmux driver." (The import-lint is warn-only until Step 8, so the
// other direct importers staying is fine for now.)
//
// Responsibilities, all keyed on the durable tmux `%pane_id` (§1.2/§2.4, Q6):
//
//   • reconcile(nodeId)       — resolve a node's CURRENT window/session from its
//                               durable pane id and FOLLOW any manual move; null
//                               the LOCATION when the pane is truly gone; lazily
//                               backfill a legacy row's pane from its live window.
//   • reconcileFocus(focusId) — the focus-row analogue: follow a manual move of a
//                               FOCUS pane so a resume-into-focus lands in its
//                               CURRENT session (§2.4, Q4).
//   • isNodePaneAlive(row)    — the primary, PURE liveness probe: pane-existence
//                               (window-existence only as a legacy/no-pane fallback).
//   • reviveIntoPlacement     — Step 5 (§1.4): THE bug-kill. The single decision
//     (+ reviveTarget, pure)    that replaces revive.ts's blind new-window into
//                               `meta.tmux_session`: a node on a live focus resumes
//                               IN PLACE in that pane; otherwise it opens a window
//                               in its home_session ONLY (never a user session).
//
// The robustness contract: a manual `move-pane`/`join-pane`/`break-pane` must
// NEVER read as a node death. Liveness is pane-existence, not window-existence,
// and reconcile makes crtr follow a move instead of fighting it.

import {
  getRow,
  getRowByPane,
  getNode,
  setPresence,
  openDb,
  openFocusRow,
  setFocusOccupant,
  closeFocusRow,
  getFocusByNode,
  getFocusByPane,
  getFocusById,
  setFocusPane,
  listFocuses as listFocusRows,
  type NodeRow,
  type FocusRow,
} from '../canvas/index.js';
import {
  paneExists,
  paneLocation,
  paneOfWindow,
  windowAlive,
  windowOfPane,
  ensureSession,
  openNodeWindow,
  respawnPaneSync,
  respawnPaneDetached,
  breakPaneToSession,
  nodeSession,
  splitWindow,
  swapPaneInPlace,
  setRemainOnExit,
  closePane,
  currentTmux,
  joinPane,
  selectLayout,
  setWindowOption,
  switchClient,
  selectWindow,
} from './tmux.js';
import { homeSessionOf, newNodeId } from './nodes.js';
import { setFocus, getFocus } from './presence.js';

// Re-export the durable REVIVE-HOME read so placement is the one front door for
// "where does this node live." Step 1 put the implementation in nodes.ts; the
// presence.ts→placement.ts consolidation (Steps 6/8) is where it physically
// moves — until then placement just re-exports it (no churn).
export { homeSessionOf };
export type { FocusRow };

// ---------------------------------------------------------------------------
// Focus reads (Step 4) — COMPOSE over the canvas focuses table (§2.3/§4).
//
// placement is the front door for "which nodes are on a viewport"; the SQL lives
// in the canvas layer (canvas/focuses.ts) and placement just reads it, the same
// way it composes setPresence. A node occupies at most one focus (UNIQUE
// node_id, Q5), so focusOf returns a single row.
//
// NOTE on openFocus: §2.3/§4 list `openFocus` (split-window + setRemainOnExit +
// openFocusRow) under Step 4, but it is NOT CALLED until Step 6 (root-boot focus
// #1 + `node focus --new-pane`). The tmux-composing half is therefore DEFERRED
// to Step 6; Step 4 ships only the canvas setter `openFocusRow` + these reads +
// the focus.ptr dual-write bridge (presence.ts). retargetFocus /
// reviveIntoPlacement are likewise Steps 5/6, not here.
// ---------------------------------------------------------------------------

/** The focus a node occupies, or null. UNIQUE(node_id) ⇒ at most one. */
export function focusOf(nodeId: string): FocusRow | null {
  return getFocusByNode(nodeId);
}

/** Is this node on a viewport? */
export function isFocused(nodeId: string): boolean {
  return getFocusByNode(nodeId) !== null;
}

/** The focus realized by a given pane (`%id`), or null. */
export function focusByPane(pane: string): FocusRow | null {
  return getFocusByPane(pane);
}

/** The set of node ids currently on some focus. */
export function focusedNodes(): Set<string> {
  return new Set(listFocusRows().map((f) => f.node_id));
}

/** Every focus row (every live viewport). */
export function listFocuses(): FocusRow[] {
  return listFocusRows();
}

// ---------------------------------------------------------------------------
// Reconciliation — never fight a manual pane move (§2.4, Q6)
// ---------------------------------------------------------------------------

/** The cached LOCATION as stored on a node row: the authoritative `pane` handle
 *  plus its derived window/session cache. */
export interface CachedLocation {
  pane: string | null;
  tmux_session: string | null;
  window: string | null;
}

/** What `reconcile` resolved from tmux for the cached location. The shell does
 *  the two driver reads; the pure decision interprets them.
 *    - `paneLoc`: `paneLocation(cached.pane)` — the pane's CURRENT session/window,
 *      or null when the pane is gone. Only meaningful when `cached.pane != null`.
 *    - `windowPane`: `paneOfWindow(cached.tmux_session, cached.window)` — the live
 *      window's active pane, for the legacy backfill case (`cached.pane == null`). */
export interface LiveProbe {
  paneLoc: { session: string; window: string } | null;
  windowPane: string | null;
}

/** The presence patch `reconcile` should write, or `{ kind: 'none' }` for a no-op.
 *    - `none`     — the cache already matches reality (or there's nothing to do).
 *    - `gone`     — the durable pane is gone → null the whole LOCATION.
 *    - `follow`   — the pane moved (user move) → re-point the cache at its new
 *                   window/session, keeping the same pane id.
 *    - `backfill` — a legacy row had no pane but a live window → adopt the
 *                   window's active pane as the durable handle (begins populating
 *                   `pane` for pre-existing nodes). */
export type ReconcileDecision =
  | { kind: 'none' }
  | { kind: 'gone' }
  | { kind: 'follow'; pane: string; tmux_session: string; window: string }
  | { kind: 'backfill'; pane: string; tmux_session: string; window: string };

/** PURE reconciliation decision (§2.4) — unit-testable without a live tmux.
 *  Given the cached row LOCATION and what tmux currently reports, decide the
 *  presence patch. Mirrors the pure-core/impure-shell split (cf. `livenessVerdict`
 *  vs `handleLiveWindow`): this is the decision, `reconcile` wires it to the
 *  driver reads + `setPresence`. */
export function reconcileDecision(cached: CachedLocation, live: LiveProbe): ReconcileDecision {
  if (cached.pane == null) {
    // Legacy / no-pane row: lazily backfill the durable pane from the live
    // window's active pane. Requires a complete, live window to anchor on.
    if (cached.tmux_session != null && cached.window != null && live.windowPane != null) {
      return {
        kind: 'backfill',
        pane: live.windowPane,
        tmux_session: cached.tmux_session,
        window: cached.window,
      };
    }
    return { kind: 'none' };
  }

  // Pane-anchored row: resolve the pane's CURRENT location.
  if (live.paneLoc === null) {
    // The pane itself is gone — the node's pane truly closed. Null the LOCATION.
    return { kind: 'gone' };
  }
  if (live.paneLoc.session !== cached.tmux_session || live.paneLoc.window !== cached.window) {
    // The pane drifted (a manual move-pane/join-pane/break-pane). FOLLOW it:
    // same pane id, new derived window/session.
    return {
      kind: 'follow',
      pane: cached.pane,
      tmux_session: live.paneLoc.session,
      window: live.paneLoc.window,
    };
  }
  // Cache already matches the pane's reality.
  return { kind: 'none' };
}

/** Reconcile a node's LOCATION against tmux reality (§2.4) — the impure shell.
 *  Reads `row.pane`, resolves its CURRENT session/window via the driver, and
 *  writes the resulting presence patch through `setPresence` (never a raw UPDATE):
 *    - pane moved   → FOLLOW (re-point window/session, keep the pane id)
 *    - pane gone    → null the whole LOCATION
 *    - legacy/no pane + live window → backfill the pane from `paneOfWindow`
 *  A no-op when there's nothing to resolve (genuinely no pane, or the cache is
 *  already current). Call this before any swap/kill/focus/revive so the act lands
 *  on the pane's current window, never a stale one. */
export function reconcile(nodeId: string): void {
  const row = getRow(nodeId);
  if (row === null) return;

  const cached: CachedLocation = {
    pane: row.pane,
    tmux_session: row.tmux_session,
    window: row.window,
  };

  // Only the read the decision needs: paneLocation when anchored on a pane, else
  // paneOfWindow for the legacy backfill. Skip the driver call that can't apply.
  const paneLoc = cached.pane != null ? paneLocation(cached.pane) : null;
  const windowPane =
    cached.pane == null && cached.tmux_session != null && cached.window != null
      ? paneOfWindow(cached.tmux_session, cached.window)
      : null;

  const decision = reconcileDecision(cached, { paneLoc, windowPane });
  switch (decision.kind) {
    case 'none':
      return;
    case 'gone':
      setPresence(nodeId, { pane: null, tmux_session: null, window: null });
      return;
    case 'follow':
    case 'backfill':
      setPresence(nodeId, {
        pane: decision.pane,
        tmux_session: decision.tmux_session,
        window: decision.window,
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Focus reconciliation — follow a manual move of a FOCUS pane (§2.4, Q4)
// ---------------------------------------------------------------------------

/** Reconcile a FOCUS's derived `session` cache against tmux reality (§2.4, Q4) —
 *  the focus-row analogue of `reconcile`. A focus is anchored on its durable
 *  `%pane_id`; `session` is a derived cache. If the user moved the focus pane to
 *  another session, re-point the cache so a resume-into-focus lands in the pane's
 *  CURRENT session. A no-op when the focus has no pane, the cache is already
 *  current, or the pane is GONE — in the gone case reconcileFocus does NOT null
 *  the row; the caller (reviveIntoPlacement) instead falls to the backstage
 *  branch via `paneExists(pane)` being false. */
export function reconcileFocus(focusId: string): void {
  const f = getFocusById(focusId);
  if (f === null || f.pane === null) return;
  const live = paneLocation(f.pane);
  if (live === null) return; // pane gone — backstage fall-through handles it
  if (live.session !== f.session) {
    setFocusPane(f.focus_id, f.pane, live.session);
  }
}

// ---------------------------------------------------------------------------
// Liveness — pane-existence (§1.2, Q6)
// ---------------------------------------------------------------------------

/** Is this node's pane (its LOCATION) alive? The v3 PRIMARY liveness probe,
 *  PURE / non-mutating so the daemon can gate on it without side effects:
 *    - `pane != null`  → `paneExists(pane)` (display-message on the `%id`), so a
 *      user moving the pane to another window/session never reads as "gone".
 *    - `pane == null`  → window-keyed FALLBACK (`windowAlive`) for legacy/no-pane
 *      rows that haven't been backfilled yet.
 *  Accepts a node id (re-reads the row) or a `NodeRow` already in hand. */
export function isNodePaneAlive(node: string | NodeRow): boolean {
  const row = typeof node === 'string' ? getRow(node) : node;
  if (row === null) return false;
  return row.pane != null
    ? paneExists(row.pane)
    : windowAlive(row.tmux_session, row.window);
}

// ---------------------------------------------------------------------------
// Placement-aware revive (§1.4, Step 5) — THE bug-kill surface
// ---------------------------------------------------------------------------

/** The launch recipe `reviveIntoPlacement` plays into a pane. `command` is the
 *  full shell string (`piCommand(argv)`); `env`/`cwd`/`name` describe the
 *  window/pane; `resuming` is carried through for the caller's ReviveResult. */
export interface ReviveLaunch {
  command: string;
  env: Record<string, string>;
  cwd: string;
  name: string;
  resuming: boolean;
}

/** Where a revive physically landed: the new/derived window, the session it ran
 *  in, and the durable pane id. */
export interface PlacementResult {
  window: string | null;
  session: string;
  pane: string | null;
}

/** The PURE revive-target decision (§1.4/§5.1) — THE assertion that the
 *  "unbidden windows" bug is structurally dead. Given a node's focus (or null),
 *  whether that focus's pane is still alive, and the node's durable REVIVE-HOME
 *  (`home_session`), decide WHERE a revive must land:
 *    - occupies a LIVE focus → resume IN PLACE in that focus pane (no new window).
 *    - otherwise             → a new window in `homeSession`, and NOTHING ELSE.
 *
 *  The backstage branch's session is `homeSession` ONLY — never
 *  `meta.tmux_session`, the field focus taints to a user session. For a
 *  post-Step-1 child `homeSession` is the backstage `crtr` (never a user
 *  session), so a non-focused child — INCLUDING a once-focused-now-unfocused
 *  child whose `tmux_session` was tainted — can NEVER revive into a user session.
 *  A root's `homeSession` is its own session, so reviving a root into its own
 *  session is correct, not the bug. */
export type ReviveTargetDecision =
  | { kind: 'focus-pane'; pane: string; session: string }
  | { kind: 'backstage'; session: string };

export function reviveTarget(
  focus: FocusRow | null,
  focusPaneAlive: boolean,
  homeSession: string,
): ReviveTargetDecision {
  if (focus !== null && focus.pane !== null && focusPaneAlive) {
    return { kind: 'focus-pane', pane: focus.pane, session: focus.session ?? homeSession };
  }
  return { kind: 'backstage', session: homeSession };
}

/** Place a reviving node into its CORRECT location (§1.4) — the single decision
 *  that replaces revive.ts's old `session = meta.tmux_session ?? nodeSession()` +
 *  `openNodeWindow`. Reconcile first (§2.4), then dispatch on `reviveTarget`:
 *    - the node occupies a LIVE focus → `reconcileFocus` (resolve the pane's
 *      CURRENT session, Q4) and `respawn-pane -k` the pi INTO that focus pane —
 *      no new window (F3 resume-in-place).
 *    - otherwise → the node is NOT focused (or its focus pane already collapsed,
 *      the Step-5 limitation: remain-on-exit lands in Step 6), so it may ONLY
 *      (re)appear in its durable REVIVE-HOME: a fresh window in `homeSession`.
 *      **There is NO code path here by which a non-focused node's new-window
 *      targets a user session** — `openNodeWindow`'s session is `homeSession` and
 *      nothing else. That is the structural bug-kill.
 *
 *  `setPresence` (the one atomic LOCATION write) records where the node landed.
 *  CRTR_ROOT_SESSION is forced to `homeSession` in BOTH branches so the node's
 *  children always flow to the backstage, never into the focus session. */
export function reviveIntoPlacement(nodeId: string, launch: ReviveLaunch): PlacementResult {
  // §2.4 — follow any manual pane move before acting.
  reconcile(nodeId);

  const focus = focusOf(nodeId);
  const focusPaneAlive = focus !== null && focus.pane !== null && paneExists(focus.pane);
  const homeSession = homeSessionOf(nodeId);
  const decision = reviveTarget(focus, focusPaneAlive, homeSession);

  // The node's children always spawn into the backstage (homeSession), never the
  // focus session — force it regardless of which branch the node itself takes.
  const env = { ...launch.env, CRTR_ROOT_SESSION: homeSession };

  if (decision.kind === 'focus-pane') {
    // F3: resume the pi INTO the live focus pane, in its CURRENT session (Q4 —
    // reconcileFocus follows a user move of the focus pane). No new window.
    reconcileFocus(focus!.focus_id);
    const f = focusOf(nodeId) ?? focus!;
    const pane = f.pane!;
    respawnPaneSync({ pane, cwd: launch.cwd, env, command: launch.command });
    const window = windowOfPane(pane);
    const session = f.session ?? homeSession;
    setPresence(nodeId, { pane, tmux_session: session, window });
    return { window, session, pane };
  }

  // Backstage branch — the ONLY new-window target is `homeSession` (the
  // backstage `crtr` for a child). A non-focused node has NO path to a user
  // session here: the bug is structurally unreachable.
  const session = decision.session; // === homeSession
  ensureSession(session, launch.cwd);
  const opened = openNodeWindow({
    session,
    name: launch.name,
    cwd: launch.cwd,
    env,
    command: launch.command,
  });
  const window = opened?.window ?? null;
  const pane = opened?.pane ?? null;
  setPresence(nodeId, { pane, window, tmux_session: session });
  return { window, session, pane };
}

// ---------------------------------------------------------------------------
// Detach to background — send a still-running agent off the foreground pane into
// the backstage `crtr` session WITHOUT ending it (the `node lifecycle --detach`
// / Alt+C → D half).
// ---------------------------------------------------------------------------

/** Relocate a node's still-running agent to the background `crtr` session,
 *  freeing the foreground pane WITHOUT killing the pi. `break-pane` moves the
 *  pane out of the foreground window into a fresh window in the shared backstage
 *  (the pi keeps generating); the node becomes a background window — switchable
 *  but not rendered, like any other node. Reconcile first (act on the pane's
 *  CURRENT location, §2.4) and again after (presence FOLLOWS the move). No-op
 *  (false) when there is no live pane to relocate or tmux refuses the break.
 *  `pane` is the authoritative node pane the caller acts on (the Alt+C menu's
 *  `#{pane_id}`); falls back to the node's durable handle. */
export function detachToBackground(nodeId: string, pane?: string): boolean {
  reconcile(nodeId);
  const row = getRow(nodeId);
  if (row === null) return false;
  const target = pane ?? row.pane;
  if (target === null || !paneExists(target)) return false;
  // Anchor the durable handle on the pane we relocate so the post-move reconcile
  // follows the right pane.
  if (row.pane !== target) setPresence(nodeId, { pane: target });
  const session = nodeSession();
  ensureSession(session, row.cwd);
  const ok = breakPaneToSession(target, session);
  reconcile(nodeId); // presence now points at the crtr window
  return ok;
}

// ---------------------------------------------------------------------------
// Focus placement verbs (§2.3/§2.5, Step 6) — the hot-swap + the openers. These
// are the ONLY way a focus's occupant changes (retargetFocus) or a new viewport
// pane appears in a user session (openFocus). The front door `focus` resolves
// which focus a `node focus`/`cycle` acts on, then retargets it.
// ---------------------------------------------------------------------------

/** A reviver: resume a DORMANT node into its backstage placement (a fresh `crtr`
 *  window via reviveIntoPlacement). Injected so placement.ts need not import
 *  revive.ts (which imports placement.ts — a cycle). The node's landed pane is
 *  read back from its row afterwards. */
export type Reviver = (nodeId: string) => void;

/** Result of a focus/retarget op. */
export interface FocusResult {
  focused: boolean;
  session: string | null;
  inPlace: boolean;
  revived: boolean;
}

/** A reserved, non-node occupant for a freshly-opened viewport that has no node
 *  yet: openFocus splits a HOLDER pane, but `node_id` is NOT NULL, so the row
 *  needs a placeholder until retargetFocus swaps a real node in. retargetFocus
 *  REAPS a holder pane (getRow(holder) === null ⇒ not generating ⇒ kill) instead
 *  of backstaging it. */
function holderId(focusId: string): string {
  return `__hold_${focusId}__`;
}

function newFocusId(): string {
  return `f-${newNodeId()}`;
}

/** signal-0 liveness probe for a pi pid (mirrors the daemon's isPidAlive). */
function pidAlive(pid: number | null | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is a focus's OUTGOING occupant still GENERATING (a live pi doing work)? A
 *  still-generating node is moved to backstage by a retarget (F2 — it keeps
 *  running off-screen); a holder / done / dormant node has its pane reaped
 *  (Invariant P). A holder or vanished node (row null) is never generating. */
function isGenerating(nodeId: string): boolean {
  const row = getRow(nodeId);
  if (row === null) return false;
  if (row.status !== 'active' && row.status !== 'idle') return false;
  return pidAlive(row.pi_pid);
}

/** PURE disposition of a focus's outgoing occupant after a retarget swap (§2.5/
 *  §1.3): a still-generating node moves to backstage (F2); a holder pane or a
 *  done/dormant node has its (now-backstage) pane reaped (Invariant P: a
 *  not-focused + not-generating node has NO pane). Unit-testable in isolation. */
export type OutgoingAction = { kind: 'backstage' } | { kind: 'kill' };
export function outgoingDisposition(o: { exists: boolean; generating: boolean }): OutgoingAction {
  if (!o.exists) return { kind: 'kill' };
  return o.generating ? { kind: 'backstage' } : { kind: 'kill' };
}

/** The node's pane iff it is a LIVE pane (a generating-unfocused backstage pane,
 *  or a still-live focus pane), else null. The retarget swaps THIS pane into the
 *  viewport; null means the node is dormant and must be revived first. */
function livePinPane(nodeId: string): string | null {
  const row = getRow(nodeId);
  return row?.pane != null && paneExists(row.pane) ? row.pane : null;
}

/** remain-on-exit on a focus's viewport window (F3 freeze/resume) — best-effort. */
function armRemainOnExit(window: string | null | undefined): void {
  if (window != null && window !== '') setRemainOnExit(window, true);
}

/** Open a NEW viewport (§2.3, F4) — the ONLY path a new pane appears in a user
 *  session. Default: `splitWindow(callerPane)` beside (Q3); `newWindow` opens a
 *  fresh window in the caller pane's session instead. Arms `remain-on-exit` on
 *  the new pane's window (F3) and inserts a focuses row anchored on it, occupied
 *  by a HOLDER until retargetFocus swaps a real node in. A benign long-sleep
 *  holds the pane open until the swap; retargetFocus reaps it. Returns the row,
 *  or null if tmux failed. */
export function openFocus(callerPane: string, opts: { newWindow?: boolean } = {}): FocusRow | null {
  const HOLD = 'sleep 2147483647';
  let pane: string | null;
  let session: string | null;
  if (opts.newWindow === true) {
    const sess = paneLocation(callerPane)?.session;
    if (sess === undefined) return null;
    const opened = openNodeWindow({ session: sess, name: 'focus', cwd: process.cwd(), env: {}, command: HOLD });
    if (opened === null) return null;
    pane = opened.pane;
    session = sess;
  } else {
    pane = splitWindow(callerPane, { cwd: process.cwd(), env: {}, command: HOLD });
    if (pane === null) return null;
    session = paneLocation(pane)?.session ?? null;
  }
  armRemainOnExit(paneLocation(pane)?.window);
  const focusId = newFocusId();
  openFocusRow(focusId, pane, session, holderId(focusId));
  return getFocusById(focusId);
}

/** Register the FOREGROUND root's pane as focus #1 at boot (§2.6). The inline
 *  root owns the user's viewport, so its own pane becomes a durable focus — with
 *  `remain-on-exit` so a clean exit FREEZES the pane rather than detaching the
 *  terminal (F1). A background `--root` does NOT call this (§6): it stays a plain
 *  window until the user `node focus`es it. No-op when the pane or this node is
 *  already a focus. Mirrors focus.ptr via setFocus (the transitional bridge). */
export function registerRootFocus(
  nodeId: string,
  pane: string,
  session: string | null,
  window: string | null,
): FocusRow | null {
  const byPane = getFocusByPane(pane);
  if (byPane !== null) return byPane;
  const byNode = getFocusByNode(nodeId);
  if (byNode !== null) return byNode;
  const focusId = newFocusId();
  openFocusRow(focusId, pane, session, nodeId);
  armRemainOnExit(window);
  setFocus(nodeId);
  return getFocusById(focusId);
}

/** retargetFocus — the unified hot-swap (§2.5, Invariant P + Q5). Swap `incoming`
 *  onto focus `focusId`'s viewport, keeping the screen position invariant (no new
 *  window). One sqlite txn updates the focus row + BOTH nodes' presence:
 *    - Q5: if `incoming` already occupies ANOTHER focus, VACATE it first (close
 *      its row + kill its pane — the node MOVES here, no auto-retarget).
 *    - resolve `incoming`'s live pin pane (a backstage pane), else `revive` it
 *      into the backstage and read back its pane.
 *    - `swapPaneInPlace(pin, focusPane)`: incoming → the viewport slot; the
 *      outgoing occupant → incoming's old (backstage) slot, %ids preserved
 *      (cross-session swap confirmed by the spike).
 *    - outgoing still generating → backstage (F2); else reap its now-backstage
 *      pane (Invariant P). A holder occupant (no node row) is always reaped.
 *  Arms remain-on-exit on the viewport (F3) and mirrors focus.ptr (setFocus). */
export function retargetFocus(focusId: string, incoming: string, revive: Reviver): FocusResult {
  let f = getFocusById(focusId);
  if (f === null) return { focused: false, session: null, inPlace: false, revived: false };

  reconcileFocus(f.focus_id);
  reconcile(incoming);
  f = getFocusById(focusId) ?? f;

  const outgoing = f.node_id;
  // Already showing this node — a no-op (focusing yourself / the live occupant).
  if (outgoing === incoming) {
    return { focused: true, session: f.session, inPlace: true, revived: false };
  }

  // Q5 vacate: incoming occupies a DIFFERENT focus — close it + kill its pane;
  // the node moves here. reconcile then nulls its now-dead LOCATION.
  const other = getFocusByNode(incoming);
  if (other !== null && other.focus_id !== f.focus_id) {
    if (other.pane !== null) closePane(other.pane);
    closeFocusRow(other.focus_id);
    reconcile(incoming);
  }

  // Resolve incoming's live pin pane; revive into backstage if dormant.
  let revived = false;
  let pin = livePinPane(incoming);
  if (pin === null) {
    revive(incoming);
    revived = true;
    reconcile(incoming);
    pin = livePinPane(incoming);
  }
  if (pin === null) {
    return { focused: false, session: f.session, inPlace: false, revived };
  }

  const focusPane = f.pane;

  // The focus has no physical pane yet (an unplaced/bridge row) OR incoming is
  // already in it — adopt pin directly, no swap.
  if (focusPane === null || focusPane === pin) {
    const loc = paneLocation(pin);
    commitFocusTxn(f.focus_id, incoming, pin, loc, outgoing, { kind: 'kill' }, null, null);
    armRemainOnExit(loc?.window);
    setFocus(incoming);
    return { focused: true, session: loc?.session ?? f.session, inPlace: true, revived };
  }

  // The hot-swap: incoming's pane → the viewport slot; outgoing's pane →
  // incoming's old (backstage) slot. %ids survive (spike-confirmed).
  if (!swapPaneInPlace(pin, focusPane)) {
    return { focused: false, session: f.session, inPlace: false, revived };
  }
  const pinLoc = paneLocation(pin); // now the viewport
  const outLoc = paneLocation(focusPane); // now backstage (outgoing's new home)
  const action = outgoingDisposition({ exists: getRow(outgoing) !== null, generating: isGenerating(outgoing) });
  commitFocusTxn(f.focus_id, incoming, pin, pinLoc, outgoing, action, outLoc, focusPane);

  // Reap the outgoing/holder pane (now backstage) when not generating — AFTER
  // commit (a tmux side effect, outside the txn).
  if (action.kind === 'kill') closePane(focusPane);
  armRemainOnExit(pinLoc?.window);
  setFocus(incoming);
  return { focused: true, session: pinLoc?.session ?? f.session, inPlace: true, revived };
}

/** The ONE atomic txn (§2.5): point the focus row at `pin`, set its occupant to
 *  `incoming`, and write BOTH nodes' presence — incoming into the viewport, the
 *  outgoing either backstaged (still generating) or null (its pane is reaped by
 *  the caller). A holder/vanished outgoing (no row) gets no presence write. */
function commitFocusTxn(
  focusId: string,
  incoming: string,
  pin: string,
  pinLoc: { session: string; window: string } | null,
  outgoing: string,
  action: OutgoingAction,
  outLoc: { session: string; window: string } | null,
  outgoingPane: string | null,
): void {
  const db = openDb();
  db.exec('BEGIN');
  try {
    setFocusPane(focusId, pin, pinLoc?.session ?? null);
    setFocusOccupant(focusId, incoming);
    setPresence(incoming, { pane: pin, tmux_session: pinLoc?.session ?? null, window: pinLoc?.window ?? null });
    if (getRow(outgoing) !== null) {
      if (action.kind === 'backstage') {
        // The outgoing pi kept its pane id (`outgoingPane`), now in the backstage.
        setPresence(outgoing, { pane: outgoingPane, tmux_session: outLoc?.session ?? null, window: outLoc?.window ?? null });
      } else {
        setPresence(outgoing, { pane: null, tmux_session: null, window: null });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** The front door for `node focus` / `node cycle` (§2.3): resolve which focus the
 *  caller's pane acts on, then retarget `nodeId` onto it.
 *    - `newPane` → `openFocus` a fresh viewport beside the caller (F4), then
 *      retarget into it.
 *    - else → retarget the caller pane's focus IN PLACE (`focusByPane`); if the
 *      caller's pane is not yet a viewport, adopt it as one (occupied by whatever
 *      node sits there now — `callerNode`, else resolved by pane).
 *    - no caller pane (not in tmux) → best-effort: mirror focus.ptr, report
 *      not-in-place. */
export function focus(
  nodeId: string,
  opts: { pane?: string; newPane?: boolean; callerNode?: string; revive: Reviver },
): FocusResult {
  const meta = getNode(nodeId);
  if (meta === null) return { focused: false, session: null, inPlace: false, revived: false };

  const callerPane = opts.pane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  if (callerPane === undefined || callerPane === '') {
    // Not in tmux — no viewport to swap into. Mirror the pointer; report status.
    setFocus(nodeId);
    reconcile(nodeId);
    return { focused: isNodePaneAlive(nodeId), session: meta.tmux_session ?? null, inPlace: false, revived: false };
  }

  if (opts.newPane === true) {
    const opened = openFocus(callerPane, {});
    if (opened === null) return { focused: false, session: null, inPlace: false, revived: false };
    return retargetFocus(opened.focus_id, nodeId, opts.revive);
  }

  let f = focusByPane(callerPane);
  if (f === null) f = ensureFocusAtPane(callerPane, opts.callerNode);
  if (f === null) {
    setFocus(nodeId);
    return { focused: false, session: meta.tmux_session ?? null, inPlace: false, revived: false };
  }
  return retargetFocus(f.focus_id, nodeId, opts.revive);
}

/** Register the caller's CURRENT pane as a focus so a `node focus`/`cycle` from a
 *  pane that isn't yet a viewport retargets IN PLACE. Occupied by whatever node
 *  sits in the pane now (`callerNode`, else resolved by pane→row), or a HOLDER
 *  when none is resolvable / it is already focused elsewhere (UNIQUE node_id). */
function ensureFocusAtPane(pane: string, callerNode?: string): FocusRow | null {
  const existing = getFocusByPane(pane);
  if (existing !== null) return existing;
  const loc = paneLocation(pane);
  const focusId = newFocusId();
  const resolved = callerNode ?? getRowByPane(pane)?.node_id;
  const occupant =
    resolved !== undefined && resolved !== '' && getFocusByNode(resolved) === null
      ? resolved
      : holderId(focusId);
  openFocusRow(focusId, pane, loc?.session ?? null, occupant);
  armRemainOnExit(loc?.window);
  return getFocusById(focusId);
}

// ---------------------------------------------------------------------------
// Teardown / recycle / lifecycle-successor verbs (§2.3/§1.6, Step 7) — the
// close/demote/reset entry points + the truly-done focus successor.
// ---------------------------------------------------------------------------

/** Tear a node off its placement (close/reset teardown, §2.3, flow (e)).
 *  Reconcile first (follow a manual move / backfill a legacy pane), close the
 *  focus row it occupies (if any), kill its pane (pane-keyed via the durable
 *  `%id` — the window collapses once its last pane goes), and null its LOCATION.
 *  Mirrors focus.ptr when this node was the current focus. Best-effort tmux; the
 *  DB writes always land. The pane kill is the sole teardown unit (Q1/§6: a
 *  split-pane focus returns its space to the surviving split; a standalone-window
 *  focus closes the window). */
export function tearDownNode(nodeId: string): void {
  reconcile(nodeId);
  const f = focusOf(nodeId);
  if (f !== null) closeFocusRow(f.focus_id);
  const row = getRow(nodeId);
  const pane = row?.pane ?? f?.pane ?? null;
  if (pane !== null && paneExists(pane)) closePane(pane);
  setPresence(nodeId, { pane: null, tmux_session: null, window: null });
  if (getFocus() === nodeId) setFocus('');
}

/** Demote's in-pane relaunch (§2.3, flow (e)): respawn `nodeId`'s launch into an
 *  EXISTING `pane`, keeping the durable `%id` (respawn-pane -k), and record its
 *  presence keyed on that pane. The session/window are DERIVED from the pane
 *  itself (paneLocation), so the recycled node's LOCATION follows the pane it was
 *  recycled into. `launch.env` is passed through verbatim — the caller (demote)
 *  already sets CRTR_ROOT_SESSION (children → backstage) + FRONT_DOOR. Detached
 *  respawn, since the pane is often the caller's own. Returns whether the respawn
 *  dispatched. */
export function recycleFocusPane(nodeId: string, pane: string, launch: ReviveLaunch): boolean {
  reconcile(nodeId);
  const loc = paneLocation(pane);
  const session = loc?.session ?? homeSessionOf(nodeId);
  const ok = respawnPaneDetached({ pane, cwd: launch.cwd, env: launch.env, command: launch.command });
  if (ok) setPresence(nodeId, { pane, tmux_session: session, window: loc?.window ?? windowOfPane(pane) });
  return ok;
}

/** §1.6 lifecycle successor — hand a truly-done focused node's viewport to its
 *  manager. Repoints the focus row `focusId` to `managerId` (a DB swap of the
 *  occupant). Two takeover realizations, split on the manager's liveness:
 *    - DORMANT manager (dead pi): the row repoint is all this does; the manager,
 *      woken by the finished node's `push final` landing in its inbox, is revived
 *      by the external daemon INTO this node's now-frozen focus pane
 *      (remain-on-exit), where reviveIntoPlacement's focus-pane branch resumes it
 *      in place — no new window, no taint. (UNCHANGED — the canonical takeover.)
 *    - LIVE manager (pi alive in the backstage, the normal multi-child state):
 *      the daemon never revives it (it only respawns dead-pi nodes), so we must
 *      bring it into the viewport SYNCHRONOUSLY here — swap its backstage pane
 *      into the focus slot (MAJOR 1). Otherwise the manager runs off-screen
 *      forever while %m sits orphaned in the viewport and the focus row lies
 *      about LOCATION.
 *  Returns false — the caller closes the focus (Q1) — when there is no manager,
 *  the manager IS this node, or the manager already occupies another viewport
 *  (UNIQUE node_id: do NOT move it, §1.6 edge).
 *
 *  Why the live swap is NOT the forbidden self-saw: `swap-pane -d` only EXCHANGES
 *  two panes' slot positions; it never respawns or kills the finishing node's own
 *  pi. The forbidden move is a synchronous `respawn-pane -k %m` from inside %m —
 *  we never do that here. After the swap, %m (the dying node's pane) sits in the
 *  manager's old backstage slot; the caller nulls this node's presence so nothing
 *  tracks the corpse. */
export function handFocusToManager(focusId: string, managerId: string | null): boolean {
  if (managerId === null) return false;
  const f = getFocusById(focusId);
  if (f === null || managerId === f.node_id) return false;
  if (getFocusByNode(managerId) !== null) return false; // manager already focused elsewhere
  setFocusOccupant(focusId, managerId);
  setFocus(managerId);

  // MAJOR 1 — LIVE backstage manager → swap it into the focus slot now. DORMANT
  // managers (no live pane / dead pi) fall through unchanged: the daemon revives
  // them into the frozen %m async.
  const mgr = getRow(managerId);
  if (mgr !== null && mgr.pane != null && isNodePaneAlive(mgr) && pidAlive(mgr.pi_pid) && f.pane != null) {
    const focusLoc = paneLocation(f.pane); // F2's window/session — the slot mgr swaps INTO (%m is currently there)
    if (swapPaneInPlace(mgr.pane, f.pane) && focusLoc !== null) {
      setFocusPane(f.focus_id, mgr.pane, focusLoc.session); // re-anchor the focus row to mgr's pane (now in F2)
      setPresence(managerId, { pane: mgr.pane, tmux_session: focusLoc.session, window: focusLoc.window });
    }
  }
  return true; // still "took focus" — caller doesn't close
}

// ---------------------------------------------------------------------------
// Spread — tile a target + its (already-live) children into one window (the
// `canvas tmux-spread` chrome). Placement owns the tmux verbs + the pane-fix-up
// (reconcile FOLLOWS each joined pane to its new window); the command owns child
// selection + reviving dormant nodes (placement can't import revive — a cycle).
// ---------------------------------------------------------------------------

export interface SpreadResult {
  window: string | null;
  session: string | null;
  /** Child node ids whose panes were joined into the target window. */
  joined: string[];
  focused: boolean;
}

/** Join each of `childIds`' live panes into `targetId`'s window, lay them out
 *  (target wide on the left, children stacked right), and focus it. Reconcile
 *  drives both the target resolution and the per-join fix-up (a joined pane keeps
 *  its `%id` but changes window, so its LOCATION must FOLLOW — else the daemon
 *  reads it dormant). Caller revives dormant nodes first so they have live panes.
 *  No-op result when the target has no live pane. */
export function spreadNode(
  targetId: string,
  childIds: string[],
  opts: { mainPaneWidth?: string } = {},
): SpreadResult {
  reconcile(targetId);
  const trow = getRow(targetId);
  if (trow === null || trow.pane === null || !paneExists(trow.pane)) {
    return { window: null, session: null, joined: [], focused: false };
  }
  const tloc = paneLocation(trow.pane);
  if (tloc === null) return { window: null, session: null, joined: [], focused: false };
  const { window: targetWindow, session: targetSession } = tloc;
  const targetPane = trow.pane;

  const joined: string[] = [];
  for (const cid of childIds) {
    reconcile(cid);
    const crow = getRow(cid);
    if (crow === null || crow.pane === null || !paneExists(crow.pane) || crow.pane === targetPane) continue;
    if (!joinPane(crow.pane, targetWindow)) continue;
    reconcile(cid); // fix-up: presence FOLLOWS the joined pane to the target window
    joined.push(cid);
  }

  if (joined.length > 0) {
    setWindowOption(targetWindow, 'main-pane-width', opts.mainPaneWidth ?? '60%');
    selectLayout(targetWindow, 'main-vertical');
  }

  const focused = switchClient(targetSession) && selectWindow(targetSession, targetWindow);
  setFocus(targetId);
  return { window: targetWindow, session: targetSession, joined, focused };
}
