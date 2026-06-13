// broker.ts — the headless node broker (design §4, §5; plan T4).
//
// One broker process per node — the SOLE host. It hosts ONE pi engine IN-PROCESS
// via the SDK (createAgentSession), is the SOLE writer of the node's session
// `.jsonl`, listens on `nodeDir(id)/view.sock`, fans the single engine event
// stream out to N viewers, serializes a single controller's drive commands, and
// routes blocking extension dialogs. The engine has no terminal of its own; a
// tmux pane (or web tab) is only a viewer of this socket. It
// runs one turn-cycle and, when the engine settles (the stophook calls
// ctx.shutdown(), or the engine goes idle), disposes the engine and exits 0 —
// the daemon then routes revival per the intent the bound stophook set.
//
// Engine resolution flows through broker-sdk.ts (`loadBrokerEngine`) so the T11
// `CRTR_BROKER_ENGINE` test seam can swap a fake engine in. The resource loader
// + model registry are real SDK construction helpers (NOT part of the swappable
// engine seam — the fake engine receives the real, extension-loaded loader so
// the real canvas-stophook fires session_start).

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getAgentDir,
  initTheme,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent';
import { jobDir, nodeDir } from '../canvas/paths.js';
import { getNode, updateNode } from '../canvas/index.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { piInvocationToSdkConfig, type BrokerSdkConfig, type PiInvocation } from './launch.js';
import { assertEngineVersion, loadBrokerEngine, type BrokerEngine } from './broker-sdk.js';
import { BUILTIN_SLASH_COMMANDS } from './pi-vendored.js';
import {
  encodeFrame,
  FrameDecoder,
  FrameOverflowError,
  BROKER_READ_CAPS,
  type BrokerSnapshot,
  type BrokerToClient,
  type ClientRole,
  type ClientToBroker,
  type GetSettingsData,
  type GetTreeData,
  type ListModelsData,
  type ListScopedModelsData,
  type ListSessionsData,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type WireForkPoint,
  type WireModelRef,
  type WireSessionInfo,
  type WireSettings,
} from './broker-protocol.js';

// ---------------------------------------------------------------------------
// Tunables (T3 backpressure / T4 dialog anti-deadlock)
// ---------------------------------------------------------------------------

/** Per-viewer outbound high-water mark (M1). A viewer whose unflushed backlog
 *  exceeds EITHER bound is DROPPED (socket destroyed) rather than allowed to
 *  apply indefinite backpressure to the shared engine. Modeled on pi's RPC
 *  output-guard: bound the queue, shed the slow viewer. */
const MAX_QUEUED_FRAMES = 1000;
const MAX_PENDING_BYTES = 32 * 1024 * 1024; // 32 MiB

/** F2 (attach typing-lag fix, 2026-06-09): coalesce window for relayed
 *  `message_update` frames. pi emits one per content delta and each carries the
 *  FULL accumulated assistant message, so a verbatim relay re-serializes (and
 *  every viewer re-parses + re-renders) the whole message per token — O(len²)
 *  bytes over a long reply, and measured ~3× the viewer's render CPU vs 75 ms
 *  coalescing. Only the LATEST pending update matters (each supersedes the
 *  last), so the relay keeps one and flushes it on this timer — or immediately,
 *  BEFORE any other event type, preserving ordering (an update never arrives
 *  after its message_end). */
const MESSAGE_UPDATE_COALESCE_MS = 75;

/** Broker-side default dialog timeout (C2 anti-deadlock, T4). When an extension
 *  dialog is forwarded to a controller, the broker ALWAYS arms a timeout (this
 *  default, or a shorter per-dialog `opts.timeout` if the extension passed one)
 *  so a controller that never answers — or detaches and is never replaced — can
 *  never hang the agent turn forever. On fire it resolves to the SAFE default
 *  (deny for confirm; cancel/undefined for select/input/editor). */
const DEFAULT_DIALOG_TIMEOUT_MS = 120_000; // 120 s

// ---------------------------------------------------------------------------
// Per-client connection state
// ---------------------------------------------------------------------------

interface BrokerClient {
  id: string;
  role: ClientRole;
  socket: Socket;
  decoder: FrameDecoder;
  helloed: boolean;
  /** Unflushed outbound bytes handed to `socket.write` but not yet flushed to the
   *  OS (M1 backpressure accounting). Incremented before each write, decremented
   *  in that write's completion callback. */
  pendingBytes: number;
  /** Outbound frames written but not yet flushed (the queue-depth half of the
   *  high-water mark). */
  queuedFrames: number;
}

/** A blocking dialog awaiting the controller's response, the broker-side default
 *  timeout, or the engine's abort. */
interface PendingDialog {
  /** The original request (T4) — retained so `welcome.pending_dialog` and the
   *  re-route-on-become-controller path can re-deliver a still-pending dialog to
   *  a (new) controller. The Wave-0 shape stored only the resolver. */
  request: RpcExtensionUIRequest;
  /** The controller answered — resolve with its parsed response (also clears the
   *  broker-side timeout and removes the entry from the registry). */
  resolve: (response: RpcExtensionUIResponse) => void;
}

// ---------------------------------------------------------------------------
// M3 (scout mq5thyli): the active engine session, exposed so broker-cli's FATAL
// handlers (uncaughtException / unhandledRejection / the runBroker reject) can
// dispose it before process.exit. The bash tool spawns children `detached` (own
// pgid); only session.dispose() (→ abortBash / agent.abort → killProcessTree)
// reaps them. The graceful exit path already disposes; without this the crash
// path would `process.exit(1)` and ORPHAN every in-flight bash subprocess.
// ---------------------------------------------------------------------------
let activeSession: { dispose: () => void } | null = null;

/** Dispose the live engine session if one exists (idempotent). Called by
 *  broker-cli's fatal handlers before exit so a crash never orphans detached
 *  bash children. No-op before the session is built or after a clean dispose. */
export function disposeActiveSession(): void {
  const s = activeSession;
  activeSession = null;
  if (s !== null) {
    try {
      s.dispose();
    } catch {
      /* dispose must not block the fatal exit */
    }
  }
}

// ---------------------------------------------------------------------------
// runBroker — the broker process body (plan T4 steps 1–6)
// ---------------------------------------------------------------------------

