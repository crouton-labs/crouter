// placement.ts — the VIEWER REGISTRY + the model-over-driver tmux front door.
//
// After the broker-is-the-host cut the engine NEVER lives in a tmux pane: every
// node is a detached `headlessBrokerHost` process that binds `view.sock`. A tmux
// pane is only a `crtr attach` VIEWER of that broker, exactly like a web tab. So
// the whole engine-in-pane placement machinery (hot-swap, resume-into-focus,
// backstage relocation, remain-on-exit freeze, spread, node-row reconcile) is
// gone. What remains is:
//
//   • The VIEWER REGISTRY — the `focuses` table, schema unchanged, now read as
//     "node_id -> the node's one viewer %pane in `session`" (UNIQUE(node_id) =
//     one viewer per node). focusOf/isFocused/focusByPane/focusedNodes/
//     listFocuses read it (lazily GC'ing rows whose pane is gone or no longer
//     carries this node's `@crtr_node` tag); registerViewerFocus writes it.
//   • focus(nodeId) — ensure the broker engine is alive (injected reviver) +
//     wait view.sock, then ensure the node's ONE viewer pane is forefront: reuse
//     it (navigate) if it is in the caller's session, MOVE it (close + reopen
//     beside the caller) if it is elsewhere, else open one beside the caller.
//   • openViewerWindow / registerViewerFocus — the shared viewer-pane opener +
//     row registrar used by BOTH spawn (a background viewer window) and focus.
//   • tearDownNode / detachToBackground — close a node's viewer pane + row.
//   • The chrome/viewer tmux re-exports (§2.1): placement stays the sanctioned
//     model-over-driver so the §5.1 import-lint ("only placement.ts /
//     tmux-chrome.ts import tmux.ts") holds — every other module reaches the
//     driver verbs through here.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  getNode,
  openFocusRow,
  closeFocusRow,
  getFocusByNode,
  getFocusByPane,
  getFocusById,
  listFocuses as listFocusRows,
  view,
  type FocusRow,
} from '../canvas/index.js';
import {
  paneExists,
  paneLocation,
  ensureSession,
  openNodeWindow,
  splitWindow,
  closePane,
  currentTmux,
  switchClient,
  selectWindow,
  getPaneOption,
} from './tmux.js';
import { nodeSession, newNodeId, rootOfSpine } from './nodes.js';
import { nodeDir } from '../canvas/paths.js';
import { isPidAlive } from '../canvas/pid.js';

export type { FocusRow };

// Placement is the sanctioned model-over-driver (§2.1): non-placement runtime /
// command modules that legitimately need a raw driver verb get it from here, so
// the §5.1 lint can hold "only placement.ts / tmux-chrome.ts import tmux.ts".
// These are the chrome + viewer verbs that survive the cut (the engine-in-pane
// verbs — respawnPane, respawnPaneDetached, swapPaneInPlace, breakPaneToSession,
// joinPane, selectLayout, setWindowOption, setRemainOnExit — are deleted).
// `piCommand` + `paneCurrentPath` are KEPT: the sessionless `crtr view` system
// (view-cycle.ts / view-run.ts) builds its pane commands with them, and the §5.1
// import-lint forbids those commands importing tmux.ts directly — they must reach
// the driver through placement. (They are NOT engine-in-pane; the design's
// "nothing keeps" classification missed the view consumers.)
export {
  splitWindow,
  focusWindow,
  selectWindow,
  switchClient,
  openNodeWindow,
  ensureSession,
  paneLocation,
  paneExists,
  paneRunning,
  paneCurrentPath,
  currentTmux,
  inTmux,
  setPaneOption,
  getPaneOption,
  piCommand,
  respawnPaneSync,
  closePane,
  windowOfPane,
  paneOfWindow,
  windowAlive,
  listLivePanes,
} from './tmux.js';
export { nodeSession } from './nodes.js';

