/**
 * The FROZEN browser↔server wire contract (design D11, spec §6).
 *
 * This is the single source of truth both halves of `@crouton-kit/crouter-web`
 * compile against: the bridge server (`src/server`) and the SPA (`src/client`).
 * NO field is invented beyond spec §6 (REST §6.1, session WS §6.2, canvas WS
 * §6.3). The SPA imports pi payload types ONLY from this module — never from
 * `@crouton-kit/crouter` or any broker-protocol internal. The server is the
 * sole translator between broker frames and this web envelope.
 *
 * pi payload types ride the wire by structural reference and are re-exported
 * here TYPE-ONLY (erased at build, zero runtime coupling): `AgentMessage[]` is
 * the snapshot history, `AgentSessionEvent` is the relayed engine event passed
 * through unchanged, the content-block types render those payloads.
 */

// --- pi payload types carried on the wire (type-only re-exports, D11) ---
export type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
export type { AgentMessage } from '@earendil-works/pi-agent-core';
export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from '@earendil-works/pi-ai';
// `stats` payload + thinking level + extension dialog requests are pi types too.
export type { SessionStats } from '@earendil-works/pi-coding-agent';
export type { ThinkingLevel } from '@earendil-works/pi-agent-core';
export type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from '@earendil-works/pi-coding-agent';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { SessionStats } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent';

// ===========================================================================
// FoldedMessage — AgentMessage annotated with server-side provenance tags.
// FROZEN-contract override: `origin` is additive (optional) and never carried
// on the upstream broker wire — the server stamps it at fold time using the
// coalesce() digest format that canvas-inbox-watcher injects (two crouton-kit
// packages sharing an internal contract; see src/server/session/inbox-detect.ts).
// ===========================================================================

/**
 * An `AgentMessage` enriched with server-side origin metadata.
 * Only `role:'user'` messages can carry `origin:'inbox'`; all others leave
 * `origin` undefined. `'human'` is reserved for future explicit human-origin
 * tagging (currently unset — absence means human by default).
 *
 * Defined as an intersection (not `interface extends`) because `AgentMessage`
 * is a union type and TypeScript does not allow extending unions.
 */
export type FoldedMessage = AgentMessage & {
  /** Set to `'inbox'` when the server detects this user message was injected
   *  by the canvas-inbox-watcher extension (a coalesced inbox digest). */
  origin?: 'inbox' | 'human';
};

// ===========================================================================
// Closed enums on node identity (spec §6.1, design Data model table)
// ===========================================================================

/** base session vs orchestrator. */
export type NodeMode = 'base' | 'orchestrator';
/** terminal (reaps when done) vs resident (root) node. */
export type NodeLifecycle = 'terminal' | 'resident';
/** Canvas lifecycle status. */
export type NodeLifeStatus = 'active' | 'idle' | 'done' | 'dead' | 'canceled';
/** broker-hosted (enterable) vs tmux-pane (shown, non-enterable). */
export type HostKind = 'broker' | 'tmux';

// ===========================================================================
// REST DTOs (spec §6.1)
// ===========================================================================

/** One row of `GET bridge/canvas` — node identity + runtime, no chrome. */
export interface NodeSummary {
  node_id: string;
  name: string;
  /** Node kind (developer/explore/…) — open set. */
  kind: string;
  mode: NodeMode;
  lifecycle: NodeLifecycle;
  status: NodeLifeStatus;
  cwd: string;
  /** Spine parent node id, or null for a root. */
  parent: string | null;
  /** ISO-8601 creation timestamp. */
  created: string;
  host_kind: HostKind;
  /** True iff `host_kind === 'broker'` (the web UI can open a live session). */
  enterable: boolean;
  /** Count of pending human asks (blocked-on-human indicator). */
  attention_count: number;
  /** Canvas cycle count for this node (revive/yield generations). Optional for
   *  back-compat with snapshots produced before the field existed. */
  cycles?: number;
  /** ISO-8601 of the node's most recent work (session activity), distinct from
   *  `created`. Optional/back-compat; falls back to `created` when absent. */
  last_activity?: string;
}

/** input/output token burn, with cache reads where the provider reports them. */
export interface TokenBurn {
  input: number;
  output: number;
  cache?: number;
}

/** Live context-window usage. */
export interface ContextUsage {
  tokens: number;
  window: number;
  percent: number;
}

