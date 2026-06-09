// broker-protocol.ts — the client↔broker wire protocol for the headless node
// Surface (design §5.2). Pure types + a newline-delimited JSON codec; no I/O, no
// SDK construction. Consumed by the broker (src/core/runtime/broker.ts) and, in
// Phase 4, by the `crtr attach` terminal client and the `crtr web` bridge.
//
// The transport is one unix socket per node (`nodeDir(id)/view.sock`) speaking
// newline-delimited JSON frames. Live engine events are relayed VERBATIM — the
// broker is a transparent multiplexer, so a broker→client frame is either one of
// the broker's own control frames (welcome/control_changed/error) or a raw pi
// `AgentSessionEvent` / `extension_ui_request`. The `type` namespaces never
// collide, so the union below stays a clean discriminated union.
//
// The extension-dialog frames mirror pi's RPC types (decision §1.15). pi names
// the correlation field `id` (design §5.2 wrote `request_id`); we follow pi.
//
// NOTE (version-skew, 2026-06-08): §1.15 says to IMPORT pi's now-public
// `RpcExtensionUIRequest`/`RpcExtensionUIResponse`. The newer pi build re-exports
// them from the package root, but the npm-published `0.78.1` currently in
// crouter's node_modules defines them in `dist/modes/rpc/rpc-types.d.ts` WITHOUT
// re-exporting them (the `exports` map gates off deep subpaths, so even a
// type-only deep import is unresolvable). They are therefore mirrored locally
// below — byte-for-byte from pi's `rpc-types.d.ts`. When the published build
// catches up, delete these two declarations and import them from the package
// root; nothing else changes (same names, same shapes).

import type {
  AgentSession,
  AgentSessionEvent,
  SessionStats,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import { StringDecoder } from 'node:string_decoder';

/** Emitted when an extension needs user input (mirror of pi rpc-types.d.ts). */
export type RpcExtensionUIRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string }
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'extension_ui_request'; id: string; method: 'setStatus'; statusKey: string; statusText: string | undefined }
  | { type: 'extension_ui_request'; id: string; method: 'setWidget'; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: 'aboveEditor' | 'belowEditor' }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string };

/** Response to an extension UI request (mirror of pi rpc-types.d.ts). */
export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

// ---------------------------------------------------------------------------
// Roles + the catch-up snapshot
// ---------------------------------------------------------------------------

/** Single controller (drives the engine) + N read-only observers (§5.3). */
export type ClientRole = 'controller' | 'observer';

/** The full state a (re)attaching client needs to catch up instantly — the
 *  broker's authoritative in-memory view (design §5.2: get_messages +
 *  get_state + get_session_stats). `messages` is pi's `AgentMessage[]` (the
 *  `session.messages` getter type), kept structural to avoid a deep type
 *  import. */
export interface BrokerSnapshot {
  messages: AgentSession['messages'];
  stats: SessionStats;
  state: {
    sessionId: string;
    sessionFile: string | undefined;
    model: string | undefined;
    isStreaming: boolean;
    // §1.3.2 — mirror RPC `get_state` so a (re)attaching viewer's header/footer
    // renders at parity. Types are the exact AgentSession getter types (indexed
    // access keeps them in lockstep with pi and avoids a deep import of
    // ThinkingLevel from pi-agent-core, matching `messages` above). Populated in
    // `buildSnapshot` (this change) via pure getter reads.
    thinkingLevel: AgentSession['thinkingLevel'];
    steeringMode: AgentSession['steeringMode'];
    followUpMode: AgentSession['followUpMode'];
    sessionName: AgentSession['sessionName'];
    autoCompactionEnabled: AgentSession['autoCompactionEnabled'];
    pendingMessageCount: AgentSession['pendingMessageCount'];
  };
}

// ---------------------------------------------------------------------------
// Client → broker frames
// ---------------------------------------------------------------------------

export interface HelloFrame {
  type: 'hello';
  role: ClientRole;
  client_id: string;
  /** Terminal geometry of a tmux-pane viewer; absent for a browser/headless. */
  term?: { cols: number; rows: number };
}

/** Drive the engine — controller only. Map 1:1 to session.prompt/steer/followUp/abort.
 *  `images` carries pasted/attached images to the engine (review M1): pi accepts
 *  `prompt(text,{images})` / `steer(text,images)` / `followUp(text,images)` at
 *  0.78.1. The wire TYPE lives here; T3/T6 wire the runtime side. The BROKER read
 *  cap (`BROKER_READ_CAPS`) is sized to hold a resizeImage-bounded PNG's base64. */
