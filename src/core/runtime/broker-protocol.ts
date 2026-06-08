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

/** Drive the engine — controller only. Map 1:1 to session.prompt/steer/followUp/abort. */
export interface PromptFrame {
  type: 'prompt';
  text: string;
}
export interface SteerFrame {
  type: 'steer';
  text: string;
}
export interface FollowUpFrame {
  type: 'follow_up';
  text: string;
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

/** A blocking dialog routed to the controller — pi's public RPC request type. */
export type ExtensionUIRequestFrame = RpcExtensionUIRequest;

/** Everything the broker can send. Live `AgentSessionEvent`s are relayed
 *  verbatim (the broker adds nothing); the broker's own control frames carry
 *  non-colliding `type` discriminants. */
export type BrokerToClient =
  | WelcomeFrame
  | ControlChangedFrame
  | ErrorFrame
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

/** Incremental newline-delimited JSON reader: feed raw socket chunks, get back
 *  the complete frames decoded so far. Buffers a partial trailing line across
 *  pushes; silently drops a malformed line (a viewer must never crash the
 *  broker). The caller narrows the `unknown` against the frame unions. */
export class FrameDecoder {
  private buf = '';

  push(chunk: Buffer | string): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* drop a malformed frame — never throw out of the reader */
      }
    }
    return out;
  }
}