/** Coarse session stats for chrome (distinct from pi's full `SessionStats`). */
export interface SessionStatsSummary {
  turns: number;
  user_messages: number;
  assistant_messages: number;
  cost?: number;
}

/** Viewer/controller presence for a node. */
export interface Presence {
  viewers: number;
  controller: string | null;
}

/** Git working-tree change counts for the meta strip. */
export interface GitStatus {
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
}

/** `GET bridge/nodes/:id` — `NodeSummary` plus the per-node chrome (spec §6.1). */
export interface NodeDetail extends NodeSummary {
  branch: string | null;
  model: string | null;
  tokens: TokenBurn | null;
  context: ContextUsage | null;
  tool_calls: number | null;
  stats: SessionStatsSummary | null;
  presence: Presence | null;
  /** True while a broker is live; false for a dormant (last-known) view. */
  live: boolean;
  /** Working-tree change counts for the meta strip (null when unavailable). */
  git_status?: GitStatus | null;
}

/** A slash command in a node's palette (from the broker `get_commands` reply). */
export interface Command {
  name: string;
  description: string;
  source: 'builtin' | 'command' | 'template';
  location?: 'user' | 'project' | 'path';
  path?: string;
  argument_hint?: string;
}

// --- REST error taxonomy (design Error taxonomy) ---

/** REST error codes. */
export type RestErrorCode =
  | 'bad_request'
  | 'node_not_found'
  | 'not_enterable'
  | 'no_command_source'
  | 'spawn_failed'
  | 'revive_failed'
  | 'close_failed'
  | 'message_failed'
  | 'deck_not_found'
  | 'deck_already_resolved'
  | 'resolve_failed';

/** Structured failure envelope for REST actions and reads. */
export interface ErrorEnvelope {
  ok: false;
  error: { code: RestErrorCode; message: string };
}

// --- REST response shapes (spec §6.1) ---

/** `GET bridge/canvas` body. */
export interface CanvasSnapshot {
  nodes: NodeSummary[];
  /** ISO-8601. */
  generated_at: string;
}

/** `GET bridge/nodes/:id` body. */
export interface NodeDetailResponse {
  node: NodeDetail;
}

/** `GET bridge/nodes/:id/commands` body. */
export interface CommandsResponse {
  commands: Command[];
}

/** `POST bridge/nodes` success. */
export interface SpawnResponse {
  ok: true;
  node_id: string;
}

/** `POST bridge/nodes/:id/message` success. */
export interface MessageResponse {
  ok: true;
  delivered: boolean;
  woke: boolean;
}

/** `POST bridge/nodes/:id/revive` success. */
export interface ReviveResponse {
  ok: true;
  resumed: boolean;
}

/** `POST bridge/nodes/:id/close` success. */
export interface CloseResponse {
  ok: true;
}

// --- REST request bodies (spec §6.1) ---

/** `POST bridge/nodes` body. Always headless; `root` toggles a resident node. */
export interface SpawnRequest {
  prompt: string;
  kind: string;
  mode?: NodeMode;
  root?: boolean;
  cwd?: string;
  name?: string;
  model?: string;
  parent?: string;
}

/** `POST bridge/nodes/:id/message` body. */
export interface MessageRequest {
  body: string;
  tier?: string;
}

/** `POST bridge/nodes/:id/revive` body. */
export interface ReviveRequest {
  fresh?: boolean;
}

// ===========================================================================
// Inbox — humanloop decks (design §1, §5.2, §5.6)
// ===========================================================================

/**
 * The five resolution flows (design §5.2). humanloop's `InteractionKind` also
 * has `review`; the server normalizes it (and any unknown/absent kind) onto one
 * of these five so a deck always renders through a known flow.
 */
export type DeckKind = 'notify' | 'validation' | 'decision' | 'context' | 'error';

/** One option of a decision/validation interaction (humanloop InteractionOption). */
export interface DeckOption {
  id: string;
  label: string;
  /** The option's consequence/explanation (humanloop `description`). */
  description?: string;
}

/** One interaction within a deck (humanloop Interaction, normalized for the web). */
export interface DeckInteraction {
  id: string;
  title: string;
  subtitle?: string;
  /** Markdown body (bodyPath already inlined by the server). */
  body?: string;
  kind: DeckKind;
  options: DeckOption[];
  multiSelect: boolean;
  allowFreetext: boolean;
  freetextLabel?: string;
}