export interface PromptFrame {
  type: 'prompt';
  text: string;
  images?: ImageContent[];
}
export interface SteerFrame {
  type: 'steer';
  text: string;
  images?: ImageContent[];
}
export interface FollowUpFrame {
  type: 'follow_up';
  text: string;
  images?: ImageContent[];
}
export interface AbortFrame {
  type: 'abort';
}

/** Controller arbitration (§5.3). */
export interface RequestControlFrame {
  type: 'request_control';
}
export interface ReleaseControlFrame {
  type: 'release_control';
}

/** Detach this client — the engine runs on (distinct from `shutdown`). */
export interface ByeFrame {
  type: 'bye';
}

/** Graceful teardown: dispose the engine + exit the broker (design §3.3, the
 *  `HeadlessBrokerHost.teardown` happy path). A FIRST-CLASS control frame,
 *  distinct from `bye` (which only drops one listener). §5.2's wire table omits
 *  it; the plan reconciles §3.3's "graceful teardown over the socket" by
 *  treating `shutdown` as a client→broker control frame. */
export interface ShutdownFrame {
  type: 'shutdown';
}

// ---------------------------------------------------------------------------
// Engine-command frames (§1.2 floor set, C6/M9)
// ---------------------------------------------------------------------------
// Each is CONTROLLER-ONLY and maps 1:1 to an AgentSession method; the broker (T3)
// implements the handlers and replies `ack`/`error`. Builtin slash commands are
// NOT engine-interpreted (`prompt('/model')` ships `/model` to the LLM as literal
// text), so the viewer parses builtins itself (BUILTIN_SLASH_COMMANDS, vendored in
// pi-vendored.ts) and dispatches these frames. Speculative ops
// (clear_queue/import_jsonl/bash/…) are deliberately EXCLUDED (§1.2).

/** `setModel(model)` — `/model` (selector resolves → chosen id). */
export interface SetModelFrame {
  type: 'set_model';
  model: string;
}
/** `cycleModel()`. */
export interface CycleModelFrame {
  type: 'cycle_model';
}
/** `setThinkingLevel(level)` — `/settings` thinking. */
export interface SetThinkingLevelFrame {
  type: 'set_thinking_level';
  level: AgentSession['thinkingLevel'];
}
/** `setAutoRetryEnabled(enabled)`. */
export interface SetAutoRetryFrame {
  type: 'set_auto_retry';
  enabled: boolean;
}
/** `setAutoCompactionEnabled(enabled)` — `/settings`. */
export interface SetAutoCompactionFrame {
  type: 'set_auto_compaction';
  enabled: boolean;
}
/** `compact(instructions?)` — `/compact`. */
export interface CompactFrame {
  type: 'compact';
  instructions?: string;
}
/** `runtimeHost.newSession()` + rebind — `/new`. */
export interface NewSessionFrame {
  type: 'new_session';
}
/** `runtimeHost.switchSession(path)` + rebind — `/resume` (selector). */
export interface SwitchSessionFrame {
  type: 'switch_session';
  path: string;
}
/** `runtimeHost.fork(entryId)` + rebind — `/fork` (selector). */
export interface ForkFrame {
  type: 'fork';
  entryId: string;
}
/** `setSessionName(name)` — `/name`. */
export interface SetSessionNameFrame {
  type: 'set_session_name';
  name: string;
}
/** Registered commands + templates + skills, MERGED with BUILTIN_SLASH_COMMANDS
 *  (M9: RPC omits builtins) — drives autocomplete. Broker replies via `ack`. */
export interface GetCommandsFrame {
  type: 'get_commands';
}
/** `navigateTree(targetId, options?)` — `/tree`. Options mirror AgentSession.navigateTree. */
export interface NavigateTreeFrame {
  type: 'navigate_tree';
  targetId: string;
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  };
}
/** `reload()` — `/reload`. */
export interface ReloadFrame {
  type: 'reload';
}
/** `exportToHtml(path)` / `exportToJsonl(path)` — `/export`. */
export interface ExportFrame {
  type: 'export';
  path: string;
  format: 'html' | 'jsonl';
}

/** Answer a blocking extension dialog — pi's public RPC response type. */
export type ExtensionUIResponseFrame = RpcExtensionUIResponse;

