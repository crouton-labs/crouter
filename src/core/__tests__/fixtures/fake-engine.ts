// fake-engine.ts — a deterministic in-process stand-in for the pi SDK engine,
// the SDK analog of fixtures/fake-pi-host.ts.
//
// This is NOT an LLM and NOT a mock of the canvas extensions. It occupies the
// pi SDK's place INSIDE the REAL broker (src/core/runtime/broker.ts): the broker
// loads it through the `CRTR_BROKER_ENGINE` seam (broker-sdk.ts `loadBrokerEngine`),
// then drives it exactly as it drives the real `@earendil-works/pi-coding-agent`
// engine — SessionManager.open/create, createAgentSession, session.bindExtensions,
// session.subscribe, session.prompt. We load the REAL `-e` canvas extensions (the
// modules the runtime put in the node's broker-launch.json) and fire REAL
// lifecycle events under harness control, so the real hooks (canvas-stophook,
// canvas-inbox-watcher) and the real broker drive real canvas state — across the
// detached broker process boundary, with NOTHING in the broker mocked.
//
// It is run UNDER tsx in the broker process (the harness puts `--import tsx/esm`
// in the broker's NODE_OPTIONS), so the `.ts` extension paths and this `.ts`
// module both resolve. By the time the broker calls our SessionManager/
// createAgentSession, piInvocationToSdkConfig has merged inv.env into
// process.env, so CRTR_NODE_ID / CRTR_HOME are set — that is how we find the
// node dir.
//
// Proof / control surface — IDENTICAL filenames to fake-pi-host.ts, so the
// EXISTING harness observers (awaitBoot, awaitWake, eventCount, bootCount,
// injected) work for broker nodes UNCHANGED:
//   <nodeDir>/fake-pi.boot.json     — argv + env + loaded exts (latest boot)
//   <nodeDir>/fake-pi.boots.jsonl    — append-only, one line per boot (broker pid)
//   <nodeDir>/fake-pi.events.jsonl   — append-only, one line per fired event
//   <nodeDir>/fake-pi.injected.jsonl — every sendUserMessage (inbox-watcher wake)
//   <nodeDir>/fake-pi.error          — any boot/import failure
//   <nodeDir>/fake-pi.cmd            — harness writes ONE JSON command (turn|stop|dialog)
//   <nodeDir>/fake-pi.dialog.jsonl   — one line per resolved unattended dialog (§5.4)

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

/** Test seam (M-1 regression): a FRESH-start kickoff prompt carrying this token
 *  makes the fake engine THROW inside bindExtensions BEFORE it fires
 *  session_start — the exact failure mode that records no pid and no session, so
 *  the broker exits(1) and the daemon must surface a boot failure rather than
 *  strand the node. Carried on the prompt (not a global env) so it is per-spawn. */
export const FAIL_BEFORE_SESSION_START = '__FAIL_BEFORE_SESSION_START__';

// ---------------------------------------------------------------------------
// node dir / proof helpers
// ---------------------------------------------------------------------------