/**
 * A pending ask, ranked in the inbox list (design §5.2). Provenance carries
 * BOTH the consumer-facing conversation (Studio renders this, never the node id)
 * and the raw asking node (Operator renders this, gated on `node.internals`).
 */
export interface DeckSummary {
  /** Opaque, stable inbox-entry id (base64url of the interaction dir). */
  id: string;
  /** The interaction job id (basename of the interaction dir). */
  job_id: string;
  /** The first interaction's kind — the glyph + flow for the row. */
  kind: DeckKind;
  title: string;
  subtitle?: string;
  /** ISO-8601 — when the ask started blocking (drives the wait duration + rank). */
  blocked_since: string;
  /** The conversation (spine root) this ask belongs to — Studio provenance. */
  conversation_id: string;
  conversation_title: string;
  /** The node that raised the ask — Operator provenance (node-id display gated). */
  asking_node_id: string;
  asking_node_name: string;
  /** The asking node's cwd — Operator sub-DAG scoping. */
  cwd: string;
  /** How many interactions the deck holds (a multi-question deck). */
  interaction_count: number;
}

/** The full deck for a resolution flow (`GET bridge/decks/:id`). */
export interface DeckDetail extends DeckSummary {
  interactions: DeckInteraction[];
}

/** `GET bridge/decks` body. */
export interface DecksResponse {
  decks: DeckSummary[];
  /** ISO-8601. */
  generated_at: string;
}

/** `GET bridge/decks/:id` body. */
export interface DeckDetailResponse {
  deck: DeckDetail;
}

/** One interaction's answer (humanloop InteractionResponse). */
export interface DeckAnswer {
  id: string;
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  optionComments?: Record<string, string>;
}

/** `POST bridge/decks/:id/resolve` body. */
export interface ResolveDeckRequest {
  responses: DeckAnswer[];
}

/** `POST bridge/decks/:id/resolve` success. */
export interface ResolveDeckResponse {
  resolved: true;
  job_id: string;
  delivered: boolean;
}

// ===========================================================================
// Session WebSocket — `socket/nodes/:id` (spec §6.2)
// ===========================================================================

/**
 * Engine state carried in `snapshot.state` — the broker snapshot's `state`
 * (mirrors `BrokerSnapshot.state`), reconstructed here in pi/primitive types so
 * the SPA never imports the broker-protocol `BrokerSnapshot`. The SPA's
 * streaming/idle indicator reads `isStreaming` (spec C.10).
 */
export interface SessionState {
  sessionId: string;
  sessionFile: string | null;
  model: string | null;
  isStreaming: boolean;
  thinkingLevel: ThinkingLevel;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  sessionName: string | null;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
}

/** Web role of one browser tab's session connection. */
export type WebRole = 'observer' | 'controller';

/** WS error codes (design Error taxonomy). */
export type WsErrorCode =
  | 'not_controller'
  | 'control_denied'
  | 'broker_unavailable'
  | 'frame_overflow'
  | 'dialog_expired';

/** Upstream broker connectivity, surfaced to the tab (spec §6.2). */
export type BrokerStatus = 'connected' | 'reconnecting' | 'down' | 'revived';

/**
 * Catch-up payload sent before any `event` (spec C.1/§6.2). `source:'broker'`
 * is a live broker `WelcomeFrame`; `source:'static'` is a dormant node's JSONL
 * replay. `controller`/`viewers` are server-derived, not broker fields.
 */
export interface SnapshotMsg {
  type: 'snapshot';
  history: FoldedMessage[];
  stats: SessionStats;
  state: SessionState;
  role: WebRole;
  controller: string | null;
  viewers: number;
  pending_dialog?: RpcExtensionUIRequest;
  source: 'broker' | 'static';
}

/** A relayed pi engine event, passed through unchanged (spec §6.2). */
export interface EventMsg {
  type: 'event';
  event: AgentSessionEvent;
}

/** Controller-slot change for this tab (spec §6.2). */
export interface ControlChangedMsg {
  type: 'control_changed';
  controller: string | null;
  you_are: WebRole;
}

/** A blocking extension UI request routed to the controller (spec §5.H/§6.2). */
export interface DialogMsg {
  type: 'dialog';
  request: RpcExtensionUIRequest;
}

/** Server-coalesced incremental chrome update (spec §6.2; design D12). */
export interface ChromeMsg {
  type: 'chrome';
  branch?: string | null;
  model?: string | null;
  tokens?: TokenBurn | null;
  context?: ContextUsage | null;
  tool_calls?: number | null;
  stats?: SessionStatsSummary | null;
  /** Working-tree change counts pushed alongside branch updates. */
  git_status?: GitStatus | null;
}