// ---------------------------------------------------------------------------
// Viewer registry reads — COMPOSE over the canvas focuses table (§2.3/§4).
//
// placement is the front door for "which nodes have a viewer on screen"; the SQL
// lives in the canvas layer (canvas/focuses.ts) and placement just reads it. A
// node has at most one viewer (UNIQUE node_id), so focusOf returns a single row.
//
// GC is lazy on read: a row whose viewer pane no longer exists (the user closed
// the window, the attach client died) is pruned the next time it is read, so the
// registry self-heals without a sweeper. (graphSurfaceTarget stays pure — no
// tmux probe — by design; its caller liveness-checks the pane it returns.)
// ---------------------------------------------------------------------------

/** Prune a viewer row whose pane is gone; return it iff its pane is still live. */
function liveOrPrune(f: FocusRow | null): FocusRow | null {
  if (f === null) return null;
  if (f.pane !== null && !paneExists(f.pane)) {
    closeFocusRow(f.focus_id);
    return null;
  }
  return f;
}

/** The viewer a node has on screen, or null. UNIQUE(node_id) ⇒ at most one. */
export function focusOf(nodeId: string): FocusRow | null {
  return liveOrPrune(getFocusByNode(nodeId));
}

/** Does this node have a live viewer on screen? */
export function isFocused(nodeId: string): boolean {
  return focusOf(nodeId) !== null;
}

/** The viewer realized by a given pane (`%id`), or null. */
export function focusByPane(pane: string): FocusRow | null {
  return liveOrPrune(getFocusByPane(pane));
}

/** The set of node ids that currently have a live viewer. */
export function focusedNodes(): Set<string> {
  return new Set(listFocuses().map((f) => f.node_id));
}

/** Every live viewer row (GC'ing any whose pane has gone). */
export function listFocuses(): FocusRow[] {
  const live: FocusRow[] = [];
  for (const f of listFocusRows()) {
    if (liveOrPrune(f) !== null) live.push(f);
  }
  return live;
}

// ---------------------------------------------------------------------------
// Graph → viewer routing (for surfacing human-in-the-loop prompts)
// ---------------------------------------------------------------------------

/** The on-screen viewer a human-in-the-loop prompt raised by `nodeId` should
 *  surface into: the HIGHEST node of nodeId's graph that has a viewer — the
 *  viewer closest to the graph root, i.e. the session/window the user is actually
 *  watching this work in. Walks nodeId's spine to its root, enumerates the whole
 *  tree root-first (`view` is BFS ⇒ shallowest first), and returns the viewer row
 *  of the first node that has one. null when nothing in the graph is on screen —
 *  the caller then surfaces in the user's attached pane. PURE (db reads only): no
 *  tmux probe, so the pane may be stale; the caller liveness-checks before
 *  targeting it. */
