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
  SessionEntry,
  SessionInfo,
  SettingsConfig,
  SessionStats,
} from '@earendil-works/pi-coding-agent';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
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
/** `cycleModel(direction)` — ctrl+p (forward) / shift+ctrl+p (backward). `direction`
 *  defaults to `'forward'` when absent (back-compat with the original frame). */
export interface CycleModelFrame {
  type: 'cycle_model';
  direction?: 'forward' | 'backward';
}
/** `cycleThinkingLevel()` — shift+tab. Cycles to the next thinking level; the new
 *  level reaches viewers via the relayed `thinking_level_changed` event, so the
 *  broker replies a plain `ack` (no payload). Distinct from `set_thinking_level`,
 *  which jumps to a specific level chosen in the thinking picker. */
export interface CycleThinkingFrame {
  type: 'cycle_thinking';
}
/** `setThinkingLevel(level)` — `/settings` thinking / thinking picker. */
export interface SetThinkingLevelFrame {
  type: 'set_thinking_level';
  level: AgentSession['thinkingLevel'];
}
/** `clearQueue()` — alt+up (dequeue). Removes ALL queued steering + follow-up
 *  messages and returns them so the viewer can restore them to the editor. A
 *  read-AND-mutate op: carries a correlation `id` and the broker replies with a
 *  `data{ kind:'dequeue' }` frame carrying the cleared messages. */
export interface DequeueFrame {
  type: 'dequeue';
  id: string;
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

// ---------------------------------------------------------------------------
// Read-op request frames (operator-view picker data, design §5 Unit A)
// ---------------------------------------------------------------------------
// Each fetches the engine-side state a native pi picker's constructor needs and
// is answered by a correlated `data` frame (below), keyed by `id`. These are NOT
// controller-gated (read-only, like `get_commands`): any client — controller or
// observer — may request them, so the web bridge's observer connection can
// populate pickers too. `id` is a client-chosen correlation token echoed in the
// reply (mirrors the extension-dialog `id` convention).

/** Model-selector data (`/model`, ctrl+l): the full registry, the current model,
 *  which models have auth, the `--models` scoped set, and the enabled-model set. */
export interface ListModelsFrame {
  type: 'list_models';
  id: string;
}
/** Session-resume data (`/resume`): the session list. `scope` selects the
 *  cwd-local list (default) or the cross-project list — `SessionSelectorComponent`
 *  uses BOTH loaders, so the viewer issues one request per scope. */
export interface ListSessionsFrame {
  type: 'list_sessions';
  id: string;
  scope?: 'cwd' | 'all';
}
/** Session-tree + fork data (`/tree` nav AND `/fork` selector): the full tree,
 *  the current leaf, and the prior user messages the fork picker lists. */
export interface GetTreeFrame {
  type: 'get_tree';
  id: string;
}
/** Interactive settings-menu data (`/settings`): the full `SettingsConfig` toggle
 *  set plus auto-retry + current model (design §5 Unit A). */
export interface GetSettingsFrame {
  type: 'get_settings';
  id: string;
}
/** Scoped-models picker data (`/scoped-models`): every model + the enabled set. */
export interface ListScopedModelsFrame {
  type: 'list_scoped_models';
  id: string;
}

/** Answer a blocking extension dialog — pi's public RPC response type. */
export type ExtensionUIResponseFrame = RpcExtensionUIResponse;

/** Clone the current session to a new branch (`/clone`). Controller-only.
 *  Broker handler: reads current leaf from sessionManager, creates a branched
 *  session file, switches to it via runReplacement. */
export interface CloneFrame {
  type: 'clone';
}

/** Share the session as a secret GitHub gist (`/share`). Controller-only.
 *  Broker handler: exports session to a temp HTML file, shells `gh gist create --secret`,
 *  returns the URL in ack.detail. */
export interface ShareFrame {
  type: 'share';
}

/** Reload credentials + refresh model registry after a viewer-side auth change.
 *  Controller-only. Broker handler: services.authStorage.reload() + services.modelRegistry.refresh(). */
export interface ReloadAuthFrame {
  type: 'reload_auth';
}

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
  | CycleThinkingFrame
  | SetThinkingLevelFrame
  | DequeueFrame
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
  | ListModelsFrame
  | ListSessionsFrame
  | GetTreeFrame
  | GetSettingsFrame
  | ListScopedModelsFrame
  | ExtensionUIResponseFrame
  | CloneFrame
  | ShareFrame
  | ReloadAuthFrame;

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
  /** The pi agent dir (`~/.pi/agent`) from the broker's process — so the viewer
   *  can construct an AuthStorage/ModelRegistry pointing at the SAME auth.json.
   *  crtr attach is tmux-local only: broker + viewer share a filesystem. */
  agentDir?: string;
}