function nodeDirFromEnv(): string {
  const home = (process.env['CRTR_HOME'] ?? '').trim();
  const nodeId = (process.env['CRTR_NODE_ID'] ?? '').trim();
  if (home === '' || nodeId === '') {
    throw new Error('[fake-engine] CRTR_HOME / CRTR_NODE_ID missing in env');
  }
  const dir = join(home, 'nodes', nodeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function recordError(dir: string, msg: string): void {
  try {
    appendFileSync(join(dir, 'fake-pi.error'), msg + '\n');
  } catch {
    /* best effort */
  }
  try {
    process.stderr.write('[fake-engine] ' + msg + '\n');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// SessionManager — the broker calls .open(path) (resume) or .create(cwd) (fresh)
// and hands the result to createAgentSession. sessionId/sessionFile round-trip
// through it, so a resume (`--session <pi_session_file>`) re-opens the SAME
// .jsonl the fresh start created — the load-bearing identity for revive.
// ---------------------------------------------------------------------------

export class SessionManager {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly resumed: boolean;

  private constructor(sessionId: string, sessionFile: string, resumed: boolean) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.resumed = resumed;
  }

  /** Fresh start: a brand-new session whose .jsonl lives under the node dir
   *  (created empty if missing, like fake-pi-host). */
  static create(_cwd: string): SessionManager {
    const dir = nodeDirFromEnv();
    const sessionFile = join(dir, 'fake-session.jsonl');
    if (!existsSync(sessionFile)) writeFileSync(sessionFile, '');
    return new SessionManager(`fake-sess-${randomUUID()}`, sessionFile, false);
  }

  /** Resume: round-trip the .jsonl PATH the revive passed via `--session`. */
  static open(path: string): SessionManager {
    return new SessionManager(`fake-sess-resume-${randomUUID()}`, path, true);
  }

  getSessionId(): string {
    return this.sessionId;
  }
  getSessionFile(): string {
    return this.sessionFile;
  }
}

// ---------------------------------------------------------------------------
// The faithful fake pi vehicle surface (the union of every method the 7 canvas
// extensions call at register time) + the fake AgentSession the broker drives.
// `on` + `sendUserMessage` carry the lifecycle behavior under test; the rest are
// recording stubs so the chrome extensions register without throwing.
// ---------------------------------------------------------------------------

type Handler = (ev: unknown, ctx: unknown) => void | Promise<void>;

interface BindExtensionsOpts {
  uiContext: BrokerUiContext;
  mode: string;
  shutdownHandler?: () => void;
}

/** The slice of the broker's ExtensionUIContext we exercise (the only blocking
 *  dialog scenario 7 drives). */
interface BrokerUiContext {
  confirm?: (
    title: string,
    message: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<boolean>;
}

interface Injected {
  content: string;
  deliverAs?: string;
}

/** The slice of a loaded SDK extension we drive: its path + the handler map the
 *  SDK's createExtensionAPI populated as the extension called pi.on(event, …)
 *  during the loader's reload(). */
interface LoadedExtension {
  path: string;
  handlers: Map<string, Handler[]>;
}

/** The shared extension runtime the SDK's loader built (createExtensionRuntime).
 *  Its action methods start as `notInitialized` throwers; the REAL session's
 *  bindCore swaps them for working impls bound to the live session — we replicate
 *  the minimal slice (sendUserMessage/sendMessage/setSessionName) so the already-
 *  registered handlers (e.g. the inbox-watcher) deliver instead of throwing. */
interface ExtRuntime {
  assertActive: () => void;
  sendUserMessage: (content: string, options?: { deliverAs?: string }) => void;
  sendMessage: (message: unknown, options?: { deliverAs?: string }) => void;
  setSessionName: (name: string) => void;
  [k: string]: unknown;
}

/** The minimal slice of the REAL DefaultResourceLoader the broker hands to
 *  createAgentSession: getExtensions() returns the already-loaded (jiti) canvas
 *  extensions + their shared runtime. */
interface ResourceLoader {
  getExtensions(): { extensions: LoadedExtension[]; errors?: unknown[]; runtime: ExtRuntime };
}

// ---------------------------------------------------------------------------
// AgentSessionEvent stream synthesis (T8 / G1, G3, G4, G8). The fake emits a
// REALISTIC streaming assistant turn through session.subscribe — the SAME channel
// the real pi engine feeds the broker's fan-out — so the frames a `crtr attach`
// client receives are byte-for-byte real AgentSessionEvents. The EMITTED event
// shapes are typed against the real `AgentSessionEvent` union from pi (whose full
// 17 variants are message_start/update/end, tool_execution_start/update/end,
// agent_start/end, turn_start/end, queue_update, compaction_start/end, auto_retry_
// start/end, session_info_changed, thinking_level_changed) — emit() takes that
// union, so a drift in the shape of any variant emitTurn() constructs (the
// streaming subset: the message_*, tool_execution_*, agent/turn start+end events)
// fails the build, not a test.
// ---------------------------------------------------------------------------

/** A minimal but fully-typed AssistantMessage. `pad` bytes of filler text let a
 *  test size a single frame to multiple MiB (G8 backpressure flood). */
function assistantMessage(text: string, pad = 0): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: pad > 0 ? `${text} ${'x'.repeat(pad)}` : text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fake-sonnet',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** A streaming text-delta event (the `assistantMessageEvent` carried by a
 *  message_update). Kept small (the big payload rides in message_update.message). */
function textDelta(partial: AssistantMessage, delta: string): AssistantMessageEvent {
  return { type: 'text_delta', contentIndex: 0, delta, partial };
}

class FakeSession {
  private readonly sm: SessionManager;
  private readonly loader: ResourceLoader | undefined;
  private readonly dir: string;
  private extensions: LoadedExtension[] = [];
  private readonly injected: Injected[] = [];
  private uiContext: BrokerUiContext | undefined;
  private shutdownHandler: (() => void) | undefined;
  private streaming = false;
  private disposed = false;
  private eventSeq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  // The broker's fan-out subscribers (broker.ts `session.subscribe(...)`) and the
  // accumulating message history the catch-up snapshot serializes (G3).
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly messageLog: AssistantMessage[] = [];

  constructor(sm: SessionManager, loader: ResourceLoader | undefined) {
    this.sm = sm;
    this.loader = loader;
    this.dir = nodeDirFromEnv();
  }

  // --- broker-read getters. buildSnapshot (on a client hello) reads messages/
  //     stats/model: T8 clients attach and assert on welcome.snapshot, so messages
  //     returns the accrued history; stats/model stay cheap stubs. ---------------
  get messages(): unknown[] {
    return this.messageLog;
  }
  // The broker's catch-up snapshot reconstructs history from the persisted
  // session tree (sessionManager.buildSessionContext) — the single source of
  // truth, since `session.messages` can be sliced by pi's retry/overflow/
  // compaction recovery. Mirror that surface so the fake's snapshot still serves
  // the accrued history (G2/G3). The fake's persisted analog IS messageLog.
  get sessionManager(): { buildSessionContext: () => { messages: unknown[]; thinkingLevel: string; model: null } } {
    return {
      buildSessionContext: () => ({ messages: this.messageLog, thinkingLevel: 'off', model: null }),
    };
  }
  get sessionId(): string {
    return this.sm.getSessionId();
  }
  get sessionFile(): string | undefined {
    return this.sm.getSessionFile();
  }
  get model(): { id: string } | undefined {
    return undefined;
  }
  get isStreaming(): boolean {
    return this.streaming;
  }
  getSessionStats(): Record<string, unknown> {
    return { messages: 0, tokens: 0 };
  }

  // --- naming is cosmetic (broker calls it in a try/catch) ---------------------
  setSessionName(_name: string): void {
    /* no-op recording stub */
  }

  // --- controller-drive stubs (no controller connects in these tests) ----------
  prompt(text: string, _options?: unknown): Promise<void> {
    // The broker calls this for BOTH the fresh-start kickoff AND a controller's
    // `prompt` frame (G1/G4). Either way emit a realistic streaming turn on the
    // subscribe channel; the broker fans it out to every attached viewer VERBATIM.
    // This is the SUBSCRIBE channel only — it does NOT run the canvas stophook
    // (that fires via the separate extension-handler channel in dispatch()/fire()),
    // so it never tears the broker down. The broker fire-and-forgets the promise.
    return this.emitTurn(text);
  }
  steer(_text: string): Promise<void> {
    return Promise.resolve();
  }
  followUp(_text: string): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }

  // --- the single engine event stream the broker fans out (broker.ts subscribes
  //     here and broadcasts each event VERBATIM to every attached viewer) --------
  subscribe(listener: (event: unknown) => void): () => void {
    const l = listener as (event: AgentSessionEvent) => void;
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Fan one typed AgentSessionEvent out to every broker subscriber. A throwing
   *  listener is recorded, never propagated (mirrors the broker's m7 try/catch). */
  private emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        recordError(this.dir, `subscribe listener threw: ${String(e)}`);
      }
    }
  }

  /** Emit a realistic streaming assistant turn on the subscribe channel:
   *  agent_start → turn_start → message_start → message_update×N →
   *  tool_execution_start/update/end → message_end → turn_end → agent_end. Drives
   *  G1 (controller prompt relay), G3 (produce-while-detached, accrues messageLog),
   *  and G8 (a fast event stream — `updates`/`padBytes` size the flood that sheds a
   *  stalled viewer at the broker HWM). A per-update setImmediate yield lets a
   *  fast viewer drain between frames so only the stalled one trips the HWM. */
  private async emitTurn(
    text: string,
    opts: { updates?: number; padBytes?: number; tool?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    const updates = opts.updates ?? 3;
    const pad = opts.padBytes ?? 0;
    const withTool = opts.tool ?? true;
    const small = assistantMessage(text);
    // A normal turn yields with setImmediate (fast). A sized flood (G8, pad>0) is
    // PACED with a small real delay so a fast (reading) viewer always drains each
    // frame and stays under the HWM, while a stalled (non-reading) viewer's backlog
    // still climbs monotonically past the 32 MiB byte cap and is shed. Without the
    // pace the burst outruns the reader's event loop and sheds the fast viewer too.
    const yieldTick = (): Promise<void> =>
      pad > 0 ? new Promise((r) => setTimeout(r, 3)) : new Promise((r) => setImmediate(r));

    this.streaming = true;
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'message_start', message: small });
    // F2 (message_update coalescing): the broker now coalesces message_update
    // relays (latest-wins, ~75 ms window), so a padded flood riding message_update
    // can no longer climb a stalled viewer's backlog — the coalescer would shed
    // the flood before the HWM does. A sized flood (pad>0, G8) therefore rides
    // tool_execution_update frames, which the broker relays VERBATIM (only
    // message_update is coalesced — tool output streams remain the realistic
    // unbounded-backlog vector M1 guards against). The flood gets its own
    // tool_execution_start so the frame sequence stays well-formed.
    const floodToolCallId = pad > 0 ? `flood-${++this.eventSeq}` : undefined;
    if (floodToolCallId !== undefined) {
      this.emit({
        type: 'tool_execution_start',
        toolCallId: floodToolCallId,
        toolName: 'read',
        args: { path: 'flood.txt' },
      });
    }
    for (let i = 0; i < updates; i++) {
      if (this.disposed) return;
      this.emit({
        type: 'message_update',
        message: assistantMessage(`${text} [${i + 1}/${updates}]`),
        assistantMessageEvent: textDelta(small, `chunk ${i + 1}`),
      });
      if (floodToolCallId !== undefined) {
        // The big payload (G8) rides the partialResult; ~padBytes per frame.
        this.emit({
          type: 'tool_execution_update',
          toolCallId: floodToolCallId,
          toolName: 'read',
          args: { path: 'flood.txt' },
          partialResult: { chunk: 'x'.repeat(pad) },
        });
      }
      await yieldTick();
    }
    if (floodToolCallId !== undefined) {
      this.emit({
        type: 'tool_execution_end',
        toolCallId: floodToolCallId,
        toolName: 'read',
        result: { ok: true },
        isError: false,
      });
    }
    if (withTool) {
      const toolCallId = `call-${++this.eventSeq}`;
      this.emit({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: { path: 'README.md' } });
      this.emit({
        type: 'tool_execution_update',
        toolCallId,
        toolName: 'read',
        args: { path: 'README.md' },
        partialResult: { bytes: 42 },
      });
      this.emit({ type: 'tool_execution_end', toolCallId, toolName: 'read', result: { ok: true }, isError: false });
    }
    if (this.disposed) return;
    const finalMsg = assistantMessage(text);
    this.emit({ type: 'message_end', message: finalMsg });
    this.emit({ type: 'turn_end', message: finalMsg, toolResults: [] });
    this.messageLog.push(finalMsg);
    this.streaming = false;
    // agent_end on the SUBSCRIBE channel is a relayed frame ONLY (willRetry=false);
    // it never runs the stophook, so the broker stays alive (G2/G3/G4/G8).
    this.emit({ type: 'agent_end', messages: this.messageLog.slice(), willRetry: false });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  // --- bindExtensions: drive the loader's ALREADY-loaded extensions. The REAL
  //     DefaultResourceLoader.reload() (broker.ts, BEFORE createAgentSession) has
  //     already imported the `-e` canvas extensions via jiti and called each
  //     default(pi) against the SDK's `notInitialized` runtime — registering their
  //     handlers but leaving every action method (pi.sendUserMessage, …) a stub
  //     that THROWS during load. We must NOT re-import them: a native import() is a
  //     jiti-independent SECOND module instance, so the inbox-watcher's module-
  //     level timer would run TWICE — and the reload() copy (bound to the throwing
  //     runtime) wins the race for the shared on-disk inbox cursor, consuming the
  //     entry and never delivering. Instead we replicate the minimal slice of
  //     agent-session's bindCore: swap the shared runtime's action methods IN PLACE
  //     so the real handlers' pi.sendUserMessage delivers into our proof files,
  //     then emit session_start into their handler maps so the REAL canvas-stophook
  //     records pi_session_id/file + recordPid(process.pid=broker pid). The broker's
  //     shutdownHandler is wired into ctx.shutdown so the stophook's done/idle-
  //     release/refresh branches exit the broker. -------------------------------
  async bindExtensions(opts: BindExtensionsOpts): Promise<void> {
    this.uiContext = opts.uiContext;
    this.shutdownHandler = opts.shutdownHandler;

    const { argv, extPaths, label, prompt } = readLaunch(this.dir);
    const resuming = this.sm.resumed;

    // M-1 regression seam: simulate a broker that throws BEFORE session_start
    // (no pid, no session ever recorded). Only a fresh start carries the kickoff
    // prompt; the throw propagates out of bindExtensions → runBroker rejects →
    // broker-cli's fatal catch logs to job/broker.log + exit(1).
    if (!resuming && (prompt ?? '').includes(FAIL_BEFORE_SESSION_START)) {
      throw new Error('[fake-engine] simulated pre-session_start boot failure');
    }

    // bindCore (minimal): adopt the loader's extensions + their shared runtime, and
    // replace the throwing notInitialized action methods with working ones. The
    // handlers themselves stay the REAL ones the SDK registered during reload().
    const loaded: string[] = [];
    const failedExt: string[] = [];
    try {
      const result = this.loader?.getExtensions();
      this.extensions = result?.extensions ?? [];
      for (const e of this.extensions) loaded.push(e.path);
      for (const err of result?.errors ?? []) {
        failedExt.push(String((err as { error?: unknown })?.error ?? err));
      }
      const rt = result?.runtime;
      if (rt !== undefined) {
        rt.assertActive = (): void => {};
        rt.sendUserMessage = (content: string, options?: { deliverAs?: string }): void =>
          this.recordInjected({ content, deliverAs: options?.deliverAs });
        rt.sendMessage = (message: unknown, options?: { deliverAs?: string }): void =>
          this.recordInjected({ content: JSON.stringify(message), deliverAs: options?.deliverAs });
        rt.setSessionName = (): void => {};
      } else {
        recordError(this.dir, 'bindExtensions: resourceLoader.getExtensions() returned no runtime');
      }
    } catch (e) {
      recordError(this.dir, `bindExtensions getExtensions/bindCore failed: ${String(e)}`);
    }

    const ctx = this.buildCtx();

    // session_start: the real boot-confirm hook captures session id/file + the
    // broker's pid (recordPid(process.pid)) and clears any pending refresh.
    await this.fire('session_start', { reason: resuming ? 'resume' : 'startup' }, ctx);

    // The boot proof the harness asserts on (same shape as fake-pi-host's boot).
    const env = process.env;
    const boot = {
      pid: process.pid, // the broker pid (recorded as pi_pid by the stophook)
      nodeId: (env['CRTR_NODE_ID'] ?? '').trim(),
      home: (env['CRTR_HOME'] ?? '').trim(),
      rawArgv: argv,
      extPaths,
      loaded,
      failedExt,
      sessionId: this.sm.getSessionId(),
      sessionFile: this.sm.getSessionFile(),
      resuming,
      label: label ?? null,
      prompt: prompt ?? null,
      env: {
        CRTR_NODE_ID: env['CRTR_NODE_ID'] ?? null,
        CRTR_KIND: env['CRTR_KIND'] ?? null,
        CRTR_MODE: env['CRTR_MODE'] ?? null,
        CRTR_LIFECYCLE: env['CRTR_LIFECYCLE'] ?? null,
        CRTR_NODE_CWD: env['CRTR_NODE_CWD'] ?? null,
        CRTR_HOME: env['CRTR_HOME'] ?? null,
        CRTR_PARENT_NODE_ID: env['CRTR_PARENT_NODE_ID'] ?? null,
        CRTR_ROOT_SESSION: env['CRTR_ROOT_SESSION'] ?? null,
        CRTR_SUBTREE: env['CRTR_SUBTREE'] ?? null,
        CRTR_FRONT_DOOR: env['CRTR_FRONT_DOOR'] ?? null,
      },
      injectedDuringBoot: this.injected.slice(),
    };
    writeFileSync(join(this.dir, 'fake-pi.boot.json'), JSON.stringify(boot, null, 2));
    try {
      appendFileSync(join(this.dir, 'fake-pi.boots.jsonl'), JSON.stringify(boot) + '\n');
    } catch {
      /* best effort */
    }

    // Control loop: poll for one harness command at a time (turn | stop | dialog).
    this.timer = setInterval(() => {
      void this.step().catch((e) => recordError(this.dir, `step: ${String(e)}`));
    }, 100);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  // --- record an injected user message (the inbox-watcher wake proof). Called by
  //     the runtime's swapped-in sendUserMessage/sendMessage. ---------------------
  private recordInjected(rec: Injected): void {
    this.injected.push(rec);
    try {
      appendFileSync(
        join(this.dir, 'fake-pi.injected.jsonl'),
        JSON.stringify({ ...rec, ts: Date.now() }) + '\n',
      );
    } catch {
      /* best effort */
    }
  }

  // --- the ctx passed to fired handlers (union across both focus extensions) ---
  private buildCtx(): Record<string, unknown> {
    return {
      sessionManager: {
        getSessionId: (): string => this.sm.getSessionId(),
        getSessionFile: (): string => this.sm.getSessionFile(),
      },
      getContextUsage: (): { tokens: number } => ({ tokens: 1000 }),
      // Wired to the broker's shutdownHandler: the stophook calls ctx.shutdown()
      // in exactly its done / idle-release / refresh branches → disposeAndExit.
      shutdown: (): void => {
        this.shutdownHandler?.();
      },
      isIdle: (): boolean => !this.streaming,
      abort: (): void => {},
    };
  }

  // Append a durable record of every fired event BEFORE its handlers run — the
  // harness's robust "the broker received my command and is dispatching it"
  // signal, surviving a handler that exits the process (agent_end → ctx.shutdown
  // → broker disposeAndExit → process.exit).
  private recordEvent(event: string, ev: unknown): void {
    try {
      const reason = (ev as { reason?: string } | null)?.reason;
      appendFileSync(
        join(this.dir, 'fake-pi.events.jsonl'),
        JSON.stringify({ seq: ++this.eventSeq, event, reason: reason ?? null, ts: Date.now() }) + '\n',
      );
    } catch {
      /* best effort */
    }
  }

  private async fire(event: string, ev: unknown, ctx: unknown): Promise<void> {
    this.recordEvent(event, ev);
    // Dispatch into the loader's REAL extension handler maps (the same handlers
    // the SDK's reload() registered as each extension called pi.on(event, …)).
    for (const ext of this.extensions) {
      for (const h of ext.handlers.get(event) ?? []) {
        try {
          await h(ev, ctx);
        } catch (e) {
          recordError(this.dir, `handler ${event} threw: ${String(e)}`);
        }
      }
    }
  }

  // --- the command channel: one JSON command at a time, atomically renamed in --
  private async step(): Promise<void> {
    if (this.disposed) return;
    const cmdFile = join(this.dir, 'fake-pi.cmd');
    if (!existsSync(cmdFile)) return;
    let cmd:
      | {
          cmd?: string;
          id?: string;
          reason?: string;
          text?: string;
          timeout?: number;
          updates?: number;
          padBytes?: number;
          tool?: boolean;
        }
      | null = null;
    try {
      cmd = JSON.parse(readFileSync(cmdFile, 'utf8')) as typeof cmd;
    } catch {
      cmd = null;
    }
    try {
      unlinkSync(cmdFile);
    } catch {
      /* ignore */
    }
    if (cmd) await this.dispatch(cmd);
  }

  private async dispatch(cmd: {
    cmd?: string;
    reason?: string;
    text?: string;
    timeout?: number;
    updates?: number;
    padBytes?: number;
    tool?: boolean;
  }): Promise<void> {
    const ctx = this.buildCtx();
    switch (cmd.cmd) {
      case 'stream':
        // Drive a subscribe-channel streaming turn WITHOUT a controller (G3:
        // produce-while-detached) or with sized frames (G8: a fast event stream
        // that sheds a stalled viewer at the HWM). Pure fan-out — no stophook, no
        // exit — so the broker stays alive.
        await this.emitTurn(cmd.text ?? 'streamed turn', {
          updates: cmd.updates,
          padBytes: cmd.padBytes,
          tool: cmd.tool,
        });
        break;
      case 'turn':
        this.streaming = true;
        await this.fire('agent_start', {}, ctx);
        this.streaming = false;
        await this.fire(
          'turn_end',
          { message: { role: 'assistant', usage: { input: 10, output: 5 }, model: 'fake' } },
          ctx,
        );
        await this.fire(
          'agent_end',
          { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: cmd.text ?? '' }] }] },
          ctx,
        );
        break;
      case 'stop':
        this.streaming = false;
        await this.fire(
          'agent_end',
          {
            messages: [
              { role: 'assistant', stopReason: cmd.reason ?? 'stop', content: [{ type: 'text', text: cmd.text ?? '' }] },
            ],
          },
          ctx,
        );
        break;
      case 'dialog':
        // Raise a blocking confirm() through the broker's REAL uiContext. The path
        // taken depends on who is attached when it raises:
        //   • ZERO viewers (C2 / G6a): makeBrokerUiContext resolves the default
        //     (false) IMMEDIATELY — noOp fallback, no timer, no wait, no deadlock.
        //   • a controller attached (G5): forwarded as an extension_ui_request the
        //     controller answers via extension_ui_response — the engine proceeds.
        //   • a controller attached but silent (G6b): resolves on the broker-side
        //     timeout. Pass a SHORT explicit per-dialog `timeout` so that path is
        //     fast and deterministic (never the broker's 120s default).
        await this.runDialog(cmd.timeout ?? 0);
        break;
      default:
        recordError(this.dir, `unknown cmd: ${String(cmd.cmd)}`);
    }
  }

  private async runDialog(timeout: number): Promise<void> {
    const start = Date.now();
    try {
      const resolved = await Promise.resolve(
        this.uiContext?.confirm?.('headless-dialog', 'forward-progress check', { timeout }),
      );
      appendFileSync(
        join(this.dir, 'fake-pi.dialog.jsonl'),
        JSON.stringify({ resolved: resolved ?? null, ms: Date.now() - start, ts: Date.now() }) + '\n',
      );
    } catch (e) {
      recordError(this.dir, `dialog: ${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The SERVICES path (C3) — the broker now drives createAgentSessionServices →
// createAgentSessionFromServices (broker-sdk.ts BrokerEngine), NOT plain
// createAgentSession. We mirror the real SDK's split: createAgentSessionServices
// builds + reloads the REAL DefaultResourceLoader (the `-e` canvas extensions —
// exactly the construction broker.ts did before C3 moved it into the services
// path) and returns it as a services bundle; createAgentSessionFromServices wraps
// it in a FakeSession. We do NOT register real model providers (these lifecycle
// tests pass no custom-provider model), so modelRegistry.find always returns
// undefined — the broker then uses the SDK default (no model), correct for the
// fake. C3's actual provider-registration behavior is proven against the REAL SDK
// in broker-sdk-wiring.test.ts.
// ---------------------------------------------------------------------------

interface FakeServices {
  resourceLoader: ResourceLoader;
  modelRegistry: { find: (provider: string, id: string) => undefined };
}

export async function createAgentSessionServices(options: {
  cwd: string;
  agentDir?: string;
  resourceLoaderOptions?: { additionalExtensionPaths?: string[]; appendSystemPrompt?: string[] };
}): Promise<FakeServices> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    additionalExtensionPaths: options.resourceLoaderOptions?.additionalExtensionPaths,
    appendSystemPrompt: options.resourceLoaderOptions?.appendSystemPrompt,
  });
  await loader.reload();
  return {
    resourceLoader: loader as unknown as ResourceLoader,
    modelRegistry: { find: () => undefined },
  };
}

export async function createAgentSessionFromServices(options: {
  services: FakeServices;
  sessionManager: SessionManager;
}): Promise<{ session: FakeSession }> {
  return { session: new FakeSession(options.sessionManager, options.services.resourceLoader) };
}

// ---------------------------------------------------------------------------
// VERSION — set to the SDK's published version so assertEngineVersion (which
// only logs, never throws) emits no spurious mismatch warning.
// ---------------------------------------------------------------------------

export const VERSION = '0.78.1';

// ---------------------------------------------------------------------------
// Parse the broker-launch.json recipe the host serialized (the PiInvocation
// buildPiArgv produced) for the proof shape — the same `-e`/`-n`/positional
// vocabulary fake-pi-host parses off its argv.
// ---------------------------------------------------------------------------

function readLaunch(dir: string): {
  argv: string[];
  extPaths: string[];
  label: string | undefined;
  prompt: string | undefined;
} {
  let argv: string[] = [];
  try {
    const inv = JSON.parse(readFileSync(join(dir, 'broker-launch.json'), 'utf8')) as { argv?: string[] };
    argv = Array.isArray(inv.argv) ? inv.argv : [];
  } catch {
    /* no launch file — leave argv empty */
  }
  const extPaths: string[] = [];
  let label: string | undefined;
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-e') extPaths.push(argv[++i]!);
    else if (a === '-n') label = argv[++i]!;
    else if (a === '--session' || a === '--model' || a === '--tools' || a === '--append-system-prompt' || a === '--fork') i++;
    else if (!a.startsWith('-')) prompt = a; // positional kickoff (fresh start only)
  }
  return { argv, extPaths, label, prompt };
}