export type ClientToBroker =
  | HelloFrame
  | PromptFrame
  | SteerFrame
  | FollowUpFrame
  | AbortFrame
  | RequestControlFrame
  | ReleaseControlFrame
  | ByeFrame
  | ShutdownFrame
  | SetModelFrame
  | CycleModelFrame
  | SetThinkingLevelFrame
  | SetAutoRetryFrame
  | SetAutoCompactionFrame
  | CompactFrame
  | NewSessionFrame
  | SwitchSessionFrame
  | ForkFrame
  | SetSessionNameFrame
  | GetCommandsFrame
  | NavigateTreeFrame
  | ReloadFrame
  | ExportFrame
  | ExtensionUIResponseFrame;

// ---------------------------------------------------------------------------
// Broker → client frames
// ---------------------------------------------------------------------------

export interface WelcomeFrame {
  type: 'welcome';
  snapshot: BrokerSnapshot;
  role: ClientRole;
  controller_id: string | null;
  /** A dialog already in-flight when this client attached (Phase 4
   *  attach-mid-dialog). The field exists now; it is only ever populated in
   *  Phase 4 — Phase 3 always sends it absent/null. */
  pending_dialog?: RpcExtensionUIRequest | null;
}

export interface ControlChangedFrame {
  type: 'control_changed';
  controller_id: string | null;
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
}

/** Result of a controller command op (§1.3): `for` echoes the op name, `ok` the
 *  outcome, `detail` an optional human-readable note. */
export interface AckFrame {
  type: 'ack';
  for: string;
  ok: boolean;
  detail?: string;
}

/** A blocking dialog routed to the controller — pi's public RPC request type. */
export type ExtensionUIRequestFrame = RpcExtensionUIRequest;

/** Everything the broker can send. Live `AgentSessionEvent`s are relayed
 *  verbatim (the broker adds nothing); the broker's own control frames carry
 *  non-colliding `type` discriminants. */
export type BrokerToClient =
  | WelcomeFrame
  | ControlChangedFrame
  | ErrorFrame
  | AckFrame
  | ExtensionUIRequestFrame
  | AgentSessionEvent;

// ---------------------------------------------------------------------------
// Newline-delimited JSON codec (the framing pi solves with `jsonl`, reproduced
// locally so the protocol module owns no transport dependency)
// ---------------------------------------------------------------------------

/** Encode one frame as a single newline-terminated JSON line. */
export function encodeFrame(frame: ClientToBroker | BrokerToClient): string {
  return JSON.stringify(frame) + '\n';
}

/** Byte bounds for a {@link FrameDecoder} (C5). */
export interface FrameDecoderCaps {
  /** Largest single (unterminated) frame the decoder will buffer before throwing. */
  maxLineBytes: number;
  /** Largest the internal buffer may peak to in one push before throwing. */
  maxTotalBytes: number;
}

/** Thrown by {@link FrameDecoder.push} when a peer's buffered bytes exceed a cap
 *  (C5). The caller catches it, best-effort sends `error{code:'frame_overflow'}`,
 *  and DESTROYS that socket — cap-and-drop the peer, never grow-to-OOM. `kind`
 *  says which bound tripped: a single oversized frame (`line`) or total backlog
 *  (`total`). */
export class FrameOverflowError extends Error {
  constructor(
    readonly kind: 'line' | 'total',
    readonly bytes: number,
    readonly cap: number,
  ) {
    super(`frame decoder overflow (${kind}): ${bytes} bytes exceeds cap ${cap}`);
    this.name = 'FrameOverflowError';
  }
}

/** Caps the CLIENT uses reading BROKER frames. The `welcome.snapshot` carries the
 *  full message history and can be many MiB, so these are generous. Covers
 *  realistic long sessions; snapshot CHUNKING is deferred (plan §1.1 known
 *  limitation, review m3 — the long-lived broker makes a big welcome a realistic,
 *  not pathological, trigger, but the fixed cap is accepted for Phase 4). */
