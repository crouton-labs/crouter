// The spawn orchestration — the one place that turns "I want a node here" into
// a running pi process on the canvas. Composes canvas (birth + spine), persona
// (resolve), launch (pi argv), and tmux (placement).
//
//   bootRoot   — the user-opened front door (bare `crtr`). Resident; launches the
//                root's broker engine, then execs `crtr attach` inline so THIS
//                terminal becomes the broker's controller-viewer.
//   spawnChild — a node spawned by a live node (`crtr node new`). A managed,
//                terminal background worker by default; with `root`, an
//                INDEPENDENT resident root (no subscription back to the spawner,
//                provenance via spawned_by) brought forefront for direct driving.

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnNode, currentNodeContext, resolveBirthSession, nodeSession, rootOfSpine } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { writeGoal } from './kickoff.js';
import { hasRoadmap, seedRoadmap } from './roadmap.js';
import { buildIdentityAssertion, buildWakeBearings, type WakeOrigin } from './bearings.js';
import { installMenuBinding, installNavBindings, installViewNavBindings } from './tmux-chrome.js';
import { updateNode, getNode, fullName, type NodeMeta, type Mode, type Lifecycle } from '../canvas/index.js';
import {
  registerViewerFocus,
  openViewerWindow,
  waitForBrokerViewSocket,
  viewerSplitEnv,
  windowOfPane,
  ensureSession,
  currentTmux,
  inTmux,
  focusWindow,
} from './placement.js';
import { transition } from './lifecycle.js';
import { headlessBrokerHost } from './host.js';
import { ensureDaemon } from '../../daemon/manage.js';

// All node windows live in one shared session — see `nodeSession()` in nodes.js.

// ---------------------------------------------------------------------------
// bootRoot — the front door
// ---------------------------------------------------------------------------

export interface BootRootOpts {
  cwd: string;
  kind?: string;
  name?: string;
  /** Optional starter prompt (bare `crtr` requires none). */
  prompt?: string;
}

/** Create the front-door root: launch its broker engine, then exec `crtr attach`
 *  inline so THIS terminal becomes the broker's controller-viewer. Does not
 *  return — it process.exit()s when the inline attach exits (detach leaves the
 *  resident broker running, to be reconnected later). */