export async function runBroker(nodeId: string): Promise<void> {
  // Defensive: any `crtr` child the engine/extensions spawn must inherit the
  // front-door recursion guard (runtime/CLAUDE.md fork-bomb invariant). The host
  // (T6) also sets this; we set it again so the broker is self-sufficient.
  process.env[FRONT_DOOR_ENV] = '1';

  // The broker is PANELESS and detached, but a broker spawned by a tmux-resident
  // parent inherits the parent's TMUX_PANE/TMUX in its env (the launcher spawns
  // with {...process.env}). Left in place, every `crtr` command the engine runs
  // (bash tool, goal-capture naming, a child spawn) would resolve `currentTmux()`
  // to the PARENT's pane/session and act there — e.g. open viewers beside, or
  // close, the parent's pane. Strip both so this broker's children see no tmux
  // context and take their paneless path.
  delete process.env['TMUX_PANE'];
  delete process.env['TMUX'];

  // 1. Version tripwire + load the launch recipe the host serialized.
  const engine = await loadBrokerEngine();
  assertEngineVersion(engine.VERSION);

  // M4 / M6 (scout mq5thyli) — DELIBERATELY SKIPPED on the 0.78.1 pin. Both
  // `configureHttpDispatcher` (M4: proxy support + the undici decompression fix)
  // and `runMigrations` (M6: config/auth migration for a box where the pi CLI
  // never ran) are CLI-only helpers that the pinned SDK does NOT re-export: the
  // package's `exports` map is `.`-only, neither symbol is in `dist/index.d.ts`,
  // a deep import (`.../dist/core/http-dispatcher.js`) is blocked with
  // ERR_PACKAGE_PATH_NOT_EXPORTED, and the only exports-map entries are `.` and
  // `./hooks` (neither carries these symbols). Per the "verify export; skip-with-
  // note if absent" directive we do not vendor or reach around the export wall.
  // Revisit when the SDK pin bumps to a version that re-exports them publicly.

  const dir = nodeDir(nodeId);
  const launchFile = join(dir, 'broker-launch.json');
  const inv = JSON.parse(readFileSync(launchFile, 'utf8')) as PiInvocation;
  const cfg: BrokerSdkConfig = piInvocationToSdkConfig(inv); // also merges inv.env

  // 2–4. Build the engine session via the SERVICES path (C3) — see
  //       buildBrokerSession below. Register it so the FATAL exit path (M3) can
  //       dispose it and reap detached bash children.
  // `session` + `services` are MUTABLE holders (T3 session-rebind): when the
  // controller drives new_session/switch_session/fork, the AgentSessionRuntime
  // tears down the old session and builds the next one, then runs our rebind
  // callback which reassigns these. Every closure below (buildSnapshot,
  // driveEngine, handleFrame, disposeAndExit) reads through them, so they all
  // follow the live session automatically. `runtime` is undefined for an engine
  // that does not expose the replacement API (the fake-engine fixture).
  // eslint-disable-next-line prefer-const
  let { session, services, resuming, runtime } = await buildBrokerSession(engine, cfg);
  activeSession = session;
  // Initialize pi's process-global theme. The pi binary does this at boot
  // (main.js: initTheme(settingsManager.getTheme(), appMode === 'interactive')),
  // but the SDK convenience path the broker uses does NOT. Without it, ANY
  // extension hook that reads `ctx.ui.theme` throws "Theme not initialized" —
  // and the extension runner SILENTLY swallows that throw and discards the
  // hook's returned payload. The visible symptom was the OAuth billing adapter's
  // before_provider_request handler throwing, so its injected Claude-Code billing
  // header was dropped and subscription turns 400'd ("draws from extra usage").
  // headless ⇒ no file watcher (false). Idempotent global; call once at boot.
  try {
    initTheme(services.settingsManager.getTheme(), false);
  } catch (err) {
    process.stderr.write(`[broker] WARNING: initTheme failed: ${String(err)}\n`);
  }
  // N3: the node's display name is re-applied inside rebindSession (below) so it
  // survives a session replacement (new_session/switch_session/fork), not only at
  // boot.

  // -------------------------------------------------------------------------
  // Socket fan-out + controller arbitration state
  // -------------------------------------------------------------------------
  const sockPath = join(dir, 'view.sock');
  const attachPath = join(jobDir(nodeId), 'attach.json');
  const clients = new Set<BrokerClient>();
  const pendingDialogs = new Map<string, PendingDialog>();
  let controllerId: string | null = null;
  let disposed = false;
  let server: Server | undefined;

  // Liveness-aware: a controllerId whose client's transport is already gone counts
  // as NO controller, so control self-heals the instant a controller's peer departs
  // — WITHOUT waiting for the socket 'close' event. On a unix socket a peer
  // destroy() delivers EOF (readableEnded) promptly, but the matching 'close' can
  // lag arbitrarily while undrainable pending writes to the gone peer flush; under
  // load that lag stranded control on a dead client and froze admission (a fresh
  // controller hello was denied for the whole window — the one-writer reattach
  // deadlock the G9 gate locks). Treating an ended/destroyed/unwritable holder as
  // free closes that window at every read of the controller (admission included).
  const controllerClient = (): BrokerClient | null => {
    if (controllerId === null) return null;
    for (const c of clients) {
      if (c.id !== controllerId) continue;
      if (c.socket.destroyed || c.socket.readableEnded || !c.socket.writable) return null;
      return c;
    }
    return null;
  };

  // Persist viewer presence to job/attach.json on every viewer state change
  // (hello accepted, client drop/shed, control handoff) so out-of-process
  // readers (the GRAPH view's attached-row tint) can see whether a human is
  // watching this paneless node. Plain writeFileSync, matching telemetry.json's
  // convention; best-effort — presence writing must never crash the broker.
  // disposeAndExit unlinks the file, so a clean exit never leaves a stale claim
  // (readers additionally trust it only while the node is 'active', fencing off
  // a crash-orphaned file).
  const persistAttachState = (): void => {
    try {
      let viewers = 0;
      for (const c of clients) if (c.helloed) viewers += 1;
      const dirPath = jobDir(nodeId);
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
      writeFileSync(
        attachPath,
        JSON.stringify(
          { viewers, controller_id: controllerId, updated: new Date().toISOString() },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* presence is best-effort; never crash the broker */
    }
  };

  // The host redirects the broker's stdout+stderr to job/broker.log (host.ts), so
  // stderr is the broker's durable log sink (boot/crash diagnostics already use it).
  const logBroker = (msg: string): void => {
    try {
      process.stderr.write(`[broker] ${msg}\n`);
    } catch {
      /* best effort */
    }
  };

  // Free control if the departing/dropped client held it (shared by drop +
  // dropSlowClient). controllerId can outlive the socket until 'close' fires, so
  // releasing here keeps arbitration correct the instant a controller is shed.
  const releaseControlIfHeldBy = (client: BrokerClient): void => {
    if (client.id !== '' && client.id === controllerId) {
      controllerId = null;
      broadcastControlChanged();
    }
  };

  // Shed a client — destroy the socket + remove it + release its control — used by
  // both the M1 backpressure drop and the G7 frame-overflow drop. 'close' (→ drop)
  // follows the destroy; releasing control here makes the shed immediate so a
  // misbehaving controller can't keep arbitration pinned until 'close' fires.
  const dropClient = (client: BrokerClient, reason: string): void => {
    if (!clients.has(client)) return; // already gone
    logBroker(`dropping viewer ${client.id || '(pre-hello)'} — ${reason}`);
    clients.delete(client);
    persistAttachState(); // a viewer was shed
    releaseControlIfHeldBy(client);
    try {
      client.socket.destroy();
    } catch {
      /* ignore */
    }
  };

  // `bypassHwm` (F1): the catch-up `welcome` carries the full message history and
  // can legitimately be tens of MiB — far larger than a steady-state live frame.
  // It is still ACCOUNTED (so a genuinely stalled client that also floods on live
  // events is still shed by the NEXT frame's check), but it must never be the
  // REASON a healthy client is dropped before it has had a chance to drain it.
  const sendFrame = (client: BrokerClient, frame: BrokerToClient, bypassHwm = false): void => {
    let data: string;
    try {
      data = encodeFrame(frame);
    } catch {
      return; // an unserializable frame must never crash the broker
    }
    const bytes = Buffer.byteLength(data);
    // M1 high-water mark: a viewer that has fallen too far behind on draining its
    // socket is shed rather than allowed to grow the broker's memory unbounded.
    if (
      !bypassHwm &&
      (client.queuedFrames + 1 > MAX_QUEUED_FRAMES ||
        client.pendingBytes + bytes > MAX_PENDING_BYTES)
    ) {
      dropClient(
        client,
        `backpressure high-water mark exceeded (queued=${client.queuedFrames}, pending=${client.pendingBytes}B)`,
      );
      return;
    }
    client.queuedFrames += 1;
    client.pendingBytes += bytes;
    try {
      // The per-write completion callback fires when THIS chunk is flushed to the
      // OS — a finer-grained drain signal than a socket-wide 'drain' event, and it
      // keeps the accounting exact. write()'s boolean return is the coarse
      // "buffer full" hint; the per-chunk callback is what we account on.
      client.socket.write(data, () => {
        client.queuedFrames -= 1;
        client.pendingBytes -= bytes;
      });
    } catch {
      // Dead socket: undo this frame's accounting; 'close' → drop() cleans the rest.
      client.queuedFrames -= 1;
      client.pendingBytes -= bytes;
    }
  };

  const broadcast = (frame: BrokerToClient): void => {
    for (const c of clients) if (c.helloed) sendFrame(c, frame);
  };

  // ---------------------------------------------------------------------------
  // F2: message_update coalescing. `relayEvent` is the single entry point for
  // engine events headed to viewers: a message_update is held (latest wins) and
  // flushed on a short timer; ANY other event flushes the held update first,
  // synchronously, so cross-type ordering is exactly the engine's. The timer is
  // unref'd — it must never hold the broker process open past dispose.
  // ---------------------------------------------------------------------------
  let pendingUpdate: BrokerToClient | null = null;
  let pendingUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  const flushPendingUpdate = (): void => {
    if (pendingUpdateTimer !== null) {
      clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = null;
    }
    if (pendingUpdate !== null) {
      const frame = pendingUpdate;
      pendingUpdate = null;
      broadcast(frame);
    }
  };
  const relayEvent = (event: BrokerToClient): void => {
    if ((event as { type?: string }).type === 'message_update') {
      pendingUpdate = event; // latest full-message update supersedes the held one
      if (pendingUpdateTimer === null) {
        pendingUpdateTimer = setTimeout(flushPendingUpdate, MESSAGE_UPDATE_COALESCE_MS);
        if (typeof pendingUpdateTimer.unref === 'function') pendingUpdateTimer.unref();
      }
      return;
    }
    // Any non-update event: flush the held update FIRST so a viewer never sees
    // (e.g.) message_end before the update it supersedes — then relay verbatim.
    flushPendingUpdate();
    broadcast(event);
  };

  const broadcastControlChanged = (): void => {
    persistAttachState(); // every control change is a viewer-state change
    broadcast({ type: 'control_changed', controller_id: controllerId });
  };

  // Persist a live model switch into the node's durable launch recipe so it
  // survives a yield/revive. pi's `/model` (→ set_model/cycle_model) only
  // mutates the in-memory engine; without this the node reverts to its
  // persona/spawn model on the next revive. We write the full `provider/id`
  // (which normalizeModel passes through unchanged) to BOTH model_override (so
  // polymorphs preserve it via buildLaunchSpec) and launch.model (the recipe
  // buildPiArgv replays on revive). Best-effort: a degenerate/ephemeral node
  // with no canvas row just skips persistence. CRTR_NODE_ID is set in the
  // broker's own env (merged by piInvocationToSdkConfig at boot).
  const persistModelChoice = (): void => {
    const nodeId = process.env['CRTR_NODE_ID'];
    const m = session.model;
    if (nodeId === undefined || nodeId === '' || m === null || m === undefined) return;
    const spec = `${m.provider}/${m.id}`;
    try {
      const meta = getNode(nodeId);
      if (meta === null) return;
      const launch = meta.launch !== undefined ? { ...meta.launch, model: spec } : undefined;
      updateNode(nodeId, { model_override: spec, ...(launch !== undefined ? { launch } : {}) });
    } catch {
      // Persistence is best-effort; the live switch already succeeded.
    }
  };

  // pi emits no AgentSessionEvent for a model switch, so after a successful
  // set_model/cycle_model the broker announces it itself — otherwise the new
  // model reaches no viewer (the requester gets only a bare ack) and every
  // footer shows the stale model until the next unrelated event.
  const broadcastModelChanged = (): void => {
    persistModelChoice();
    broadcast({ type: 'model_changed', model: session.model?.id });
  };

  const buildSnapshot = (): BrokerSnapshot => ({
    messages: snapshotMessages(session),
    stats: session.getSessionStats(),
    state: {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      model: session.model?.id,
      isStreaming: session.isStreaming,
      // §1.3.2 — pure getter reads mirroring RPC get_state (viewer footer parity).
      thinkingLevel: session.thinkingLevel,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionName: session.sessionName,
      autoCompactionEnabled: session.autoCompactionEnabled,
      pendingMessageCount: session.pendingMessageCount,
    },
  });

  // Send a client its catch-up snapshot. welcome.pending_dialog carries a single
  // still-in-flight dialog to a controller attaching mid-dialog (T4); only the
  // controller can answer one, so observers get null. The pendingDialogs map is
  // insertion-ordered — the first entry is the canonical one carried here; any
  // extras are re-routed explicitly by the caller (rare: concurrent dialogs).
  const sendWelcome = (client: BrokerClient): void => {
    const first =
      client.role === 'controller' ? pendingDialogs.values().next().value : undefined;
    sendFrame(
      client,
      {
        type: 'welcome',
        snapshot: buildSnapshot(),
        role: client.role,
        controller_id: controllerId,
        pending_dialog: first !== undefined ? first.request : null,
        agentDir: getAgentDir(),
      },
      true, // F1: a large catch-up snapshot must not trip the HWM on a fresh client
    );
  };

  // T4 re-route on become-controller: a dialog raised while a prior controller was
  // attached stays pending after that controller detaches (it is NOT cancelled —
  // see makeBrokerUiContext / the M2 keep-pending fix), so whoever takes control
  // next must be handed it to answer.
  const reroutePendingDialogsTo = (client: BrokerClient): void => {
    for (const d of pendingDialogs.values()) sendFrame(client, d.request);
  };

  // After a session-replacing op (new_session/switch_session/fork) the engine's
  // entire message history changed, so every attached viewer must rebuild from a
  // fresh snapshot of the NEW session.
  const reWelcomeAll = (): void => {
    for (const c of clients) if (c.helloed) sendWelcome(c);
  };

  // -------------------------------------------------------------------------
  // The single exit helper (plan §0): dispose the engine, close + unlink the
  // socket, exit 0. Idempotent — every trigger converges here.
  // -------------------------------------------------------------------------
  const disposeAndExit = (_reason: string): void => {
    if (disposed) return;
    disposed = true;
    activeSession = null; // graceful path owns dispose; keep the fatal hook a no-op
    try {
      session.dispose();
    } catch {
      /* dispose must not block exit */
    }
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
    try {
      // A clean exit never leaves a stale presence claim behind.
      if (existsSync(attachPath)) unlinkSync(attachPath);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  // -------------------------------------------------------------------------
  // Extension-dialog routing (C2). makeBrokerUiContext owns the dialogPromise;
  // here we just give it the three broker-side hooks it needs: who the current
  // controller is (null = zero viewers → noOp fallback), how to forward a dialog
  // to that controller, and the pending-dialog registry the controller answers
  // through. The zero-viewer path NEVER hangs and NEVER waits on a per-dialog
  // timeout (design §5.4's timeout premise is false — see makeBrokerUiContext).
  // -------------------------------------------------------------------------
  const uiContext = makeBrokerUiContext({
    controller: controllerClient,
    forward: (client, request) => sendFrame(client, request),
    pending: pendingDialogs,
    broadcast,
  });

  // -------------------------------------------------------------------------
  // 3+4 (plan): bind the FULL canvas extensions (mode 'print') AND fan the single
  // engine event stream to all clients, VERBATIM — both wrapped in one
  // `rebindSession` so a session-replacing op (new_session/switch_session/fork)
  // can re-run them against the NEW session. This mirrors pi's rpc-mode
  // rebindSession (rpc-mode.js:227): the AgentSessionRuntime tears down the old
  // session, builds the next, then calls this back; we re-bind extensions and
  // re-subscribe so the canvas hooks + the fan-out follow the live session.
  //
  // bindExtensions fires session_start → the stophook records pi_session_id/file
  // + recordPid(pid); the shutdownHandler is the precise broker-exit trigger (the
  // stophook calls ctx.shutdown() only in its done / idle-release / refresh
  // branches, NOT on reprompt). The engine-driven exit is deliberately NOT
  // inferred from raw agent_end in the relay: the bound stophook is the SOLE
  // authority on when the node stops — it exits synchronously at
  // agent-session.js:266, BEFORE this subscriber runs at :268, with intent
  // already persisted; in every OTHER branch it STAYS ALIVE. An agent_end idle
  // heuristic would override those stay-alive decisions, so there is no such
  // backstop; shutdownHandler + the inbound `shutdown` frame are the only exits.
  //
  // m7: the subscriber body is wrapped in try/catch — a synchronous throw out of
  // a subscriber otherwise propagates as a run failure that would crash the broker.
  // -------------------------------------------------------------------------
  let unsubscribe: (() => void) | undefined;
  const rebindSession = async (): Promise<void> => {
    if (runtime !== undefined) {
      session = runtime.session; // the runtime replaced it; follow the new one
      services = runtime.services;
    }
    activeSession = session; // keep the fatal-exit hook pointed at the live session
    await session.bindExtensions({
      uiContext,
      mode: 'print',
      shutdownHandler: () => disposeAndExit('shutdown-hook'),
    });
    if (cfg.editorName !== undefined && cfg.editorName !== '') {
      try {
        session.setSessionName(cfg.editorName); // N3: re-apply across session replacement
      } catch {
        /* non-fatal: naming is cosmetic */
      }
    }
    unsubscribe?.();
    // F2: a session replacement abandons the old session's stream — drop (don't
    // flush) a held update from it; its message history is superseded by the
    // reWelcomeAll() snapshot of the NEW session.
    if (pendingUpdateTimer !== null) {
      clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = null;
    }
    pendingUpdate = null;
    unsubscribe = session.subscribe((event) => {
      try {
        relayEvent(event as BrokerToClient);
      } catch (err) {
        logBroker(`event relay threw: ${String(err)}`);
      }
    });
  };
  // Register the rebind BEFORE the first bind so a replacement triggered during
  // startup is honored; then do the initial bind + subscribe.
  runtime?.setRebindSession(async () => {
    await rebindSession();
  });
  await rebindSession();

  // -------------------------------------------------------------------------
  // Drive the engine on behalf of the single controller.
  // -------------------------------------------------------------------------
  const driveEngine = (client: BrokerClient, frame: ClientToBroker): void => {
    const relayError = (err: unknown): void =>
      sendFrame(client, { type: 'error', code: 'engine_error', message: String(err) });
    switch (frame.type) {
      case 'prompt': {
        // C1: forward any pasted/attached images (frame.images) to the engine —
        // they ride as a field on PromptOptions (pi: `prompt(text, { images })`).
        // m-B (streaming-safe): the controller routes prompt-vs-steer off a
        // possibly-STALE `isStreaming` snapshot, so a `prompt` frame can arrive
        // mid-stream; PromptOptions.streamingBehavior is "Required if streaming"
        // (prompt() throws without it). Make the broker authoritative — when the
        // LIVE session is streaming, supply it so the client's routing is a HINT,
        // not a correctness requirement. "steer" mirrors pi interactive-mode's
        // own Enter-while-streaming submit (interactive-mode.js:
        // `prompt(text, { streamingBehavior: "steer" })`).
        const options: PromptOptions = {};
        if (frame.images !== undefined) options.images = frame.images;
        if (session.isStreaming) options.streamingBehavior = 'steer';
        void session.prompt(frame.text, options).catch(relayError);
        break;
      }
      case 'steer':
        // C1: pi's steer() takes images as a POSITIONAL 2nd arg (`steer(text, images?)`).
        void session.steer(frame.text, frame.images).catch(relayError);
        break;
      case 'follow_up':
        // C1: pi's followUp() takes images as a POSITIONAL 2nd arg (`followUp(text, images?)`).
        void session.followUp(frame.text, frame.images).catch(relayError);
        break;
      case 'abort':
        void session.abort().catch(relayError);
        break;
    }
  };

  // -------------------------------------------------------------------------
  // Command-op helpers (T3, §2.3). The controller guard is hoisted here (it was
  // inlined twice) and reused by all controller-only ops; the ack/error replies
  // and a few resolvers keep the per-op cases one-liners.
  // -------------------------------------------------------------------------
  /** Reject a non-controller for a controller-only op. Returns true when rejected
   *  (the caller should `break`). */
  const notController = (client: BrokerClient, what: string, id?: string): boolean => {
    if (client.id === controllerId) return false;
    sendFrame(client, {
      type: 'error',
      code: 'not_controller',
      message: `only the controlling client may ${what}`,
      // M1: echo a correlated request's id so its pending-by-id promise rejects
      // rather than hanging (e.g. a non-controller `dequeue`).
      ...(id !== undefined ? { id } : {}),
    });
    return true;
  };
  const ackTo = (client: BrokerClient, op: string, ok = true, detail?: string): void =>
    sendFrame(client, { type: 'ack', for: op, ok, ...(detail !== undefined ? { detail } : {}) });
  const engineErrorTo =
    (client: BrokerClient, id?: string) =>
    (err: unknown): void =>
      sendFrame(client, {
        type: 'error',
        code: 'engine_error',
        message: String(err),
        // M1: a correlated read-op / dequeue failure echoes its id so the viewer's
        // pending-by-id promise rejects instead of hanging; uncorrelated callers
        // pass no id (unchanged behavior).
        ...(id !== undefined ? { id } : {}),
      });

  /** Resolve a `provider/id` model spec against the LIVE services registry (which
   *  carries any extension-registered providers). Pure: returns undefined on a
   *  malformed spec or an unknown model. */
  const findModelSpec = (
    spec: string,
  ): ReturnType<AgentSessionServices['modelRegistry']['find']> => {
    const slash = spec.indexOf('/');
    if (slash <= 0) return undefined;
    return services.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
  };

  /** Resolve a model from a free-text query — `/model opus`, `/model fable`. Tries
   *  the exact `provider/id` spec first; failing that, searches the registry the
   *  way the picker's search box does (case-insensitive substring on the model id
   *  and the `provider/id` key) and returns the BEST match, preferring authed/
   *  available models. Returns undefined only when nothing matches. */
  const resolveModelQuery = (
    query: string,
  ): ReturnType<AgentSessionServices['modelRegistry']['find']> => {
    const exact = findModelSpec(query);
    if (exact) return exact;
    const q = query.trim().toLowerCase();
    if (q === '') return undefined;
    let all: ReturnType<typeof services.modelRegistry.getAll>;
    try {
      all = services.modelRegistry.getAll();
    } catch {
      return undefined;
    }
    let availableKeys: Set<string>;
    try {
      availableKeys = new Set(services.modelRegistry.getAvailable().map(modelKey));
    } catch {
      availableKeys = new Set();
    }
    // Rank: exact id (100) > exact provider/id (90) > id prefix (80) > id
    // substring (60) > provider/id substring (40); +5 if the model is available.
    const rank = (m: { provider: string; id: string }): number => {
      const id = m.id.toLowerCase();
      const key = modelKey(m).toLowerCase();
      let base = -1;
      if (id === q) base = 100;
      else if (key === q) base = 90;
      else if (id.startsWith(q)) base = 80;
      else if (id.includes(q)) base = 60;
      else if (key.includes(q)) base = 40;
      else return -1;
      return base + (availableKeys.has(modelKey(m)) ? 5 : 0);
    };
    let best: (typeof all)[number] | undefined;
    let bestRank = 0;
    for (const m of all) {
      const r = rank(m);
      if (r > bestRank) {
        bestRank = r;
        best = m;
      }
    }
    return best;
  };

  /** The merged command list for `get_commands` (C6/M9): the engine's registered
   *  extension + skill commands and file-based prompt templates, MERGED with the
   *  vendored BUILTIN_SLASH_COMMANDS (RPC omits builtins). Returned to the viewer
   *  as JSON in `ack.detail` (see the get_commands case). */
  const buildCommandList = (): Array<{ name: string; description: string; source: string }> => {
    const out: Array<{ name: string; description: string; source: string }> = [];
    for (const b of BUILTIN_SLASH_COMMANDS) {
      out.push({ name: b.name, description: b.description, source: 'builtin' });
    }
    try {
      // Skill commands surface here too — pi registers each skill as a command.
      for (const c of session.extensionRunner.getRegisteredCommands()) {
        out.push({ name: c.invocationName, description: c.description ?? '', source: 'command' });
      }
    } catch {
      /* an engine without a live extensionRunner (e.g. the fake) — builtins only */
    }
    try {
      for (const t of session.promptTemplates) {
        out.push({ name: t.name, description: t.description, source: 'template' });
      }
    } catch {
      /* ignore */
    }
    return out;
  };

  // -------------------------------------------------------------------------
  // Read-op data builders (operator-view picker payloads, §5 Unit A). Each is a
  // PURE getter read against the live engine session — the data a native pi
  // picker's constructor needs, serialized for the viewer. Not controller-gated
  // (read-only, like get_commands), so the web bridge's observer connection can
  // populate pickers too.
  // -------------------------------------------------------------------------
  const toModelRef = (m: { provider: string; id: string } | undefined): WireModelRef | null =>
    m === undefined ? null : { provider: m.provider, id: m.id };
  const modelKey = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

  const buildListModelsData = (id: string): ListModelsData => {
    const reg = session.modelRegistry;
    let availableIds: string[] = [];
    try {
      availableIds = reg.getAvailable().map(modelKey);
    } catch {
      /* getAvailable touches auth config; degrade to "none known available" */
    }
    return {
      type: 'data',
      id,
      kind: 'list_models',
      models: reg.getAll(),
      current: toModelRef(session.model),
      availableIds,
      scopedModels: session.scopedModels.map((s) => ({
        model: s.model,
        thinkingLevel: s.thinkingLevel,
      })),
      enabledModelIds: session.settingsManager.getEnabledModels() ?? null,
    };
  };

  const buildScopedModelsData = (id: string): ListScopedModelsData => ({
    type: 'data',
    id,
    kind: 'list_scoped_models',
    allModels: session.modelRegistry.getAll(),
    enabledModelIds: session.settingsManager.getEnabledModels() ?? null,
  });

  const buildGetTreeData = (id: string): GetTreeData => {
    const sm = session.sessionManager;
    const forkPoints: WireForkPoint[] = session.getUserMessagesForForking().map((u) => ({
      id: u.entryId,
      text: u.text,
      timestamp: sm.getEntry(u.entryId)?.timestamp,
    }));
    return {
      type: 'data',
      id,
      kind: 'get_tree',
      tree: sm.getTree(),
      currentLeafId: sm.getLeafId(),
      forkPoints,
    };
  };

  const buildSettingsData = (id: string): GetSettingsData => {
    const sm = session.settingsManager;
    // Theme names are enumerable broker-side via the resource loader. The theme
    // SUBMENU itself is viewer-local (theme is a viewer-only concern), but the
    // settings menu still shows currentTheme/availableThemes, so include them.
    let availableThemes: string[] = [];
    try {
      availableThemes = session.resourceLoader
        .getThemes()
        .themes.map((t) => t.name ?? '')
        .filter((n) => n !== '');
    } catch {
      /* loader without themes — viewer falls back to its local theme registry */
    }
    const settings: WireSettings = {
      autoCompact: session.autoCompactionEnabled,
      showImages: sm.getShowImages(),
      imageWidthCells: sm.getImageWidthCells(),
      autoResizeImages: sm.getImageAutoResize(),
      blockImages: sm.getBlockImages(),
      enableSkillCommands: sm.getEnableSkillCommands(),
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      transport: sm.getTransport(),
      httpIdleTimeoutMs: sm.getHttpIdleTimeoutMs(),
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
      currentTheme: sm.getTheme() ?? '',
      availableThemes,
      hideThinkingBlock: sm.getHideThinkingBlock(),
      collapseChangelog: sm.getCollapseChangelog(),
      enableInstallTelemetry: sm.getEnableInstallTelemetry(),
      doubleEscapeAction: sm.getDoubleEscapeAction(),
      treeFilterMode: sm.getTreeFilterMode(),
      showHardwareCursor: sm.getShowHardwareCursor(),
      editorPaddingX: sm.getEditorPaddingX(),
      autocompleteMaxVisible: sm.getAutocompleteMaxVisible(),
      quietStartup: sm.getQuietStartup(),
      clearOnShrink: sm.getClearOnShrink(),
      showTerminalProgress: sm.getShowTerminalProgress(),
      warnings: sm.getWarnings(),
      defaultProjectTrust: sm.getDefaultProjectTrust(),
      autoRetry: session.autoRetryEnabled,
      model: toModelRef(session.model),
    };
    return { type: 'data', id, kind: 'get_settings', settings };
  };

  const buildSessionsData = async (
    id: string,
    scope: 'cwd' | 'all',
  ): Promise<ListSessionsData> => {
    const sm = session.sessionManager;
    const raw =
      scope === 'all'
        ? await engine.SessionManager.listAll()
        : await engine.SessionManager.list(sm.getCwd(), sm.getSessionDir());
    const sessions: WireSessionInfo[] = raw.map((s) => ({
      ...s,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
    }));
    return {
      type: 'data',
      id,
      kind: 'list_sessions',
      scope,
      sessions,
      currentSessionFile: session.sessionFile,
    };
  };

  /** Run a session-replacing op (new_session/switch_session/fork). The runtime
   *  rebinds extensions + re-subscribes via setRebindSession before it resolves,
   *  so on success we just re-snapshot every viewer onto the new session. */
  const runReplacement = (
    client: BrokerClient,
    op: string,
    run: (rt: AgentSessionRuntime) => Promise<{ cancelled: boolean }>,
  ): void => {
    if (runtime === undefined) {
      sendFrame(client, {
        type: 'error',
        code: 'engine_error',
        message: 'session replacement unsupported at this engine pin',
      });
      return;
    }
    void run(runtime)
      .then((r) => {
        if (!r.cancelled) reWelcomeAll();
        ackTo(client, op, !r.cancelled, r.cancelled ? 'cancelled by extension' : undefined);
      })
      .catch(engineErrorTo(client));
  };

  const handleFrame = (client: BrokerClient, frame: ClientToBroker): void => {
    switch (frame.type) {
      case 'hello': {
        client.id = frame.client_id;
        client.helloed = true;
        // First-attach-wins (§5.3), but only against a LIVE controller: admit as
        // controller iff none is currently held by a live client (controllerClient
        // is liveness-aware, so a controllerId stranded on a departed peer reads as
        // free here). Otherwise read-only observer.
        if (frame.role === 'controller' && controllerClient() === null) {
          client.role = 'controller';
          controllerId = client.id;
        } else {
          client.role = 'observer';
        }
        sendWelcome(client);
        persistAttachState(); // a helloed viewer arrived
        if (client.role === 'controller') {
          // welcome carried the FIRST pending dialog (T4); forward any extras so a
          // controller attaching mid-dialog can answer every in-flight dialog.
          const pend = [...pendingDialogs.values()];
          for (let i = 1; i < pend.length; i++) sendFrame(client, pend[i]!.request);
          broadcastControlChanged();
        }
        break;
      }
      case 'prompt':
      case 'steer':
      case 'follow_up':
      case 'abort': {
        if (notController(client, 'drive the engine')) break;
        driveEngine(client, frame);
        break;
      }
      case 'extension_ui_response': {
        if (notController(client, 'answer dialogs')) break;
        pendingDialogs.get(frame.id)?.resolve(frame);
        break;
      }
      case 'request_control': {
        // §D preemptive handoff (last-requester-wins): a control request ALWAYS
        // succeeds, reassigning control to the requester and demoting the prior
        // controller to observer. This makes a tmux pane and a web tab true peers —
        // either can take control of a node the other currently drives — which is
        // the broker-is-the-host invariant (the prior cooperative-only model could
        // not preempt an idle/abandoned controller, the common case). The prior
        // controller demotes itself on receiving the control_changed broadcast
        // (attach-cmd.ts already does this; the web client implements the same
        // rule). Idempotent when the requester already holds control.
        if (client.id === controllerId) break;
        const prior = controllerClient();
        if (prior !== null) prior.role = 'observer';
        controllerId = client.id;
        client.role = 'controller';
        broadcastControlChanged();
        reroutePendingDialogsTo(client); // T4: hand the new controller pending dialogs
        break;
      }
      case 'release_control': {
        if (client.id === controllerId) {
          controllerId = null;
          client.role = 'observer';
          // M2 (T4): do NOT cancel in-flight dialogs on release — keep them pending
          // under the broker-side default timeout so a brief release/reattach (or a
          // handoff to another observer) never loses an answerable dialog.
          broadcastControlChanged();
        }
        break;
      }
      // --- extended engine-command ops (T3, §1.2 floor set) ------------------
      case 'set_model': {
        if (notController(client, 'set the model')) break;
        let model: ReturnType<typeof resolveModelQuery>;
        try {
          // Accept both an exact `provider/id` (from the picker) and a free-text
          // query (`/model opus`) — resolveModelQuery falls back to a search match.
          model = resolveModelQuery(frame.model);
        } catch (err) {
          // N2: registry.find should never throw on the real SDK, but a degenerate
          // engine must still get a reply rather than a silently-dropped frame.
          engineErrorTo(client)(err);
          break;
        }
        if (model === undefined) {
          sendFrame(client, {
            type: 'error',
            code: 'engine_error',
            message: `no model matching '${frame.model}' in the registry`,
          });
          break;
        }
        void session
          .setModel(model)
          .then(() => {
            ackTo(client, 'set_model');
            broadcastModelChanged();
          })
          .catch(engineErrorTo(client));
        break;
      }
      case 'cycle_model': {
        if (notController(client, 'cycle the model')) break;
        void session
          .cycleModel(frame.direction)
          .then(() => {
            ackTo(client, 'cycle_model');
            broadcastModelChanged();
          })
          .catch(engineErrorTo(client));
        break;
      }
      case 'cycle_thinking': {
        if (notController(client, 'cycle the thinking level')) break;
        try {
          session.cycleThinkingLevel();
          ackTo(client, 'cycle_thinking');
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'dequeue': {
        if (notController(client, 'dequeue messages', frame.id)) break;
        try {
          const { steering, followUp } = session.clearQueue();
          sendFrame(client, { type: 'data', id: frame.id, kind: 'dequeue', steering, followUp });
        } catch (err) {
          engineErrorTo(client, frame.id)(err);
        }
        break;
      }
      case 'set_thinking_level': {
        if (notController(client, 'set the thinking level')) break;
        try {
          session.setThinkingLevel(frame.level);
          ackTo(client, 'set_thinking_level');
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'set_auto_retry': {
        if (notController(client, 'set auto-retry')) break;
        try {
          session.setAutoRetryEnabled(frame.enabled);
          ackTo(client, 'set_auto_retry');
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'set_auto_compaction': {
        if (notController(client, 'set auto-compaction')) break;
        try {
          session.setAutoCompactionEnabled(frame.enabled);
          ackTo(client, 'set_auto_compaction');
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'compact': {
        if (notController(client, 'compact the session')) break;
        void session
          .compact(frame.instructions)
          .then(() => ackTo(client, 'compact'))
          .catch(engineErrorTo(client));
        break;
      }
      case 'set_session_name': {
        if (notController(client, 'rename the session')) break;
        try {
          session.setSessionName(frame.name);
          ackTo(client, 'set_session_name');
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'get_commands': {
        // OBSERVERS may call this: the merged command inventory is static
        // (extensions + templates + skills + builtins) and drives nothing in the
        // engine, so it is not a controller-gated op. The web bridge fetches it on
        // its observer-by-default upstream connection to populate the palette.
        // The merged command list rides in ack.detail as JSON (the foundation's
        // AckFrame.detail field) — the viewer (T6) JSON.parses it when for ===
        // 'get_commands'. Keeps every command op a uniform ack reply.
        try {
          ackTo(client, 'get_commands', true, JSON.stringify(buildCommandList()));
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      // --- read-op picker data (§5 Unit A) ----------------------------------
      // NOT controller-gated: read-only, like get_commands. The web bridge's
      // observer connection populates pickers through these too.
      case 'list_models': {
        try {
          sendFrame(client, buildListModelsData(frame.id));
        } catch (err) {
          engineErrorTo(client, frame.id)(err);
        }
        break;
      }
      case 'list_scoped_models': {
        try {
          sendFrame(client, buildScopedModelsData(frame.id));
        } catch (err) {
          engineErrorTo(client, frame.id)(err);
        }
        break;
      }
      case 'get_tree': {
        try {
          sendFrame(client, buildGetTreeData(frame.id));
        } catch (err) {
          engineErrorTo(client, frame.id)(err);
        }
        break;
      }
      case 'get_settings': {
        try {
          sendFrame(client, buildSettingsData(frame.id));
        } catch (err) {
          engineErrorTo(client, frame.id)(err);
        }
        break;
      }
      case 'list_sessions': {
        // Session listing reads the session dir off disk — async; reply when it
        // resolves (or relay the error, correlated by id so the viewer doesn't hang).
        void buildSessionsData(frame.id, frame.scope ?? 'cwd')
          .then((d) => sendFrame(client, d))
          .catch(engineErrorTo(client, frame.id));
        break;
      }
      case 'navigate_tree': {
        if (notController(client, 'navigate the session tree')) break;
        // navigateTree rewinds IN-PLACE (same session file, new leaf) and emits no
        // relayed event, so every viewer must be re-snapshotted onto the rewound
        // transcript — same reWelcomeAll the session-replacing ops use. The ack's
        // detail carries the navigated-to user message's text (pi parity: the
        // interactive tree navigator restores it to the editor for re-editing).
        void session
          .navigateTree(frame.targetId, frame.options)
          .then((r) => {
            if (!r.cancelled) reWelcomeAll();
            ackTo(client, 'navigate_tree', !r.cancelled, r.editorText);
          })
          .catch(engineErrorTo(client));
        break;
      }
      case 'reload': {
        if (notController(client, 'reload')) break;
        void session.reload().then(() => ackTo(client, 'reload')).catch(engineErrorTo(client));
        break;
      }
      case 'export': {
        if (notController(client, 'export the session')) break;
        if (frame.format === 'jsonl') {
          try {
            session.exportToJsonl(frame.path);
            ackTo(client, 'export');
          } catch (err) {
            engineErrorTo(client)(err);
          }
        } else {
          void session
            .exportToHtml(frame.path)
            .then(() => ackTo(client, 'export'))
            .catch(engineErrorTo(client));
        }
        break;
      }
      case 'new_session': {
        if (notController(client, 'start a new session')) break;
        runReplacement(client, 'new_session', (rt) => rt.newSession());
        break;
      }
      case 'switch_session': {
        if (notController(client, 'switch sessions')) break;
        runReplacement(client, 'switch_session', (rt) => rt.switchSession(frame.path));
        break;
      }
      case 'fork': {
        if (notController(client, 'fork the session')) break;
        runReplacement(client, 'fork', (rt) => rt.fork(frame.entryId));
        break;
      }
      case 'clone': {
        if (notController(client, 'clone the session')) break;
        const sm = session.sessionManager;
        const leafId = sm.getLeafId();
        if (leafId === null) {
          ackTo(client, 'clone', false, 'no current leaf to clone from');
          break;
        }
        let newPath: string | undefined;
        try {
          newPath = sm.createBranchedSession(leafId);
        } catch (err) {
          engineErrorTo(client)(err);
          break;
        }
        if (newPath === undefined) {
          ackTo(client, 'clone', false, 'createBranchedSession returned no path');
          break;
        }
        runReplacement(client, 'clone', (rt) => rt.switchSession(newPath as string));
        break;
      }
      case 'share': {
        if (notController(client, 'share the session')) break;
        const tmpPath = join(tmpdir(), `pi-share-${Date.now()}.html`);
        void session.exportToHtml(tmpPath)
          .then(() => new Promise<string>((resolve, reject) => {
            execFile('gh', ['gist', 'create', '--secret', tmpPath], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
              try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* cleanup */ }
              if (err) { reject(err); return; }
              resolve(stdout.trim());
            });
          }))
          .then((url) => {
            ackTo(client, 'share', true, url);
          })
          .catch((err: unknown) => {
            const msg = String((err as Error)?.message ?? err);
            ackTo(
              client,
              'share',
              false,
              msg.includes('not found') || msg.includes('gh: command not found') || msg.includes('ENOENT')
                ? '`gh` CLI not found — install GitHub CLI and authenticate with `gh auth login`'
                : `share failed: ${msg}`,
            );
          });
        break;
      }
      case 'reload_auth': {
        if (notController(client, 'reload auth')) break;
        try {
          services.authStorage.reload();
          services.modelRegistry.refresh();
          ackTo(client, 'reload_auth');
          broadcastModelChanged();
        } catch (err) {
          engineErrorTo(client)(err);
        }
        break;
      }
      case 'bye':
        client.socket.end();
        break;
      case 'shutdown':
        disposeAndExit('shutdown-frame');
        break;
    }
  };

  // -------------------------------------------------------------------------
  // 4 (plan): the socket listener — unlink any stale socket first.
  // -------------------------------------------------------------------------
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    /* a fresh listen below will surface a real problem */
  }

  server = createServer((socket) => {
    const client: BrokerClient = {
      id: '',
      role: 'observer',
      socket,
      decoder: new FrameDecoder(BROKER_READ_CAPS),
      helloed: false,
      pendingBytes: 0,
      queuedFrames: 0,
    };
    clients.add(client);
    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = client.decoder.push(chunk);
      } catch (err) {
        // G7: a client frame over the bounded decoder caps (FrameOverflowError) is
        // cap-and-dropped — best-effort error frame, then destroy the peer. The
        // broker survives. The try/catch is around push() itself (not just the
        // per-frame loop) because push() throws BEFORE returning any frames.
        if (err instanceof FrameOverflowError) {
          sendFrame(client, { type: 'error', code: 'frame_overflow', message: err.message });
          dropClient(client, `frame overflow: ${err.message}`);
        } else {
          dropClient(client, `decoder error: ${String(err)}`);
        }
        return;
      }
      for (const raw of frames) {
        try {
          handleFrame(client, raw as ClientToBroker);
        } catch {
          /* one bad frame never crashes the broker */
        }
      }
    });
    const drop = (): void => {
      clients.delete(client);
      persistAttachState(); // a viewer disconnected
      // M2 (T4): controller detach frees control but does NOT cancel in-flight
      // dialogs — they stay pending under the broker-side default timeout so a
      // brief detach/reattach (or a handoff to another observer who takes control)
      // never loses an answerable dialog. Only the timeout or a new controller's
      // answer resolves one.
      releaseControlIfHeldBy(client);
    };
    socket.on('close', drop);
    socket.on('error', () => {
      /* close follows; drop there */
    });
  });
  server.on('error', (err) => {
    process.stderr.write(`[broker] socket server error: ${String(err)}\n`);
  });
  server.listen(sockPath);
  // Initialize presence to the truthful zero state at boot — this also
  // overwrites a stale attach.json a crashed prior incarnation left behind.
  persistAttachState();

  // OS-signal teardown (daemon kill / T6 fallback) → same clean exit path.
  process.on('SIGTERM', () => disposeAndExit('SIGTERM'));
  process.on('SIGINT', () => disposeAndExit('SIGINT'));

  // -------------------------------------------------------------------------
  // 5 (plan): a fresh start delivers the kickoff prompt. A resume needs none —
  // the bound canvas-inbox-watcher drains the pending inbox entry and feeds it.
  // -------------------------------------------------------------------------
  if (!resuming && cfg.firstPrompt !== undefined && cfg.firstPrompt !== '') {
    void session.prompt(cfg.firstPrompt).catch((err) => {
      process.stderr.write(`[broker] first prompt failed: ${String(err)}\n`);
    });
  }
}

// ---------------------------------------------------------------------------
// snapshotMessages — the catch-up snapshot's ordered message history.
//
// The broker is the SOLE writer of the node's session `.jsonl`, so the session
// manager's persisted tree (`buildSessionContext`) is the canonical, complete,
// ordered history — byte-identical to what a dormant reader (crouter-web's static
// normalizer) reconstructs from the same file. We serve THAT, NOT the agent's
// live `session.messages` (`agent.state.messages`), because pi's recovery paths
// mutate the live array away from the persisted history: auto-retry, context-
// overflow recovery, and compaction each SLICE the errored/superseded assistant
// message out of `state.messages` while DELIBERATELY keeping it on disk ("keep in
// session for history", agent-session.js). So `session.messages` can OMIT — or, via
// branch/compaction reshaping, reorder — a turn the `.jsonl` still holds. Pre-
// close that drift is invisible (the live stream and the live array agree); after
// a revive the welcome snapshot built from the reloaded array would diverge from
// the on-disk history a dormant viewer just saw. Reconstructing from the session
// manager makes the live snapshot == the persisted history (single source of
// truth); the relayed live stream then continues from there.
//
// `AgentSession.sessionManager` is a public readonly field of the real pi SDK; the
// fake-engine test fixture mirrors the same `sessionManager.buildSessionContext()`
// surface, so this is a single path with no engine-capability fallback.
export function snapshotMessages(
  session: CreateAgentSessionResult['session'],
): BrokerSnapshot['messages'] {
  return session.sessionManager.buildSessionContext().messages;
}

// ---------------------------------------------------------------------------
// buildBrokerSession (plan T4 steps 2–4) — turn the launch recipe into a live
// engine session via the pi SDK SERVICES path. Exported so the C3/C4 real-SDK
// regression tests can drive the EXACT production wiring (not the mock).
// ---------------------------------------------------------------------------
export async function buildBrokerSession(
  engine: BrokerEngine,
  cfg: BrokerSdkConfig,
): Promise<{
  session: CreateAgentSessionResult['session'];
  services: AgentSessionServices;
  resuming: boolean;
  /** The session-replacement runtime, present iff the engine exposes
   *  createAgentSessionRuntime (real SDK yes, fake-engine no). The broker wires
   *  its new_session/switch_session/fork ops + rebind through it. */
  runtime?: AgentSessionRuntime;
}> {
  // 2. Build cwd-bound runtime services via the SERVICES path (C3) — NOT plain
  //    createAgentSession. createAgentSessionServices builds + reloads the
  //    resource loader (the `-e` canvas extensions + --append-system-prompt) and
  //    REGISTERS extension-provided model providers into the ModelRegistry (it is
  //    also where extension flag values would be applied — the broker recipe
  //    carries none today). Plain createAgentSession does NEITHER, so a node whose
  //    model comes from a custom-provider extension would get NO model. Mirrors pi
  //    main.js (createAgentSessionServices → …FromServices).
  //
  //    C4 note: the pinned SDK (0.78.1) has NO project-trust concept at all —
  //    project context files (AGENTS.md/CLAUDE.md) load UNCONDITIONALLY (gated
  //    only by `noContextFiles`, left default-false), so the headless "trust
  //    resolves false → context silently dropped" gap cannot occur here. WHEN the
  //    SDK pin bumps to 0.79.0+ (which adds project-trust), pass an explicit
  //    `settingsManager: SettingsManager.create(cfg.cwd, getAgentDir(), { projectTrusted: true })`
  //    so headless trust defaults TRUSTED — and do NOT re-introduce the CLI's
  //    resolveProjectTrust, which returns false with no TTY.
  //
  //    T3 session-rebind: services + model + session creation is factored into
  //    `buildForManager` so it can serve BOTH the initial boot AND the
  //    AgentSessionRuntime factory it is reused as below (new_session/
  //    switch_session/fork rebuild the session by re-invoking it for a new
  //    SessionManager). Mirrors pi main.js's `createRuntime`.
  const agentDir = getAgentDir();
  const buildForManager = async (o: {
    cwd: string;
    agentDir: string;
    sessionManager: Parameters<BrokerEngine['createAgentSessionFromServices']>[0]['sessionManager'];
    sessionStartEvent?: Parameters<
      BrokerEngine['createAgentSessionFromServices']
    >[0]['sessionStartEvent'];
  }): Promise<CreateAgentSessionResult & { services: AgentSessionServices }> => {
    const services = await engine.createAgentSessionServices({
      cwd: o.cwd,
      agentDir: o.agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: cfg.extensionPaths,
        appendSystemPrompt:
          cfg.appendSystemPromptPath !== undefined ? [cfg.appendSystemPromptPath] : undefined,
      },
    });

    // 3. Resolve the model spec (`anthropic/sonnet` → a Model) against the
    //    SERVICES registry — which has any extension-provided providers (C3).
    //    Undefined ⇒ the SDK picks the settings default.
    let model: ReturnType<AgentSessionServices['modelRegistry']['find']>;
    if (cfg.model !== undefined && cfg.model !== '') {
      const slash = cfg.model.indexOf('/');
      if (slash > 0) {
        model = services.modelRegistry.find(cfg.model.slice(0, slash), cfg.model.slice(slash + 1));
        if (model === undefined) {
          process.stderr.write(
            `[broker] WARNING: model '${cfg.model}' not found in registry — ` +
              `falling back to the SDK default model.\n`,
          );
        }
      } else {
        process.stderr.write(
          `[broker] WARNING: model '${cfg.model}' has no 'provider/id' form — ` +
            `using the SDK default model.\n`,
        );
      }
    }

    const created = await engine.createAgentSessionFromServices({
      services,
      sessionManager: o.sessionManager,
      model,
      tools: cfg.tools,
      sessionStartEvent: o.sessionStartEvent,
    });
    return { ...created, services };
  };

  // 4. Select the SessionManager: FORK (spawn-time --fork), OPEN (resume), or
  //    CREATE (fresh). The broker is the sole writer of the resulting .jsonl.
  const resumePath = cfg.resumeSessionPath;
  const forking = cfg.forkFrom !== undefined && cfg.forkFrom !== '';
  if (
    !forking &&
    (resumePath === undefined || resumePath === '') &&
    cfg.resumeSessionId !== undefined &&
    cfg.resumeSessionId !== ''
  ) {
    // SessionManager.open() takes a FILE path — it only path-normalizes; it does
    // NOT resolve a bare uuid to its .jsonl the way pi's CLI does (via
    // SessionManager.list). A bare-id-only resume would open a nonexistent
    // <cwd>/<uuid> and silently start an EMPTY session. Fail loud: revive always
    // passes the .jsonl path, so a bare id means an old node that never captured
    // pi_session_file — mis-resuming it silently is worse than a crash.
    throw new Error(
      `[broker] resume requires a session .jsonl PATH; got only a bare id ` +
        `'${cfg.resumeSessionId}' (pi_session_file was never captured for this node)`,
    );
  }
  // A fork is a fresh spawn (resuming=false) so the kickoff firstPrompt fires: a
  // `node new --fork-from <id>` gives the new node the source's full history AND a
  // new task to start on. A resume replays the inbox instead and sends no kickoff.
  const resuming = !forking && resumePath !== undefined && resumePath !== '';
  let sessionManager: ReturnType<BrokerEngine['SessionManager']['create']>;
  if (forking) {
    // Spawn-time fork via pi's REAL fork seam, SessionManager.forkFrom — the exact
    // method pi's own `--fork` CLI flag uses (main.js forkSessionOrExit). It writes
    // a NEW session file with a NEW id and a `parentSession` header pointing at the
    // source, then copies the source's history into it. NOT a naïve `.jsonl` copy
    // (which would collide session ids and drop the fork metadata), and NOT
    // runtime.fork() (which forks an entry WITHIN an already-loaded session — there
    // is no current session to fork at boot). The caller (spawn.ts resolveForkSource)
    // resolves cfg.forkFrom to an absolute source .jsonl before launch, so a bad ref
    // fails loudly here (forkFrom throws on an empty/invalid/header-less source).
    sessionManager = engine.SessionManager.forkFrom(cfg.forkFrom as string, cfg.cwd);
  } else if (resuming) {
    sessionManager = engine.SessionManager.open(resumePath as string);
  } else {
    sessionManager = engine.SessionManager.create(cfg.cwd);
  }

  // When the engine exposes the replacement API (real SDK), wrap the builder in an
  // AgentSessionRuntime so new_session/switch_session/fork work; the runtime
  // re-invokes `buildForManager` for each new SessionManager. The fake-engine
  // fixture omits it — fall back to a single direct build (those three ops then
  // reply error{engine_error}).
  if (engine.createAgentSessionRuntime !== undefined) {
    const factory: CreateAgentSessionRuntimeFactory = async (o) => {
      const r = await buildForManager({
        cwd: o.cwd,
        agentDir: o.agentDir,
        sessionManager: o.sessionManager,
        sessionStartEvent: o.sessionStartEvent,
      });
      return { ...r, diagnostics: r.services.diagnostics ?? [] };
    };
    const runtime = await engine.createAgentSessionRuntime(factory, {
      cwd: cfg.cwd,
      agentDir,
      sessionManager,
    });
    return { session: runtime.session, services: runtime.services, resuming, runtime };
  }

  const r = await buildForManager({ cwd: cfg.cwd, agentDir, sessionManager });
  return { session: r.session, services: r.services, resuming, runtime: undefined };
}

// ---------------------------------------------------------------------------
// makeBrokerUiContext — the dialog router + display relay as an ExtensionUIContext.
//
// Two surfaces carry behavior: the 4 blocking dialogs (select/confirm/input/editor)
// route to the controller, and the 3 non-blocking display methods
// (setStatus/setWidget/setTitle) broadcast `display_*` frames to all viewers.
// Everything else (the TUI-only surface — working indicator, footer/header,
// custom overlays, editor swap, autocomplete) stays a harmless no-op. The cast is
// deliberate: pi's ExtensionUIContext is a large TUI interface and noOpUIContext
// is not exported, so we implement the routed/relayed methods + no-ops.
//
// NOTE: extensions bind in mode 'print', under which the canvas Surface-chrome
// extensions self-gate off, so a *canvas* hook does not currently call the relayed
// methods. The relay is correct forward-looking infra: any extension that DOES
// call setStatus/setWidget/setTitle now reaches viewers (the viewer slots are
// Unit E). Lighting up canvas chrome itself (a bind-mode change) is out of scope.
// ---------------------------------------------------------------------------
/** Broker-side hooks the UI context needs to route (or noOp) extension dialogs. */
export interface BrokerDialogDeps {
  /** The controller client, or null when ZERO viewers are attached. */
  controller: () => BrokerClient | null;
  /** Forward a dialog request to the (non-null) controller. */
  forward: (client: BrokerClient, request: RpcExtensionUIRequest) => void;
  /** Pending-dialog registry, keyed by request id (answered via extension_ui_response). */
  pending: Map<string, PendingDialog>;
  /** Broadcast a non-blocking display frame (setStatus/setWidget/setTitle) to ALL
   *  viewers — the relay path for pi's fire-and-forget extension-UI surface. */
  broadcast: (frame: BrokerToClient) => void;
}

export function makeBrokerUiContext(deps: BrokerDialogDeps): ExtensionUIContext {
  // The dialog router. C2 (scout mq5thyli): the design §5.4 premise — that an
  // unattended dialog auto-resolves on its OWN timeout — is FALSE. `timeout` is
  // OPTIONAL on dialog opts, editor() takes none, and almost no real extension
  // passes one (permission-gate / confirm-destructive / plan-mode / subagent all
  // omit it). A timeout-reliant unattended node therefore deadlocks the agent
  // turn FOREVER. So with ZERO viewers attached we fall back to the SDK's noOp UI
  // behavior — resolve to the default (deny / cancel / undefined) IMMEDIATELY,
  // never arming a timer, never waiting. (Phase 4 adds the WITH-viewer forwarding
  // path, wrapped in a broker-side timeout+abort so a controller that attaches
  // but never answers cannot hang the turn either.)
  const dialogPromise = <T>(
    defaultValue: T,
    request: RpcExtensionUIRequest,
    parse: (r: RpcExtensionUIResponse) => T,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const controller = deps.controller();
    // C2 (Wave-0, KEEP): no controller at raise time → noOp, resolved at once. No
    // timer, no wait, no deadlock. This is the genuine zero-controller path.
    if (controller === null) return Promise.resolve(defaultValue);
    // A controller is attached: forward the dialog, register it (so a re-routed /
    // re-attaching controller can answer it — T4), and ALWAYS arm a broker-side
    // timeout (T4/C2 anti-deadlock): a controller that never answers — or detaches
    // and is never replaced — can never hang the turn. Honor a shorter per-dialog
    // timeout if the extension passed one; otherwise the broker default. On fire
    // it resolves to the SAFE default (deny/cancel/undefined). NOTE: controller
    // detach does NOT cancel this (M2) — only an answer, the timeout, or an abort.
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        deps.pending.delete(request.id);
      };
      const onAbort = (): void => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      // N1: honor the extension's EXPLICIT per-dialog timeout if it passed one
      // (longer or shorter than the broker default is fine — both are bounded);
      // otherwise fall back to the broker default. The broker never RELIES on the
      // extension having passed one (C2).
      const ms = opts?.timeout !== undefined ? opts.timeout : DEFAULT_DIALOG_TIMEOUT_MS;
      timer = setTimeout(() => {
        cleanup();
        resolve(defaultValue);
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
      deps.pending.set(request.id, {
        request,
        resolve: (r) => {
          cleanup();
          resolve(parse(r));
        },
      });
      deps.forward(controller, request);
    });
  };

  const noop = (): void => {};
  const ctx = {
    // pi's ExtensionUIContext exposes `theme`; package extensions (e.g. the OAuth
    // billing adapter's status rendering) read it from ANY lifecycle hook. The
    // SDK's noOpUIContext returns the process-global theme proxy here; we mirror
    // that by reading the same global symbol (populated by initTheme() at broker
    // boot — see runBroker). Without this property `ctx.ui.theme` is undefined and
    // the hook throws, which the runner silently swallows while dropping the hook's
    // returned payload (the OAuth 400 root cause).
    get theme(): unknown {
      const t = (globalThis as Record<symbol, unknown>)[
        Symbol.for('@earendil-works/pi-coding-agent:theme')
      ];
      if (t === undefined || t === null) {
        throw new Error('Theme not initialized. Call initTheme() first.');
      }
      return t;
    },
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialogPromise<string | undefined>(
        undefined,
        { type: 'extension_ui_request', id: randomUUID(), method: 'select', title, options, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? r.value : undefined),
        opts,
      ),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialogPromise<boolean>(
        false,
        { type: 'extension_ui_request', id: randomUUID(), method: 'confirm', title, message, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? false : 'confirmed' in r ? r.confirmed : false),
        opts,
      ),
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialogPromise<string | undefined>(
        undefined,
        { type: 'extension_ui_request', id: randomUUID(), method: 'input', title, placeholder, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? r.value : undefined),
        opts,
      ),
    editor: (title: string, prefill?: string) =>
      dialogPromise<string | undefined>(
        undefined,
        { type: 'extension_ui_request', id: randomUUID(), method: 'editor', title, prefill },
        (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? r.value : undefined),
      ),
    // Non-blocking extension-UI relay (§5 Unit A task 3): broadcast these to all
    // viewers as display frames instead of dropping them. The viewer (Unit E) owns
    // the slots that render them. The other non-blocking methods stay inert.
    setStatus: (key: string, text: string | undefined): void =>
      deps.broadcast({ type: 'display_status', key, text }),
    setWidget: (
      key: string,
      content: string[] | ((...args: unknown[]) => unknown) | undefined,
      options?: { placement?: 'aboveEditor' | 'belowEditor' },
    ): void => {
      // setWidget's component-factory overload cannot be serialized over the
      // socket (R1 caveat) — drop it and relay only the string[] form, exactly as
      // pi's own RPC setWidget carries only `widgetLines`.
      if (typeof content === 'function') return;
      deps.broadcast({
        type: 'display_widget',
        key,
        lines: content,
        placement: options?.placement ?? 'aboveEditor',
      });
    },
    setTitle: (title: string): void => deps.broadcast({ type: 'display_title', title }),
    // Inert print-mode surface (never reached by a Model hook in Phase 3).
    notify: noop,
    onTerminalInput: () => noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setFooter: noop,
    setHeader: noop,
    custom: () => Promise.resolve(undefined),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: noop,
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
  return ctx as unknown as ExtensionUIContext;
}