export function graphSurfaceTarget(nodeId: string): FocusRow | null {
  const root = rootOfSpine(nodeId);
  for (const id of [root, ...view(root)]) {
    const f = getFocusByNode(id);
    if (f !== null && f.pane !== null) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// view.sock readiness — the one shared broker-cold-start primitive
// ---------------------------------------------------------------------------

const BROKER_FOCUS_SOCKET_WAIT_MS = 30_000;
const BROKER_FOCUS_SOCKET_RETRY_MS = 100;

/** Synchronously wait until a broker's view.sock accepts a connection. The spawn
 *  and focus flows are sync (the command layer calls them directly), so the
 *  readiness probe lives in a short child Node process that can use async net
 *  events while this process blocks in `spawnSync`. Success proves more than file
 *  existence: it is robust to a stale leftover socket the launching broker has
 *  not unlinked yet, because only an accepting listener exits 0. */
export function waitForBrokerViewSocket(nodeId: string): boolean {
  const sockPath = join(nodeDir(nodeId), 'view.sock');
  const probe = `
const net = require('node:net');
const sockPath = process.argv[1];
const deadline = Date.now() + Number(process.argv[2]);
const delay = Number(process.argv[3]);
function attempt() {
  let socket;
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    if (socket !== undefined) socket.destroy();
    if (ok) process.exit(0);
    if (Date.now() >= deadline) process.exit(1);
    setTimeout(attempt, delay);
  };
  try {
    socket = net.createConnection(sockPath);
  } catch {
    finish(false);
    return;
  }
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(delay, () => finish(false));
}
attempt();
`;
  const r = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '-e', probe, sockPath, String(BROKER_FOCUS_SOCKET_WAIT_MS), String(BROKER_FOCUS_SOCKET_RETRY_MS)],
    {
      stdio: 'ignore',
      timeout: BROKER_FOCUS_SOCKET_WAIT_MS + 1_000,
      // Keep the probe deterministic: NODE_OPTIONS like --input-type=module or
      // --inspect-brk can break/hang a tiny `node -e` readiness check.
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Viewer opener + registrar — the shared spawn/focus primitives
// ---------------------------------------------------------------------------

/** A reviver: ensure a node's broker ENGINE is alive (idempotent → reviveNode →
 *  headlessBrokerHost.launch). Injected so placement.ts need not import revive.ts
 *  (which imports placement.ts — a cycle). */
export type Reviver = (nodeId: string) => void;

/** Result of a focus op. `inPlace` = navigated to an existing viewer (no new
 *  pane); false = a fresh viewer pane was opened/moved. `revived` = this call
 *  had to (re)launch the broker engine. */
export interface FocusResult {
  focused: boolean;
  session: string | null;
  inPlace: boolean;
  revived: boolean;
}

function newFocusId(): string {
  return `f-${newNodeId()}`;
}

/** Env for a `crtr attach` VIEWER pane (the focus split, the spawn viewer
 *  window, AND recycle's re-attach respawn): propagate CRTR_HOME so the viewer
 *  resolves the SAME canvas home — and thus the right view.sock — under a
 *  non-default override; otherwise an empty env (the pane inherits the tmux
 *  server env, like every other crtr chrome pane). One helper so the viewer-pane
 *  sites can't drift. */
export function viewerSplitEnv(): Record<string, string> {
  const crtrHome = process.env['CRTR_HOME'];
  return crtrHome !== undefined ? { CRTR_HOME: crtrHome } : {};
}

/** Register a `crtr attach` VIEWER pane as the node's one viewer focus row.
 *  UNIQUE(node_id) ⇒ one viewer per node: returns
 *  the existing row (no insert) when the pane or the node is already registered.
 *  `window` is accepted for the call contract (spawn passes it) but not stored —
 *  the focuses table keys on pane + session only. The attach client self-tags the
 *  pane `@crtr_node` on connect, so `nodeInPane` resolves it either way. */
export function registerViewerFocus(
  nodeId: string,
  pane: string,
  session: string | null,
  window: string | null,
): FocusRow | null {
  void window;
  const byPane = getFocusByPane(pane);
  if (byPane !== null) return byPane;
  const byNode = getFocusByNode(nodeId);
  if (byNode !== null) return byNode;
  const focusId = newFocusId();
  openFocusRow(focusId, pane, session, nodeId);
  return getFocusById(focusId);
}

/** Open a `crtr attach` VIEWER for `nodeId` and register its viewer focus row —
 *  the shared opener used by BOTH spawn (a background viewer window in the shared
 *  backstage session) and focus (a split beside the caller). Wraps
 *  `ensureSession` + `openNodeWindow`/`splitWindow` + `registerViewerFocus`. The
 *  attach client connects to the node's `view.sock` and renders/drives the live
 *  broker engine — it NEVER launches the engine (the one-writer invariant; the
 *  caller ensures the broker is alive first). Returns the registered viewer row,
 *  or null if tmux refused.
 *    - default → a fresh WINDOW in `session` (the spawn background-viewer path).
 *    - `besidePane` → a SPLIT beside that pane in its own session (the focus
 *      open-beside-the-caller path); `session` is then only a fallback. */
export function openViewerWindow(
  nodeId: string,
  session: string,
  opts: { name?: string; cwd?: string; besidePane?: string } = {},
): FocusRow | null {
  const command = `crtr attach to ${nodeId}`;
  const env = viewerSplitEnv();
  const cwd = opts.cwd ?? process.cwd();
  let pane: string | null;
  let sess: string | null;
  let window: string | null;
  if (opts.besidePane !== undefined) {
    pane = splitWindow(opts.besidePane, { cwd, env, command });
    if (pane === null) return null;
    const loc = paneLocation(pane);
    sess = loc?.session ?? session;
    window = loc?.window ?? null;
  } else {
    ensureSession(session, cwd);
    const opened = openNodeWindow({ session, name: opts.name ?? nodeId, cwd, env, command });
    if (opened === null) return null;
    pane = opened.pane;
    window = opened.window;
    sess = session;
  }
  return registerViewerFocus(nodeId, pane, sess, window);
}

// ---------------------------------------------------------------------------
// focus — the front door for `node focus` / `node cycle` / nav (§A.4)
// ---------------------------------------------------------------------------

/** Bring a node's ONE viewer pane forefront (§A.4). Every node is a detached
 *  broker, so there is no engine pane to swap into the caller's viewport — focus
 *  instead ensures the node's single `crtr attach` viewer is on screen beside (or
 *  navigated to) the caller:
 *    (a) ensure the broker ENGINE is alive (idempotent injected reviver) and its
 *        view.sock is ACCEPTING (closes the cold-start race against attach's
 *        single connect) — without this the freshly-opened viewer would exit
 *        "no broker".
 *    (b) `--new-pane` → always a fresh viewer beside the caller (e.g. two
 *        different nodes side by side); drop any prior viewer first (UNIQUE).
 *    (c) the node already has a live viewer:
 *          - in the caller's session ⇒ navigate to it (switchClient+selectWindow),
 *            no new pane (inPlace).
 *          - elsewhere (e.g. the backstage spawn window) ⇒ MOVE it: close the old
 *            viewer pane (the broker runs on; the fresh viewer replays full
 *            scrollback from the broker `welcome` snapshot), drop its row, reopen
 *            beside the caller.
 *    (d) no live viewer ⇒ open one beside the caller and register the row.
 *
 *  crtr is tmux-only: with no caller pane there is no viewport to open and no
 *  non-tmux fallback — report not-focused. */
export function focus(
  nodeId: string,
  opts: { pane?: string; newPane?: boolean; revive: Reviver },
): FocusResult {
  const meta = getNode(nodeId);
  if (meta === null) return { focused: false, session: null, inPlace: false, revived: false };

  const callerPane = opts.pane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  if (callerPane === undefined || callerPane === '') {
    return { focused: false, session: null, inPlace: false, revived: false };
  }

  // (a) Ensure the broker engine is alive + its view.sock accepts. Capture prior
  //     liveness so the result reports whether THIS focus had to launch it.
  const wasAlive = isPidAlive(meta.pi_pid ?? null);
  opts.revive(nodeId);
  const revived = !wasAlive;
  if (!waitForBrokerViewSocket(nodeId)) {
    return { focused: false, session: null, inPlace: false, revived };
  }

  const callerSession = paneLocation(callerPane)?.session ?? null;
  const fallbackSession = callerSession ?? nodeSession();

  // (b) --new-pane → always a fresh viewer beside the caller. Drop any prior
  //     viewer this node holds elsewhere (UNIQUE(node_id): one viewer per node).
  if (opts.newPane === true) {
    const prior = focusOf(nodeId);
    if (prior !== null) {
      if (prior.pane !== null && paneExists(prior.pane)) closePane(prior.pane);
      closeFocusRow(prior.focus_id);
    }
    const opened = openViewerWindow(nodeId, fallbackSession, { cwd: meta.cwd, besidePane: callerPane });
    if (opened === null) return { focused: false, session: null, inPlace: false, revived };
    return { focused: true, session: opened.session, inPlace: false, revived };
  }

  // (c) Reuse / move the node's one live viewer — but ONLY a pane that still
  //     carries THIS node's `@crtr_node` tag. `paneExists` is not enough: the
  //     front-door root registers the user's own terminal as its viewer pane and
  //     runs `crtr attach` inline; on a clean detach the pane returns to the
  //     user's shell (attach clears the tag) yet the pane — and the row — survive,
  //     and a reused pane carries some OTHER node's tag. Navigating to / closing
  //     such a pane would strand the user on (or kill) their shell. So verify the
  //     tag names this node; on mismatch the row is stale → prune it and fall
  //     through to open a fresh viewer beside the caller.
  const existing = focusOf(nodeId);
  if (existing !== null && existing.pane !== null) {
    if (getPaneOption(existing.pane, '@crtr_node') === nodeId) {
      const loc = paneLocation(existing.pane);
      if (loc !== null && loc.session === callerSession) {
        // Viewer is in the caller's session — just navigate to it.
        switchClient(loc.session);
        selectWindow(loc.session, loc.window);
        return { focused: true, session: loc.session, inPlace: true, revived };
      }
      // Viewer lives elsewhere — MOVE it: close the old pane (broker runs on; the
      // fresh viewer replays scrollback from the welcome snapshot), drop the row,
      // then fall through to open one beside the caller.
      closePane(existing.pane);
      closeFocusRow(existing.focus_id);
    } else {
      // Pane survived but no longer hosts this node's viewer (clean detach left
      // the user's shell, or the pane was reused) — drop the stale row only; do
      // NOT closePane (it is the user's shell / another node's viewer).
      closeFocusRow(existing.focus_id);
    }
  }

  // (d) No live viewer → open one beside the caller and register the row.
  const opened = openViewerWindow(nodeId, fallbackSession, { cwd: meta.cwd, besidePane: callerPane });
  if (opened === null) return { focused: false, session: null, inPlace: false, revived };
  return { focused: true, session: opened.session, inPlace: false, revived };
}

// ---------------------------------------------------------------------------
// Teardown / detach — close a node's viewer pane + row
// ---------------------------------------------------------------------------

/** Tear a node off its viewer (close/reset/cancel teardown). The broker engine
 *  is killed by its own host teardown over view.sock — this only closes the
 *  on-screen viewer: kill its pane (the window collapses once its last pane goes)
 *  and drop its registry row. Best-effort tmux; the DB write always lands. No-op
 *  when the node has no viewer. */
export function tearDownNode(nodeId: string): void {
  const f = focusOf(nodeId);
  if (f === null) return; // no viewer (focusOf already GC'd a gone one)
  if (f.pane !== null && paneExists(f.pane)) closePane(f.pane);
  closeFocusRow(f.focus_id);
}

/** Detach a node from the foreground (the `node lifecycle --detach` / Alt+C → D
 *  half). Every node is a headless broker — the only thing on screen is its
 *  `crtr attach` VIEWER pane — so "detach" means STOP FOREGROUNDING it: close the
 *  viewer pane (and drop its row) and leave the broker engine running untouched,
 *  reconnectable by a later `focus`. `pane` is the authoritative pane the caller
 *  acts on (the Alt+C menu's `#{pane_id}`); falls back to the node's registered
 *  viewer pane. No-op (false) when there is no live viewer pane to close. */
export function detachToBackground(nodeId: string, pane?: string): boolean {
  const viewer = pane ?? focusOf(nodeId)?.pane ?? null;
  if (viewer === null || !paneExists(viewer)) return false;
  const f = focusByPane(viewer);
  if (f !== null) closeFocusRow(f.focus_id);
  return closePane(viewer);
}
