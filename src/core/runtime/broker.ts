// broker.ts — the headless node broker (design §4, §5; plan T4).
//
// One broker process per `--headless` node. It hosts ONE pi engine IN-PROCESS
// via the SDK (createAgentSession), is the SOLE writer of the node's session
// `.jsonl`, listens on `nodeDir(id)/view.sock`, fans the single engine event
// stream out to N viewers, serializes a single controller's drive commands, and
// routes blocking extension dialogs. It is the headless analog of pi-in-a-pane:
// it runs one turn-cycle and, when the engine settles (the stophook calls
// ctx.shutdown(), or the engine goes idle), disposes the engine and exits 0 —
// the daemon then routes revival per the intent the bound stophook set.
//
// Engine resolution flows through broker-sdk.ts (`loadBrokerEngine`) so the T11
// `CRTR_BROKER_ENGINE` test seam can swap a fake engine in. The resource loader
// + model registry are real SDK construction helpers (NOT part of the swappable
// engine seam — the fake engine receives the real, extension-loaded loader so
// the real canvas-stophook fires session_start).

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AuthStorage,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { nodeDir } from '../canvas/paths.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { piInvocationToSdkConfig, type BrokerSdkConfig, type PiInvocation } from './launch.js';
import { assertEngineVersion, loadBrokerEngine } from './broker-sdk.js';
import {
  encodeFrame,
  FrameDecoder,
  type BrokerSnapshot,
  type BrokerToClient,
  type ClientRole,
  type ClientToBroker,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from './broker-protocol.js';

// ---------------------------------------------------------------------------
// Per-client connection state
// ---------------------------------------------------------------------------

interface BrokerClient {
  id: string;
  role: ClientRole;
  socket: Socket;
  decoder: FrameDecoder;
  helloed: boolean;
}

/** A blocking dialog awaiting a controller's response (or its own timeout). */
interface PendingDialog {
  resolve: (response: RpcExtensionUIResponse) => void;
}

// ---------------------------------------------------------------------------
// runBroker — the broker process body (plan T4 steps 1–6)
// ---------------------------------------------------------------------------

export async function runBroker(nodeId: string): Promise<void> {
  // Defensive: any `crtr` child the engine/extensions spawn must inherit the
  // front-door recursion guard (runtime/CLAUDE.md fork-bomb invariant). The host
  // (T6) also sets this; we set it again so the broker is self-sufficient.
  process.env[FRONT_DOOR_ENV] = '1';

  // The broker is PANELESS. A `--headless` child spawned by a tmux-resident
  // parent inherits the parent's TMUX_PANE/TMUX in its env (T6 spawns with
  // {...process.env}); left in place, the bound stophook's refresh-yield branch
  // (canvas-stophook.ts) would call reviveInPlace on the PARENT's %pane_id
  // (respawn-pane -k) — hijacking the parent's pane with a fresh pi, killing the
  // parent and orphaning this broker. Strip both so every stophook pane-branch
  // takes its no-pane path (→ ctx.shutdown() → our shutdownHandler → clean exit;
  // the daemon then respawns the node as a broker).
  delete process.env['TMUX_PANE'];
  delete process.env['TMUX'];

  // 1. Version tripwire + load the launch recipe the host serialized.
  const engine = await loadBrokerEngine();
  assertEngineVersion(engine.VERSION);

  const dir = nodeDir(nodeId);
  const launchFile = join(dir, 'broker-launch.json');
  const inv = JSON.parse(readFileSync(launchFile, 'utf8')) as PiInvocation;
  const cfg: BrokerSdkConfig = piInvocationToSdkConfig(inv); // also merges inv.env

  // Fork-on-spawn is the runtime.fork() path (createAgentSessionRuntime), not
  // wired headless in Phase 3. Fail loud rather than silently mis-resume.
  if (cfg.forkFrom !== undefined && cfg.forkFrom !== '') {
    throw new Error(
      `[broker] --fork is not supported by the headless broker in Phase 3 ` +
        `(forkFrom=${cfg.forkFrom}); the SDK fork path is createAgentSessionRuntime.fork()`,
    );
  }

  // 2. Build the resource loader (loads the canvas extensions + append-system-
  //    prompt exactly as the `-e` / --append-system-prompt CLI flags do).
  const loader = new DefaultResourceLoader({
    cwd: cfg.cwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: cfg.extensionPaths,
    appendSystemPrompt:
      cfg.appendSystemPromptPath !== undefined ? [cfg.appendSystemPromptPath] : undefined,
  });
  await loader.reload();

  // 3. Resolve the model spec (`anthropic/sonnet` → a Model) via the registry.
  //    Undefined model ⇒ the SDK picks the settings default.
  let model: ReturnType<ModelRegistry['find']> | undefined;
  if (cfg.model !== undefined && cfg.model !== '') {
    const slash = cfg.model.indexOf('/');
    if (slash > 0) {
      const provider = cfg.model.slice(0, slash);
      const id = cfg.model.slice(slash + 1);
      model = ModelRegistry.create(AuthStorage.create()).find(provider, id);
      if (model === undefined) {
        process.stderr.write(
          `[broker] WARNING: model '${cfg.model}' not found in registry — ` +
            `falling back to the SDK default model.\n`,
        );
      }
    } else {
      // normalizeModel (launch.ts) gives bare aliases a 'provider/id' form, so a
      // slashless spec here is a non-standard passthrough. Warn rather than
      // silently fall to the SDK default.
      process.stderr.write(
        `[broker] WARNING: model '${cfg.model}' has no 'provider/id' form — ` +
          `using the SDK default model.\n`,
      );
    }
  }

  // 4. Open (resume) or create (fresh) the session — the broker is the sole writer.
  const resumePath = cfg.resumeSessionPath;
  if (
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
  const resuming = resumePath !== undefined && resumePath !== '';
  const sessionManager = resuming
    ? engine.SessionManager.open(resumePath as string)
    : engine.SessionManager.create(cfg.cwd);

  const { session } = await engine.createAgentSession({
    cwd: cfg.cwd,
    model,
    tools: cfg.tools,
    resourceLoader: loader,
    sessionManager,
  });

  if (cfg.editorName !== undefined && cfg.editorName !== '') {
    try {
      session.setSessionName(cfg.editorName);
    } catch {
      /* non-fatal: naming is cosmetic */
    }
  }

  // -------------------------------------------------------------------------
  // Socket fan-out + controller arbitration state
  // -------------------------------------------------------------------------
  const sockPath = join(dir, 'view.sock');
  const clients = new Set<BrokerClient>();
  const pendingDialogs = new Map<string, PendingDialog>();
  let controllerId: string | null = null;
  let disposed = false;
  let server: Server | undefined;

  const controllerClient = (): BrokerClient | null => {
    if (controllerId === null) return null;
    for (const c of clients) if (c.id === controllerId) return c;
    return null;
  };

  const sendFrame = (client: BrokerClient, frame: BrokerToClient): void => {
    try {
      client.socket.write(encodeFrame(frame));
    } catch {
      /* a dead viewer must never crash the broker */
    }
  };

  const broadcast = (frame: BrokerToClient): void => {
    for (const c of clients) if (c.helloed) sendFrame(c, frame);
  };

  const broadcastControlChanged = (): void =>
    broadcast({ type: 'control_changed', controller_id: controllerId });

  const buildSnapshot = (): BrokerSnapshot => ({
    messages: session.messages,
    stats: session.getSessionStats(),
    state: {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      model: session.model?.id,
      isStreaming: session.isStreaming,
    },
  });

  // -------------------------------------------------------------------------
  // The single exit helper (plan §0): dispose the engine, close + unlink the
  // socket, exit 0. Idempotent — every trigger converges here.
  // -------------------------------------------------------------------------
  const disposeAndExit = (_reason: string): void => {
    if (disposed) return;
    disposed = true;
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
    process.exit(0);
  };

  // -------------------------------------------------------------------------
  // Extension-dialog routing (design §5.4): route to the controller; arm the
  // dialog's own timeout; auto-resolve to default when unattended. Modeled on
  // pi's rpc-mode createDialogPromise (rpc-mode.js:46-76). Phase 3 exercises
  // only the no-controller path.
  // -------------------------------------------------------------------------
  const dialogPromise = <T>(
    defaultValue: T,
    request: RpcExtensionUIRequest,
    parse: (r: RpcExtensionUIResponse) => T,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    return new Promise<T>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        pendingDialogs.delete(request.id);
      };
      const onAbort = (): void => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });

      const controller = controllerClient();
      if (opts?.timeout !== undefined && opts.timeout > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      } else if (controller === null) {
        // No controller AND no timeout → resolve to default immediately so a
        // fully unattended node never deadlocks (design §5.4 forward progress).
        resolve(defaultValue);
        return;
      }

      pendingDialogs.set(request.id, {
        resolve: (r) => {
          cleanup();
          resolve(parse(r));
        },
      });
      // A controller within the timeout window answers; an attaching controller
      // would receive it via welcome.pending_dialog (Phase 4).
      if (controller !== null) sendFrame(controller, request);
    });
  };

  const uiContext = makeBrokerUiContext(dialogPromise);

  // -------------------------------------------------------------------------
  // 3 (plan): bind the FULL canvas extensions, mode 'print'. THIS fires
  // session_start → the stophook records pi_session_id/file + recordPid(pid).
  // The shutdownHandler is the precise broker-exit trigger: the stophook calls
  // ctx.shutdown() in exactly the done / idle-release / refresh branches (and
  // NOT when it reprompts), so this fires only when the broker should exit.
  // -------------------------------------------------------------------------
  await session.bindExtensions({
    uiContext,
    mode: 'print',
    shutdownHandler: () => disposeAndExit('shutdown-hook'),
  });

  // -------------------------------------------------------------------------
  // 4 (plan): fan the single engine event stream to all clients, VERBATIM — the
  // broker is a transparent multiplexer. The engine-driven exit is deliberately
  // NOT inferred from raw agent_end here: the bound stophook is the SOLE
  // authority on when the node stops, and it calls ctx.shutdown() (→ our
  // shutdownHandler) in exactly its done / idle-release / refresh branches —
  // exiting synchronously at agent-session.js:266, BEFORE this subscriber runs
  // at :268, with intent already persisted. In every OTHER branch the stophook
  // deliberately STAYS ALIVE (reprompt, transient provider error, attended/
  // focused root). An agent_end idle heuristic would override those stay-alive
  // decisions — e.g. exit on a recoverable provider error, forcing a needless
  // ~20s grace-revive — so there is no such backstop; shutdownHandler + the
  // inbound `shutdown` frame are the only exits.
  // -------------------------------------------------------------------------
  session.subscribe((event) => {
    broadcast(event as BrokerToClient);
  });

  // -------------------------------------------------------------------------
  // Drive the engine on behalf of the single controller.
  // -------------------------------------------------------------------------
  const driveEngine = (client: BrokerClient, frame: ClientToBroker): void => {
    const relayError = (err: unknown): void =>
      sendFrame(client, { type: 'error', code: 'engine_error', message: String(err) });
    switch (frame.type) {
      case 'prompt':
        void session.prompt(frame.text).catch(relayError);
        break;
      case 'steer':
        void session.steer(frame.text).catch(relayError);
        break;
      case 'follow_up':
        void session.followUp(frame.text).catch(relayError);
        break;
      case 'abort':
        void session.abort().catch(relayError);
        break;
    }
  };

  const handleFrame = (client: BrokerClient, frame: ClientToBroker): void => {
    switch (frame.type) {
      case 'hello': {
        client.id = frame.client_id;
        client.helloed = true;
        // First-attach-wins controller (§5.3): admit as controller iff one was
        // requested and none is currently held; otherwise read-only observer.
        if (frame.role === 'controller' && controllerId === null) {
          client.role = 'controller';
          controllerId = client.id;
        } else {
          client.role = 'observer';
        }
        sendFrame(client, {
          type: 'welcome',
          snapshot: buildSnapshot(),
          role: client.role,
          controller_id: controllerId,
          pending_dialog: null, // populated in Phase 4
        });
        if (client.role === 'controller') broadcastControlChanged();
        break;
      }
      case 'prompt':
      case 'steer':
      case 'follow_up':
      case 'abort': {
        if (client.id !== controllerId) {
          sendFrame(client, {
            type: 'error',
            code: 'not_controller',
            message: 'only the controlling client may drive the engine',
          });
          break;
        }
        driveEngine(client, frame);
        break;
      }
      case 'extension_ui_response': {
        if (client.id !== controllerId) {
          sendFrame(client, {
            type: 'error',
            code: 'not_controller',
            message: 'only the controlling client may answer dialogs',
          });
          break;
        }
        pendingDialogs.get(frame.id)?.resolve(frame);
        break;
      }
      case 'request_control': {
        if (controllerId === null) {
          controllerId = client.id;
          client.role = 'controller';
          broadcastControlChanged();
        } else {
          sendFrame(client, {
            type: 'error',
            code: 'control_held',
            message: 'another client holds control',
          });
        }
        break;
      }
      case 'release_control': {
        if (client.id === controllerId) {
          controllerId = null;
          client.role = 'observer';
          broadcastControlChanged();
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
      decoder: new FrameDecoder(),
      helloed: false,
    };
    clients.add(client);
    socket.on('data', (chunk) => {
      for (const raw of client.decoder.push(chunk)) {
        try {
          handleFrame(client, raw as ClientToBroker);
        } catch {
          /* one bad frame never crashes the broker */
        }
      }
    });
    const drop = (): void => {
      clients.delete(client);
      if (client.id !== '' && client.id === controllerId) {
        controllerId = null; // controller detach frees control (§5.3)
        broadcastControlChanged();
      }
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
// makeBrokerUiContext — the dialog router as an ExtensionUIContext.
//
// Only the 4 blocking dialogs (select/confirm/input/editor) carry behavior; the
// rest of the (TUI-only) surface is inert in print mode. The cast is deliberate:
// pi's ExtensionUIContext is a large TUI interface and noOpUIContext is not
// exported, so we implement the routed methods + harmless no-ops. With mode
// 'print' the canvas Surface-chrome extensions self-gate off, so none of the
// no-op'd methods are reached by a Model hook in Phase 3.
// ---------------------------------------------------------------------------
function makeBrokerUiContext(
  dialogPromise: <T>(
    defaultValue: T,
    request: RpcExtensionUIRequest,
    parse: (r: RpcExtensionUIResponse) => T,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<T>,
): ExtensionUIContext {
  const noop = (): void => {};
  const ctx = {
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
    // Inert print-mode surface (never reached by a Model hook in Phase 3).
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
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
