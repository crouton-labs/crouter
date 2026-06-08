// The spawn orchestration — the one place that turns "I want a node here" into
// a running pi process on the canvas. Composes canvas (birth + spine), persona
// (resolve), launch (pi argv), and tmux (placement).
//
//   bootRoot   — the user-opened front door (bare `crtr`). Resident; runs pi
//                inline, taking over the current terminal.
//   spawnChild — a node spawned by a live node (`crtr node new`). A managed,
//                terminal background worker by default; with `root`, an
//                INDEPENDENT resident root (no subscription back to the spawner,
//                provenance via spawned_by) brought forefront for direct driving.

import { spawnSync } from 'node:child_process';
import { FRONT_DOOR_ENV } from './front-door.js';
import { spawnNode, currentNodeContext, nodeEnv, resolveBirthSession, nodeSession, rootOfSpine } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { writeGoal } from './kickoff.js';
import { hasRoadmap, seedRoadmap } from './roadmap.js';
import { generateSessionName } from './naming.js';
import { buildIdentityAssertion, buildWakeBearings, type WakeOrigin } from './bearings.js';
import { installMenuBinding, installNavBindings, installViewNavBindings } from './tmux-chrome.js';
import { setPresence, updateNode, getNode, fullName, type NodeMeta, type Mode, type Lifecycle } from '../canvas/index.js';
import {
  registerRootFocus,
  ensureSession,
  openNodeWindow,
  piCommand,
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

/** Create a root node and bring up its pi. Returns the node; for 'inline' this
 *  only returns after pi exits (it took over the terminal). */
export function bootRoot(opts: BootRootOpts): NodeMeta {
  // The thin supervisor must be up before any node exists, so a refresh-yield
  // or crash can be reaped/revived. Idempotent.
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const kind = opts.kind ?? 'general';
  // A born-resident root starts in base mode; it earns the orchestrator persona
  // the first time it delegates (or on promotion). Resident lifecycle either way.
  const { launch } = buildLaunchSpec(kind, 'base', { lifecycle: 'resident', hasManager: false });
  // A root opened WITH a prompt gets its editor name now (so the first pi
  // session already carries it). A bare root has no prompt yet — the
  // goal-capture extension names it from the first message (async, next cycle).
  const description =
    opts.prompt !== undefined && opts.prompt.trim() !== ''
      ? generateSessionName(opts.prompt)
      : undefined;
  const meta = spawnNode({
    kind,
    mode: 'base',
    lifecycle: 'resident',
    cwd: opts.cwd,
    name: opts.name ?? kind,
    description,
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

  // inline: the root's pi takes over THIS terminal, so its own window stays
  // where the user is (its tmux_session tracks that real pane so supervision
  // sees it alive). But its children spawn into the shared global session via
  // CRTR_ROOT_SESSION — they never clutter the user's working session.
  const here = currentTmux();
  const adopted = resolveBirthSession({ adoptCaller: true, here, rootSession: undefined });
  setPresence(meta.node_id, { tmux_session: adopted, window: here?.window ?? null, pane: here?.pane ?? null });
  // REVIVE-HOME: the inline root's durable revive target is the session it
  // adopts (the caller's when inside tmux, else the shared backstage). Set once
  // at birth, alongside the live LOCATION above.
  updateNode(meta.node_id, { home_session: adopted });
  // Root boot registers focus #1 (§2.6): the FOREGROUND inline root owns the
  // user's viewport, so its OWN pane becomes a durable focus (remain-on-exit so
  // a clean exit freezes rather than detaching the terminal). A background
  // `--root` (spawnChild) does NOT — it stays a plain window until the user
  // focuses it (§6). Only possible inside tmux (a pane to anchor on).
  if (here) {
    try { registerRootFocus(meta.node_id, here.pane, adopted, here.window); } catch { /* best-effort */ }
  }
  const withSession = getNode(meta.node_id) as NodeMeta;
  const inv = buildPiArgv(withSession, { prompt: opts.prompt });
  const env = { ...process.env, ...inv.env, CRTR_ROOT_SESSION: session, CRTR_SUBTREE: rootOfSpine(meta.node_id), [FRONT_DOOR_ENV]: '1' } as NodeJS.ProcessEnv;
  const r = spawnSync('pi', inv.argv, { stdio: 'inherit', env });
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
  /** Which HOST launches + supervises this node: a tmux pane (default) or the
   *  headless broker. Persisted as `host_kind` at birth (resolved from
   *  `--headless` / the `headless` config default by the caller). */
  hostKind?: 'tmux' | 'broker';
}

/** Resolve a `--fork-from` value to the source pi gets as `--fork <path|id>`.
 *  A live node id resolves to its captured session FILE (absolute, cwd-immune),
 *  falling back to its bare session id; a path or partial uuid passes straight
 *  through to pi. Throws when a known node has no session to fork yet. */
export function resolveForkSource(value: string): string {
  const v = value.trim();
  if (v === '') throw new Error('--fork-from requires a node id, session file, or session uuid.');
  // A path (contains `/` or ends `.jsonl`) is a session file — hand it to pi as-is.
  if (v.includes('/') || v.endsWith('.jsonl')) return v;
  // A live node id — fork from the conversation it has accumulated.
  const n = getNode(v);
  if (n !== null) {
    const src = n.pi_session_file ?? n.pi_session_id;
    if (src === undefined || src === null || src === '') {
      throw new Error(`node ${v} has no pi session yet — it has not started a conversation to fork from.`);
    }
    return src;
  }
  // Not a known node — treat as a bare/partial pi session id for pi to resolve.
  return v;
}

export interface SpawnChildResult {
  node: NodeMeta;
  window: string | null;
  session: string;
}

/** Spawn a node from a live node. By default a managed terminal worker in a
 *  background window, with the spawner auto-subscribed (active) via spawnNode.
 *  With `root`: an independent resident root — parent=null, NO subscription back
 *  to the spawner (it carries spawned_by=spawner for provenance only), brought
 *  forefront so a human can pick up the conversation directly. */
export function spawnChild(opts: SpawnChildOpts): SpawnChildResult {
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const ctx = currentNodeContext();
  const spawner = opts.parent ?? ctx.nodeId;
  if (spawner === null || spawner === undefined) {
    throw new Error('spawnChild requires a calling node (CRTR_NODE_ID) or an explicit parent');
  }

  const root = opts.root === true;
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
  const { launch } = buildLaunchSpec(opts.kind, mode, { lifecycle, hasManager: !root });
  // Name the worker from its task now, so its first editor label carries it.
  const meta = spawnNode({
    kind: opts.kind,
    mode,
    lifecycle,
    cwd: opts.cwd,
    name: opts.name ?? opts.kind,
    description: generateSessionName(opts.prompt),
    // A root has no spine parent (top-level, nobody subscribes); it still
    // records spawned_by=spawner. A child's parent IS its manager.
    parent: root ? null : spawner,
    spawnedBy: root ? spawner : undefined,
    // Persist the RAW fork reference (not the resolved path) as provenance, so
    // the boot intro can detect this is a fork and re-assert the node's own
    // identity over the source's copied-in conversation.
    forkFrom: opts.forkFrom,
    hostKind: opts.hostKind,
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
  // Belt-and-suspenders backstage routing emitted at EVERY launch site: the
  // authoritative CRTR_ROOT_SESSION (this subtree's shared backstage) +
  // CRTR_SUBTREE (this node's spine root). Hoisted ABOVE the host branch so the
  // broker launch and the tmux command consume ONE authoritative env — the
  // broker host merges inv.env, so a --headless --root broker would otherwise
  // inherit the SPAWNER's subtree id via the lossy nodeEnv passthrough (review
  // reuse MINOR-2). FRONT_DOOR is added per-consumer below (the broker host sets
  // it itself; the tmux env const adds it).
  inv.env = { ...inv.env, CRTR_ROOT_SESSION: childSession, CRTR_SUBTREE: rootOfSpine(meta.node_id) };

  // Birth LAUNCH branch on the PERSISTED host_kind (set at birth by spawnNode).
  // A broker birth diverts AWAY from the tmux pane: the headless broker host
  // launches a detached broker process (which records its own pid as pi_pid via
  // the stophook) and returns placement fields all null — so we open NO tmux
  // window and write NO tmux placement (presence stays null for a broker). The
  // tmux path below is left completely UNCHANGED (byte-identical) for every
  // non-broker spawn. Mirrors reviveNode's `hostFor(meta).launch(...)` shape.
  if (meta.host_kind === 'broker') {
    const placed = headlessBrokerHost.launch(meta.node_id, inv, {
      cwd: meta.cwd,
      name: fullName(meta),
      resuming: false,
    });
    const saved = getNode(meta.node_id) as NodeMeta;
    return { node: saved, window: placed.window, session: placed.session };
  }

  const env = { ...inv.env, [FRONT_DOOR_ENV]: '1' };
  const command = piCommand(inv.argv);

  // openNodeWindow now returns {window, pane}; pane is unused until the
  // placement layer lands, so destructure the window and proceed unchanged.
  const opened = openNodeWindow({
    session,
    name: fullName(meta),
    cwd: opts.cwd,
    env,
    command,
  });
  const window = opened?.window ?? null;

  // Two-stage failure model. Opening the window is instant and definitive, so a
  // failure here is reported SYNCHRONOUSLY: crash the node (so it isn't a zombie
  // 'active' the daemon can't reap — it has no window to watch) and throw so
  // `crtr node new` exits non-zero with a clear message for the caller. The node
  // is still 'active' from spawnNode, so transition('crash') is a legal from-LIVE
  // move — the last scattered node-status write, now through the lifecycle machine.
  //
  // pi BOOTING inside the window, by contrast, is inherently slow (and slower
  // under load), so we stay optimistic and return status='active' the instant
  // the window exists. A vehicle that then dies before its first session_start
  // is caught by the daemon — it surfaces the boot failure up the spine rather
  // than letting the node die silently (see crtrd.ts surfaceBootFailure).
  if (window === null) {
    transition(meta.node_id, 'crash');
    throw new Error(
      `failed to open a tmux window for ${meta.node_id} (${meta.name}) in session '${session}' — the node was not started.`,
    );
  }

  setPresence(meta.node_id, { tmux_session: session, window });
  const saved = getNode(meta.node_id) as NodeMeta;
  // A root is spawned to be driven directly — bring it forefront so whoever
  // asked for it picks up the conversation. A child stays a background window.
  if (root) {
    try { focusWindow(session, window); } catch { /* best-effort */ }
  }
  return { node: saved, window, session };
}