export function bootRoot(opts: BootRootOpts): NodeMeta {
  // The thin supervisor must be up before any node exists, so a refresh-yield
  // or crash can be reaped/revived. Idempotent.
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const kind = opts.kind ?? 'general';
  // A born-resident root starts in base mode; it earns the orchestrator persona
  // the first time it delegates (or on promotion). Resident lifecycle either way.
  const { launch } = buildLaunchSpec(kind, 'base', { lifecycle: 'resident', hasManager: false });
  // Born WITHOUT a name. Naming is async + event-driven: the canvas-goal-capture
  // extension names the node from its FIRST real message (the kickoff prompt or
  // a human's first line) inside its own pi process, via a headless `pi -p`.
  // Never block the front door on an LLM round-trip.
  const meta = spawnNode({
    kind,
    mode: 'base',
    lifecycle: 'resident',
    cwd: opts.cwd,
    name: opts.name ?? kind,
    parent: null,
    launch,
  });

  // Persist the spawning prompt as the goal so a fresh revive can re-read its
  // mandate (bare `crtr` has none — writeGoal no-ops on empty).
  if (opts.prompt !== undefined) writeGoal(meta.node_id, opts.prompt);

  // Every node window — root or child — lives in the one shared session.
  const session = nodeSession();
  ensureSession(session, opts.cwd);
  // Make the Alt+C action menu + Alt+] / Alt+[ node-nav keys + Alt+V then ]/[
  // view-nav chord live on this server (idempotent, in-tmux only).
  if (inTmux()) {
    try { installMenuBinding(); } catch { /* best-effort */ }
    try { installNavBindings(); } catch { /* best-effort */ }
    try { installViewNavBindings(); } catch { /* best-effort */ }
  }

  // This terminal becomes the root's attach VIEWER, so its window stays where the
  // user is. The node row carries NO presence — a broker node's pane/window/
  // tmux_session stay NULL; the viewer pane lives in the focuses table (below).
  // The root's children still spawn into the shared global session via
  // CRTR_ROOT_SESSION — they never clutter the user's working session.
  const here = currentTmux();
  const adopted = resolveBirthSession({ adoptCaller: true, here, rootSession: undefined });
  // REVIVE-HOME: the root's durable home session (the caller's when inside tmux,
  // else the shared backstage), set once at birth.
  updateNode(meta.node_id, { home_session: adopted });
  // The FOREGROUND front-door terminal is the root's one viewer (§A.3 step 6):
  // record its pane as the node's viewer focus row so focus/nav can find it. The
  // `crtr attach` exec below makes the terminal a controller-viewer of the
  // broker; detaching leaves the resident broker running. Only inside tmux (a
  // pane to anchor on).
  if (here) {
    try { registerViewerFocus(meta.node_id, here.pane, adopted, here.window); } catch { /* best-effort */ }
  }
  const withSession = getNode(meta.node_id) as NodeMeta;
  const inv = buildPiArgv(withSession, { prompt: opts.prompt });
  // Broker is the only host (§B.spawn): the root runs as a detached broker engine
  // (so its first refresh/revive doesn't strand this terminal — the daemon revives
  // the broker and the viewer reconnects), and THIS terminal execs `crtr attach`
  // inline to become its controller-viewer. The broker host merges inv.env, so the
  // subtree's shared-backstage routing rides on it; the host sets CRTR_FRONT_DOOR.
  inv.env = { ...inv.env, CRTR_ROOT_SESSION: session, CRTR_SUBTREE: rootOfSpine(meta.node_id) };
  const placed = headlessBrokerHost.launch(meta.node_id, inv, {
    cwd: opts.cwd,
    name: fullName(withSession),
    resuming: false,
  });
  // No broker pid ⇒ the root has no engine. Crash it (so the daemon won't watch a
  // zombie 'active') and throw — there is nothing to attach to.
  if (placed.pid === null) {
    transition(meta.node_id, 'crash');
    throw new Error(`failed to launch the broker engine for the front-door root ${meta.node_id} — nothing to attach to.`);
  }
  // The terminal has nothing to attach to until view.sock accepts. The root is
  // useless without its engine, so a socket timeout IS fatal here (unlike a
  // background child's optional viewer, which is skipped on timeout).
  if (!waitForBrokerViewSocket(meta.node_id)) {
    throw new Error(`the front-door root broker ${meta.node_id} never bound its view socket — cannot attach.`);
  }
  const attachEnv = { ...process.env, ...viewerSplitEnv() } as NodeJS.ProcessEnv;
  const r = spawnSync('crtr', ['attach', 'to', meta.node_id], { stdio: 'inherit', env: attachEnv });
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// spawnChild — background delegation
// ---------------------------------------------------------------------------

export interface SpawnChildOpts {
  kind: string;
  mode?: Mode;
  cwd: string;
  name?: string;
  prompt: string;
  /** Override the parent (defaults to the calling node from env). */
  parent?: string;
  /** Spawn an INDEPENDENT root instead of a managed child: parent=null, no
   *  subscription back to the spawner, resident lifecycle, spawned_by=spawner.
   *  Brought forefront on spawn so a human can drive it directly. */
  root?: boolean;
  /** Fork the new node from an existing pi conversation instead of starting it
   *  fresh: a node id (resolved to that node's session file), an absolute
   *  `.jsonl` path, or a partial pi session uuid. pi COPIES that history into a
   *  new session for the child — the source is untouched — then `prompt` is the
   *  next message. A one-shot at birth; the child resumes its own session after. */
  forkFrom?: string;
  /** Set ONLY by the daemon when a `spawn`/spawn-cron wake births this node: the
   *  provenance of the timer that fired (see WakeOrigin). In-memory only — it is
   *  NOT part of the stored recipe (the daemon spreads it in at fire time via
   *  `spawnChild({ ...recipe, wakeOrigin })`); `node new` never sets it. When set,
   *  a <crtr-wake> block is prepended to the kickoff so the newborn knows a clock
   *  birthed it. */
  wakeOrigin?: WakeOrigin;
  /** Pin the node to a model TIER (ultra/strong/medium/light), overriding the
   *  persona's declared default. Persisted to `meta.model_override` so it
   *  survives polymorphs. Omit to use the persona default. */
  model?: string;
}

/** pi's sessions root, VENDORED from pi `config.getSessionsDir()` (= `<agentDir>/
 *  sessions`). pi's package `exports` map is `.`-only, so config.js can't be
 *  deep-imported, and a ROOT import of `getAgentDir` would eager-load the entire
 *  heavy pi SDK index on crtr's front-door hot path (the reason broker-sdk.ts
 *  dynamic-imports the engine). Mirrors pi: `PI_CODING_AGENT_DIR` env, else
 *  `~/.pi/agent` (APP_NAME defaults to 'pi'). Re-sync on a pi SDK bump that moves
 *  the sessions dir — same vendoring rationale as pi-vendored.ts. */
function piSessionsRoot(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = env !== undefined && env !== '' ? env : join(homedir(), '.pi', 'agent');
  return join(agentDir, 'sessions');
}

/** Resolve a bare/partial pi session uuid to its ABSOLUTE `.jsonl` path by
 *  scanning pi's sessions store the way pi's own CLI does (exact id, else a
 *  unique prefix). The broker fork seam (`SessionManager.forkFrom`) loads a FILE
 *  and does NOT resolve a uuid, so a bare id must be resolved here or the fork
 *  throws at boot. Session files are `<sessions>/<project>/<ts>_<id>.jsonl`. */
function resolveSessionUuid(uuid: string): string {
  const sessionsRoot = piSessionsRoot();
  if (!existsSync(sessionsRoot)) {
    throw new Error(`--fork-from '${uuid}': no pi sessions store at ${sessionsRoot} to resolve it from — pass a node id or an absolute .jsonl path.`);
  }
  const matches: { id: string; path: string }[] = [];
  for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projDir = join(sessionsRoot, dir.name);
    for (const f of readdirSync(projDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const stem = f.slice(0, -'.jsonl'.length);
      const id = stem.slice(stem.lastIndexOf('_') + 1);
      matches.push({ id, path: join(projDir, f) });
    }
  }
  const exact = matches.filter((m) => m.id === uuid);
  const hit = exact.length > 0 ? exact : matches.filter((m) => m.id.startsWith(uuid));
  if (hit.length === 0) throw new Error(`--fork-from '${uuid}': no pi session with that id found.`);
  if (hit.length > 1) {
    throw new Error(`--fork-from '${uuid}': ambiguous — ${hit.length} sessions match that id prefix; pass the full id or the .jsonl path.`);
  }
  return hit[0].path;
}

/** Resolve a `--fork-from` value to an ABSOLUTE `.jsonl` source path for the
 *  broker fork (`SessionManager.forkFrom`, which loads a file — never a bare id).
 *  A live node id resolves to its captured session FILE (absolute, cwd-immune); a
 *  relative path is made absolute; a bare/partial uuid is resolved against pi's
 *  sessions store. Throws when a known node has no captured session file, or when
 *  a uuid resolves to zero or multiple sessions. */
export function resolveForkSource(value: string): string {
  const v = value.trim();
  if (v === '') throw new Error('--fork-from requires a node id, session file, or session uuid.');
  // A path (contains `/` or ends `.jsonl`) is a session file — ensure it is
  // ABSOLUTE so the broker, launched in a different cwd, still resolves it.
  if (v.includes('/') || v.endsWith('.jsonl')) {
    return isAbsolute(v) ? v : resolve(process.cwd(), v);
  }
  // A live node id — fork from the conversation it has accumulated. Its captured
  // session FILE is absolute; the broker cannot fork a bare session id.
  const n = getNode(v);
  if (n !== null) {
    const src = n.pi_session_file;
    if (src === undefined || src === null || src === '') {
      throw new Error(`node ${v} has no pi session yet — it has not captured a session FILE to fork from (the broker forks a .jsonl path, not a bare id).`);
    }
    return src;
  }
  // Not a known node — a bare/partial pi session uuid; resolve it to an absolute
  // .jsonl (the broker fork won't resolve a uuid).
  return resolveSessionUuid(v);
}

export interface SpawnChildResult {
  node: NodeMeta;
  window: string | null;
  session: string;
}

/** Resolve who a spawn is attributed to. A managed child needs a spine parent
 *  (explicit `--parent` or the calling node's CRTR_NODE_ID). A --root spawn
 *  does not: it is top-level by definition and the spawner identity is
 *  provenance only — a human shell with no CRTR_NODE_ID is a legitimate root
 *  spawner (regression: `crtr node new --root` from outside a node used to
 *  throw here). */
export function resolveSpawner(
  parent: string | undefined,
  ctxNodeId: string | null,
  root: boolean,
): string | null {
  const spawner = parent ?? ctxNodeId ?? null;
  if (!root && spawner === null) {
    throw new Error('spawnChild requires a calling node (CRTR_NODE_ID) or an explicit parent');
  }
  return spawner;
}

/** Spawn a node from a live node. By default a managed terminal worker in a
 *  background window, with the spawner auto-subscribed (active) via spawnNode.
 *  With `root`: an independent resident root — parent=null, NO subscription back
 *  to the spawner (it carries spawned_by=spawner for provenance only), brought
 *  forefront so a human can pick up the conversation directly. */
export function spawnChild(opts: SpawnChildOpts): SpawnChildResult {
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const ctx = currentNodeContext();
  const root = opts.root === true;
  const spawner = resolveSpawner(opts.parent, ctx.nodeId ?? null, root);
  const mode = opts.mode ?? 'base';
  // Lifecycle keys on ROOT-ness only, independent of mode: an independent root
  // (or `--root`) is resident (a conversation that persists, woken by inbox/
  // human); every spawned child is terminal — it owes a final up the spine and
  // reaps when done. A child born as an orchestrator is terminal/orchestrator
  // (delegates + holds a roadmap, but still reports up), NOT resident.
  const lifecycle: Lifecycle = root ? 'resident' : 'terminal';
  // Spine: a managed child reports up to its spawner (has a manager); an
  // independent root sits top-of-spine with nobody to push to. Mirrors the
  // `parent` set below (root ? null : spawner), so hasManager === parent!==null.
  const { launch } = buildLaunchSpec(opts.kind, mode, { lifecycle, hasManager: !root, model: opts.model });
  // Born WITHOUT a name — the canvas-goal-capture extension names it async from
  // its first message (the kickoff task) inside its own pi process, so spawn
  // never blocks on the LLM naming round-trip (the 2-3s freeze it used to cost).
  const meta = spawnNode({
    kind: opts.kind,
    mode,
    lifecycle,
    cwd: opts.cwd,
    name: opts.name ?? opts.kind,
    // A root has no spine parent (top-level, nobody subscribes); it still
    // records spawned_by=spawner when a node (not a human shell) spawned it.
    // A child's parent IS its manager.
    parent: root ? null : spawner,
    spawnedBy: root ? (spawner ?? undefined) : undefined,
    // Persist the RAW fork reference (not the resolved path) as provenance, so
    // the boot intro can detect this is a fork and re-assert the node's own
    // identity over the source's copied-in conversation.
    forkFrom: opts.forkFrom,
    modelOverride: opts.model,
    launch,
  });

  // Persist the task as the child's goal for a fresh revive to re-read.
  writeGoal(meta.node_id, opts.prompt);

  // A fork copies an existing conversation into this child's first session
  // (resolved to an absolute file path when forking from a node). Resolved here
  // — not in buildPiArgv — so a bad reference fails the spawn loudly before any
  // window opens, rather than after pi is already booting.
  const forkFrom = opts.forkFrom !== undefined ? resolveForkSource(opts.forkFrom) : undefined;

  // A fork inherits the SOURCE node's entire first-person conversation, so the
  // identity re-assertion must ride the STRONGEST channel too, not only the
  // session-start bearings (a trailing custom_message the model weighs only by
  // recency). Prepend it to the kickoff PROMPT — the message that actually
  // triggers the fork's first turn, so the model acts on "you are node X, a
  // FORK of <source>, NOT them" as live instruction. When the daemon births this
  // node from a scheduled `spawn` wake, the <crtr-wake> provenance block leads
  // (so "a timer birthed you" precedes the task) — mirroring the fork-identity
  // prepend. Only the pi argv prompt is reframed; the persisted goal (writeGoal
  // above) keeps the raw task.
  const wakeBlock = opts.wakeOrigin !== undefined ? `${buildWakeBearings(opts.wakeOrigin)}\n\n` : '';
  const idBlock = forkFrom !== undefined ? `${buildIdentityAssertion(meta.node_id)}\n\n` : '';
  const kickoff = `${wakeBlock}${idBlock}${opts.prompt}`;

  // A child created DIRECTLY as an orchestrator (mode='orchestrator') boots
  // with the orchestrator persona but bypasses promote(), which is where a
  // roadmap scaffold would normally be seeded. Lay one down here (goal
  // pre-filled from the task) so the orchestrator has its memory artifact from
  // birth, instead of waking memory-less. Guarded so it never clobbers.
  if (mode === 'orchestrator' && !hasRoadmap(meta.node_id)) {
    seedRoadmap(meta.node_id, { goal: opts.prompt.trim() });
  }
  // (The three scoped long-term memory stores are seeded for EVERY node at birth
  // in spawnNode — no orchestrator-gated seeding needed here.)

  // A managed CHILD lands in the shared global session: inherited from the
  // parent's CRTR_ROOT_SESSION, else the default node session. A --root spawned
  // from inside tmux instead opens its window in the CALLER'S CURRENT session,
  // so it appears where the spawner is working rather than exiled to a separate
  // crtr session. Either way the root's OWN descendants still flow to the shared
  // session (childSession) via CRTR_ROOT_SESSION, to keep the subtree from
  // cluttering the user's session.
  const rootSessionEnv = process.env['CRTR_ROOT_SESSION'];
  const here = root ? currentTmux() : null;
  // The shared backstage the whole subtree flows into (this child's own
  // CRTR_ROOT_SESSION): the inherited root session, else the default `crtr`.
  const childSession = resolveBirthSession({ adoptCaller: false, here, rootSession: rootSessionEnv });
  // Where THIS node's window opens — and its durable REVIVE-HOME. A managed
  // child lands in the backstage; a --root adopts the caller's current session
  // when inside tmux, so it appears where the spawner is working.
  const session = resolveBirthSession({ adoptCaller: root, here, rootSession: rootSessionEnv });
  ensureSession(session, opts.cwd);
  // REVIVE-HOME set once at birth: a managed child's revive target is the
  // backstage, never a user session — this is what keeps a background revive
  // off the user's screen (the focus taint cannot reach it).
  updateNode(meta.node_id, { home_session: session });

  const inv = buildPiArgv(meta, { prompt: kickoff, forkFrom });
  // Authoritative backstage routing on inv.env (the broker host merges it into
  // the detached broker process): CRTR_ROOT_SESSION (this subtree's shared
  // backstage, where the node's descendants land) + CRTR_SUBTREE (its spine
  // root). The host sets CRTR_FRONT_DOOR itself.
  inv.env = { ...inv.env, CRTR_ROOT_SESSION: childSession, CRTR_SUBTREE: rootOfSpine(meta.node_id) };

  // Broker is the only host (§A.3): launch the detached broker ENGINE, wait for
  // its view.sock, then open a BACKGROUND viewer window — today's "spawn → a
  // window appears" UX, except the window now runs a `crtr attach` VIEWER of the
  // broker instead of the engine itself. The node row carries no presence; the
  // viewer pane lives in the focuses table (registerViewerFocus, inside
  // openViewerWindow).
  const placed = headlessBrokerHost.launch(meta.node_id, inv, {
    cwd: meta.cwd,
    name: fullName(meta),
    resuming: false,
  });
  // Definitive failure: no broker pid ⇒ the node has no engine. Crash it (so the
  // daemon doesn't watch a zombie 'active') and throw so `crtr node new` exits
  // non-zero. transition('crash') is a legal from-LIVE move (still 'active' from
  // spawnNode). Mirrors the old window===null crash.
  if (placed.pid === null) {
    transition(meta.node_id, 'crash');
    throw new Error(
      `failed to launch the broker engine for ${meta.node_id} (${meta.name}) — the node was not started.`,
    );
  }

  // Wait for the broker to bind view.sock (≤30s; by acceptance pi_pid is
  // recorded). On timeout the broker is still booting or its boot failed — that
  // is the daemon's boot-grace / surfaceBootFailure concern, NOT ours: a missing
  // viewer is not a missing engine. Return the node active with no viewer; the
  // user gets one on the next `focus`. Do NOT crash.
  let window: string | null = null;
  if (waitForBrokerViewSocket(meta.node_id)) {
    // Open the node's one background viewer in its target session. A managed child
    // lands in the shared backstage; a --root opens in the caller's current
    // session (both resolved above as `session`). Non-fatal if tmux refuses
    // (openViewerWindow returns null) — `focus` opens a viewer later.
    const viewer = openViewerWindow(meta.node_id, session, { name: fullName(meta), cwd: opts.cwd });
    if (viewer !== null && viewer.pane !== null && viewer.pane !== '') {
      window = windowOfPane(viewer.pane);
      // A --root is spawned to be driven directly — bring its viewer forefront so
      // whoever asked for it picks up the conversation. A child stays background.
      if (root && window !== null) {
        try { focusWindow(session, window); } catch { /* best-effort */ }
      }
    }
  }
  const saved = getNode(meta.node_id) as NodeMeta;
  return { node: saved, window, session };
}