export interface ControlChangedFrame {
  type: 'control_changed';
  controller_id: string | null;
}

/** Broadcast to EVERY client after a successful `set_model`/`cycle_model`. pi
 *  emits no AgentSessionEvent for a model switch, so without this the new model
 *  reaches no viewer at all (the requester gets only a bare ack) and footers
 *  show the stale model until the next unrelated event. `model` mirrors
 *  `snapshot.state.model` (the model id); undefined when the engine has none. */
export interface ModelChangedFrame {
  type: 'model_changed';
  model: string | undefined;
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  /** Correlation token, echoed from the request that failed. Present ONLY on the
   *  failure of a correlated request (a read-op or `dequeue`, which carry an `id`
   *  and otherwise resolve via a `data` frame) so the viewer can reject the exact
   *  pending-by-id promise instead of hanging it. Absent on uncorrelated errors
   *  (engine drive errors, command-op failures, frame_overflow). */
  id?: string;
}

/** Result of a controller command op (§1.3): `for` echoes the op name, `ok` the
 *  outcome, `detail` an optional human-readable note. */
export interface AckFrame {
  type: 'ack';
  for: string;
  ok: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Read-op DATA frames (operator-view picker payloads, design §5 Unit A)
// ---------------------------------------------------------------------------
// The typed replies to the read-op request frames, plus the dequeue result. All
// share `type:'data'` + a `kind` discriminant + the request's correlation `id`,
// so a viewer can both narrow the payload by `kind` AND match it to the request
// it issued. Built by pure getter reads against the live engine session (broker.ts).
//
// SERIALIZATION NOTES (design R1):
//  - `Model<Api>` is pure data (no methods) — relayed verbatim; the viewer can
//    feed it to a `SelectList` directly or repopulate a client-side ModelRegistry.
//  - pi's `*SelectorComponent`s take LIVE `ModelRegistry`/`SettingsManager`/session-
//    loader OBJECTS that cannot cross a socket. The viewer (Unit B) reconstructs
//    those from these payloads (both classes are publicly constructible) or renders
//    a SelectList — see the report's R1 caveat.

/** `provider/id` model reference — the wire form of a current/selected model. */
export interface WireModelRef {
  provider: string;
  id: string;
}

/** A `--models` scoped cycle entry (mirror of `AgentSession.scopedModels[n]`). */
export interface WireScopedModel {
  model: Model<Api>;
  thinkingLevel?: AgentSession['thinkingLevel'];
}

/** Wire form of pi's `SessionInfo`: identical EXCEPT `created`/`modified` are ISO
 *  strings (pi's are `Date`, which JSON cannot round-trip) — the viewer revives
 *  them with `new Date(...)` before handing them to `SessionSelectorComponent`. */
export interface WireSessionInfo extends Omit<SessionInfo, 'created' | 'modified'> {
  created: string;
  modified: string;
}

/** Wire form of pi's `SessionTreeNode` (NOT re-exported from the pi package root,
 *  so mirrored structurally here). Byte-compatible with `SessionManager.getTree()`'s
 *  return; `SessionEntry` IS re-exported, so it is referenced directly. */
export interface WireSessionTreeNode {
  entry: SessionEntry;
  children: WireSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

/** A prior user message for the `/fork` selector (`UserMessageSelectorComponent`
 *  consumes `{ id, text, timestamp? }`). `id` is the session entry id. */
export interface WireForkPoint {
  id: string;
  text: string;
  timestamp?: string;
}

/** The interactive settings-menu state. The full pi `SettingsConfig` (every toggle
 *  the `/settings` menu shows) PLUS auto-retry and the current model, which the
 *  menu reflects but `SettingsConfig` omits. Build-time `extends` enforces that the
 *  broker populates every `SettingsConfig` field (no thin payload — design R1). */
export interface WireSettings extends SettingsConfig {
  /** `AgentSession.autoRetryEnabled`. */
  autoRetry: boolean;
  /** `AgentSession.model`, as a `provider/id` ref (null if none selected). */
  model: WireModelRef | null;
}

export interface ListModelsData {
  type: 'data';
  id: string;
  kind: 'list_models';
  /** Every registered model (`ModelRegistry.getAll()`). */
  models: Model<Api>[];
  /** The currently selected model, or null. */
  current: WireModelRef | null;
  /** `provider/id` of every model that has auth configured (`getAvailable()`). */
  availableIds: string[];
  /** The `--models` scoped cycle set (may be empty). */
  scopedModels: WireScopedModel[];
  /** The enabled-model patterns (`SettingsManager.getEnabledModels()`), or null. */
  enabledModelIds: string[] | null;
}

export interface ListSessionsData {
  type: 'data';
  id: string;
  kind: 'list_sessions';
  scope: 'cwd' | 'all';
  sessions: WireSessionInfo[];
  /** The live session's file path, so the picker can mark the current entry. */
  currentSessionFile: string | undefined;
}

export interface GetTreeData {
  type: 'data';
  id: string;
  kind: 'get_tree';
  tree: WireSessionTreeNode[];
  currentLeafId: string | null;
  /** Prior user messages for the `/fork` selector. */
  forkPoints: WireForkPoint[];
}

export interface GetSettingsData {
  type: 'data';
  id: string;
  kind: 'get_settings';
  settings: WireSettings;
}

export interface ListScopedModelsData {
  type: 'data';
  id: string;
  kind: 'list_scoped_models';
  /** Every registered model (`ModelRegistry.getAll()`), to enable/disable. */
  allModels: Model<Api>[];
  enabledModelIds: string[] | null;
}

/** The `dequeue` result: the steering + follow-up messages just cleared, for the
 *  viewer to restore to the editor. */
export interface DequeueData {
  type: 'data';
  id: string;
  kind: 'dequeue';
  steering: string[];
  followUp: string[];
}

/** All correlated data replies (read-ops + dequeue). Discriminate on `kind`. */
export type BrokerDataFrame =
  | ListModelsData
  | ListSessionsData
  | GetTreeData
  | GetSettingsData
  | ListScopedModelsData
  | DequeueData;

// ---------------------------------------------------------------------------
// Non-blocking extension-UI display frames (design §5 Unit A task 3)
// ---------------------------------------------------------------------------
// Broadcast to ALL viewers when an extension calls the matching `ctx.ui.*` method
// (relayed by makeBrokerUiContext instead of being no-op'd). These are
// fire-and-forget DISPLAY state — no response, no correlation id. The viewer
// (Unit E) owns the slots that render them. NOTE: pi's non-blocking surface also
// includes `notify` and the working-indicator setters; only the three named in
// scope (setStatus/setWidget/setTitle) are relayed here.

/** `ctx.ui.setStatus(key, text)` — a keyed footer/status entry; `text===undefined`
 *  clears that key. */
export interface DisplayStatusFrame {
  type: 'display_status';
  key: string;
  text: string | undefined;
}
/** `ctx.ui.setWidget(key, lines, {placement})` — persistent lines above/below the
 *  editor; `lines===undefined` clears that key. The component-factory overload of
 *  setWidget cannot cross the socket and is dropped broker-side (R1 caveat). */
export interface DisplayWidgetFrame {
  type: 'display_widget';
  key: string;
  lines: string[] | undefined;
  placement: 'aboveEditor' | 'belowEditor';
}
/** `ctx.ui.setTitle(title)` — the terminal window/tab title. */
export interface DisplayTitleFrame {
  type: 'display_title';
  title: string;
}

/** A blocking dialog routed to the controller — pi's public RPC request type. */
export type ExtensionUIRequestFrame = RpcExtensionUIRequest;

/** Everything the broker can send. Live `AgentSessionEvent`s are relayed
 *  verbatim (the broker adds nothing); the broker's own control frames carry
 *  non-colliding `type` discriminants. */
export type BrokerToClient =
  | WelcomeFrame
  | ControlChangedFrame
  | ModelChangedFrame
  | ErrorFrame
  | AckFrame
  | BrokerDataFrame
  | DisplayStatusFrame
  | DisplayWidgetFrame
  | DisplayTitleFrame
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