/** Acknowledgement of a client command (spec §6.2). */
export interface AckMsg {
  type: 'ack';
  for: string;
  ok: boolean;
  detail?: string;
}

/** Upstream broker status change (spec §6.2). */
export interface BrokerStatusMsg {
  type: 'broker_status';
  state: BrokerStatus;
}

/** Error surfaced on the session socket (spec §6.2). */
export interface WsErrorMsg {
  type: 'error';
  code: WsErrorCode;
  message: string;
}

/** Server → client session messages (spec §6.2). */
export type WsServerMsg =
  | SnapshotMsg
  | EventMsg
  | ControlChangedMsg
  | DialogMsg
  | ChromeMsg
  | AckMsg
  | BrokerStatusMsg
  | WsErrorMsg;

// --- Client → server session messages (spec §6.2) ---

/** Send a live prompt — controller-only, requires a live broker. */
export interface PromptMsg {
  type: 'prompt';
  text: string;
  images?: import('@earendil-works/pi-ai').ImageContent[];
}

/** Steer the current turn mid-flight — controller-only. */
export interface SteerMsg {
  type: 'steer';
  text: string;
  images?: import('@earendil-works/pi-ai').ImageContent[];
}

/** Abort the current turn — controller-only. */
export interface AbortMsg {
  type: 'abort';
}

/** Set the active model — controller-only. */
export interface SetModelMsg {
  type: 'set_model';
  model: string;
}

/** Cycle to the next model — controller-only. */
export interface CycleModelMsg {
  type: 'cycle_model';
}

/** Set the thinking level — controller-only. */
export interface SetThinkingLevelMsg {
  type: 'set_thinking_level';
  level: ThinkingLevel;
}

/** Request a compaction — controller-only. */
export interface CompactMsg {
  type: 'compact';
  instructions?: string;
}

/** Ask to become the web-controller (always accepted; arbitrated server-side). */
export interface RequestControlMsg {
  type: 'request_control';
}

/** Release the web-controller slot (always accepted). */
export interface ReleaseControlMsg {
  type: 'release_control';
}

/** Response payload to an extension dialog (`RpcExtensionUIResponse` minus id/type). */
export type DialogResponseValue =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

/** Answer a blocking extension dialog — controller-only. */
export interface DialogResponseMsg {
  type: 'dialog_response';
  request_id: string;
  response: DialogResponseValue;
}

/** Client → server session messages (spec §6.2). */
export type WsClientMsg =
  | PromptMsg
  | SteerMsg
  | AbortMsg
  | SetModelMsg
  | CycleModelMsg
  | SetThinkingLevelMsg
  | CompactMsg
  | RequestControlMsg
  | ReleaseControlMsg
  | DialogResponseMsg;

// ===========================================================================
// Canvas WebSocket — `socket/canvas` (spec §6.3)
// ===========================================================================

/** Pushed canvas snapshot/delta; same shape as `GET bridge/canvas` plus a tag. */
export interface CanvasMsg {
  type: 'canvas';
  nodes: NodeSummary[];
  /** ISO-8601. */
  generated_at: string;
}

// ===========================================================================
// Views — structured agent-authored pages (design D11, §7)
// ===========================================================================

/**
 * A typed content block within a view tab. Discriminated union of three
 * block kinds: inline/sourced markdown, a KPI grid, and a bar-list chart.
 */
export type ViewBlock =
  | { kind: 'markdown'; source: { node_id: string; path: string } | { inline: string } }
  | { kind: 'kpis'; items: { label: string; value: string; unit?: string; sub?: string }[] }
  | { kind: 'barlist'; title: string; rows: { label: string; value: number; max?: number; note?: string }[] };

/** A named tab within a view, carrying one or more content blocks. */
export interface ViewTab {
  id: string;
  label: string;
  blocks: ViewBlock[];
}

/** Full view manifest — the root record for an agent-authored view. */
export interface ViewManifest {
  id: string;
  title: string;
  built_by: string | null;
  updated_at: string;
  status?: NodeLifeStatus;
  tabs: ViewTab[];
}

/** `GET bridge/views` body. */
export interface ViewsResponse {
  views: ViewManifest[];
}

/** `GET bridge/views/:id` body. */
export interface ViewDetailResponse {
  view: ViewManifest;
}
