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

  constructor(sm: SessionManager, loader: ResourceLoader | undefined) {
    this.sm = sm;
    this.loader = loader;
    this.dir = nodeDirFromEnv();
  }

  // --- broker-read getters (cheap stubs; only buildSnapshot on hello reads the
  //     stats/messages/model, and there are no clients in these tests) ----------
  get messages(): unknown[] {
    return [];
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
  prompt(_text: string): Promise<void> {
    // A fresh start delivers the kickoff here; the test drives turns/stops via
    // the command channel (exactly like fake-pi-host), so just RECORD it — never
    // auto-fire agent_end.
    return Promise.resolve();
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

  // --- the single engine event stream the broker fans out (no clients here) ----
  subscribe(_listener: (event: unknown) => void): () => void {
    return () => {
      /* unsubscribe */
    };
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
    let cmd: { cmd?: string; id?: string; reason?: string; text?: string; timeout?: number } | null = null;
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
  }): Promise<void> {
    const ctx = this.buildCtx();
    switch (cmd.cmd) {
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
        // Exercise the broker's REAL uiContext timeout branch (design §5.4): with
        // NO controller connected, dialogPromise arms a setTimeout that resolves
        // the default (false) after `timeout` ms — proving the engine makes
        // forward progress on the zero-viewer path instead of deadlocking.
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
// createAgentSession — the broker's entry: hand it the SessionManager + the REAL
// resourceLoader it built, get back { session }. Unlike fake-pi-host we do NOT
// re-load extensions; we adopt the loader's already-loaded ones in bindExtensions
// (the broker always reload()s the real loader first, which registers them).
// ---------------------------------------------------------------------------

export async function createAgentSession(options: {
  sessionManager: SessionManager;
  resourceLoader?: ResourceLoader;
}): Promise<{ session: FakeSession }> {
  return { session: new FakeSession(options.sessionManager, options.resourceLoader) };
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