export const CLIENT_READ_CAPS: FrameDecoderCaps = {
  maxLineBytes: 256 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** Caps the BROKER uses reading CLIENT frames. Plan §1.1 specified a tight
 *  4/16 MiB, but review M1 requires image-paste frames to fit: a resizeImage-
 *  bounded PNG's base64 is a few MiB and would clip a 4 MiB line cap. So these are
 *  RAISED above the plan's 4/16 to hold an image-bearing `prompt`/`steer`/
 *  `follow_up` frame (M1). Still bounded, so a malicious/buggy client→broker frame
 *  is cap-and-dropped, never grow-to-OOM (C5). */
export const BROKER_READ_CAPS: FrameDecoderCaps = {
  maxLineBytes: 24 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
};

/** Incremental newline-delimited JSON reader: feed raw socket chunks, get back
 *  the complete frames decoded so far. Buffers a partial trailing line across
 *  pushes; silently drops a malformed (unparseable) line (a viewer must never
 *  crash the broker on bad JSON). The caller narrows the `unknown` against the
 *  frame unions.
 *
 *  BOUNDED (C5): an oversized buffer is the THROW case. If a single push peaks the
 *  internal buffer above `maxTotalBytes`, or the surviving (unterminated) partial
 *  line exceeds `maxLineBytes`, {@link push} throws {@link FrameOverflowError}
 *  instead of returning frames — the caller drops that peer rather than letting a
 *  malicious/buggy stream grow the buffer to OOM. Bytes are measured with
 *  `Buffer.byteLength`, never string length; a running counter makes each push's
 *  size CHECK O(1) (no re-scan of the whole buffer to measure it).
 *
 *  AMORTIZED O(total bytes) (perf regression fix, 2026-06-09): the partial line
 *  carried across pushes is held as an ARRAY of chunk strings (`parts`), joined
 *  only when its terminating `\n` arrives. The `\n` scan looks at each incoming
 *  chunk ONCE — never re-scanning the accumulated carry — so a multi-MiB frame
 *  arriving in ~64 KiB socket chunks costs O(frame) total instead of O(frame ×
 *  chunks). The old `buf += chunk; buf.indexOf('\n')` shape flattened + re-walked
 *  the whole carry per chunk: a 16 MiB welcome snapshot cost ~250 ms of
 *  event-loop stall in `crtr attach` (typing lag) and the same again in the
 *  broker; this shape decodes it in ~13 ms.
 *
 *  A `StringDecoder` decodes incoming Buffer chunks: an incomplete trailing
 *  multibyte sequence is held back across pushes instead of being mangled to
 *  U+FFFD, so a char split at a `node:net` chunk boundary is never corrupted, and
 *  `partBytes` counts decoded-string bytes (a raw `chunk.length` would desync
 *  and weaken the C5 cap on multibyte/invalid input). */
export class FrameDecoder {
  /** The unterminated partial line carried across pushes, as unjoined chunks
   *  (never contains a '\n'). Joined lazily when its newline arrives. */
  private parts: string[] = [];
  /** Byte length (Buffer.byteLength) of `parts` joined — kept in exact lockstep. */
  private partBytes = 0;
  private readonly utf8 = new StringDecoder('utf8');

  constructor(private readonly caps: FrameDecoderCaps) {}

  push(chunk: Buffer | string): unknown[] {
    // A string input is already complete text; a Buffer goes through the
    // StringDecoder so a boundary-split multibyte char is buffered, not corrupted.
    const str = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    const strBytes = Buffer.byteLength(str);
    // Peak-buffer bound: caps the most we ever hold in one push (carry + this
    // entire chunk, before draining complete frames) — identical accounting to
    // the old whole-buffer check.
    if (this.partBytes + strBytes > this.caps.maxTotalBytes) {
      throw new FrameOverflowError(
        'total',
        this.partBytes + strBytes,
        this.caps.maxTotalBytes,
      );
    }
    const out: unknown[] = [];
    let from = 0; // scan offset into `str` — each chunk is scanned exactly once
    let nl: number;
    while ((nl = str.indexOf('\n', from)) >= 0) {
      const tail = str.slice(from, nl);
      // First line of the push completes the carried partial; later lines live
      // entirely inside `str` (parts is empty after the first join).
      const line = (this.parts.length > 0 ? this.parts.join('') + tail : tail).trim();
      this.parts.length = 0;
      this.partBytes = 0;
      from = nl + 1;
      if (line === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* drop a malformed frame — never throw out of the reader for bad JSON */
      }
    }
    if (from < str.length) {
      const rest = from === 0 ? str : str.slice(from);
      this.parts.push(rest);
      this.partBytes += from === 0 ? strBytes : Buffer.byteLength(rest);
    }
    // Single-frame bound: a partial line that has grown past one frame's cap is a
    // peer streaming bytes with no newline — drop it rather than buffer forever.
    if (this.partBytes > this.caps.maxLineBytes) {
      throw new FrameOverflowError('line', this.partBytes, this.caps.maxLineBytes);
    }
    return out;
  }
}
