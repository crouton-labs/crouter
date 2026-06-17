/**
 * Shared wire types for the crouter web client/server split.
 *
 * The SPA imports the pi payload types it needs from this module — never from
 * broker-protocol internals. The type-only re-exports below keep the web
 * package's shared payload shapes in one place.
 */

// --- pi payload types carried on the wire (type-only re-exports, D11) ---
export type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall,
  ImageContent,
} from '@earendil-works/pi-ai';
export type { ThinkingLevel } from '@earendil-works/pi-agent-core';
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '@earendil-works/pi-coding-agent';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

// ===========================================================================
// FoldedMessage — AgentMessage annotated with a client-side provenance tag.
// `origin` is additive (optional) and never carried on the broker wire, which
// relays pi's AgentMessages verbatim — it is recognized from the message text
// using the coalesce() digest format that canvas-inbox-watcher injects (two
// crouton-kit packages sharing an internal contract; see shared/inbox-detect.ts).
// ===========================================================================

/**
 * An `AgentMessage` enriched with a client-side origin tag.
 * Only `role:'user'` messages can carry `origin:'inbox'`; all others leave
 * `origin` undefined. `'human'` is reserved for future explicit human-origin
 * tagging (currently unset — absence means human by default).
 *
 * Defined as an intersection (not `interface extends`) because `AgentMessage`
 * is a union type and TypeScript does not allow extending unions.
 */
export type FoldedMessage = AgentMessage & {
  /** Set to `'inbox'` when this user message is recognized as injected by the
   *  canvas-inbox-watcher extension (a coalesced inbox digest). */
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
// Bridge command shapes (spec §6.1)
// ===========================================================================

/** One row from `crtr canvas snapshot --json` — node identity + runtime, no chrome. */
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

/** `crtr node inspect show --json`'s node payload — `NodeSummary` plus the per-node chrome. */
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

// --- `crtr --json` response shapes (spec §6.1) ---

/** `crtr canvas snapshot --json` body. */
export interface CanvasSnapshot {
  nodes: NodeSummary[];
  /** ISO-8601. */
  generated_at: string;
}

/** `crtr node new --json` success. */
export interface SpawnResponse {
  node_id: string;
  name: string;
  window?: string;
  session?: string;
  status: string;
  follow_up: string;
}

/** `crtr node msg --json` success. */
export interface MessageResponse {
  delivered: boolean;
  node_id: string;
  woke: boolean;
}

/** `crtr canvas revive --json` success. */
export interface ReviveResponse {
  window: null;
  session: string | null;
  resumed: boolean;
  ready: boolean;
}

/** `crtr node close --json` success. */
export interface CloseResponse {
  closed: boolean;
  node_id: string;
  count: number;
  closed_ids: string[];
  spared: string[];
}

// --- `crtr` request bodies (spec §6.1) ---

/** `crtr node new` body. Always headless; `root` toggles a resident node. */
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

/** `crtr node msg` body. */
export interface MessageRequest {
  body: string;
  tier?: string;
}

/** `crtr canvas revive` body. */
export interface ReviveRequest {
  fresh?: boolean;
}

// ===========================================================================
// Inbox — humanloop decks (design §1, §5.2, §5.6)
// ===========================================================================

/**
 * The five resolution flows (design §5.2). humanloop's `InteractionKind` also
 * has `review`; the deck loader normalizes it (and any unknown/absent kind)
 * onto one of these five so a deck always renders through a known flow.
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
  /** Markdown body (bodyPath already inlined by `crtr human deck`). */
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

/** The full deck for a resolution flow (`crtr human deck <id> --json`). */
export interface DeckDetail extends DeckSummary {
  interactions: DeckInteraction[];
}

/** One interaction's answer (humanloop InteractionResponse). */
export interface DeckAnswer {
  id: string;
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  optionComments?: Record<string, string>;
}

/** `crtr human resolve <id> --json` body. */
export interface ResolveDeckRequest {
  responses: DeckAnswer[];
}

/** `crtr human resolve <id> --json` success. */
export interface ResolveDeckResponse {
  resolved: true;
  job_id: string;
  delivered: boolean;
}

// Session state for the web client.

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

/** Upstream broker connectivity, surfaced to the tab (spec §6.2). */
export type BrokerStatus = 'connected' | 'reconnecting' | 'down' | 'revived';

/** Response payload to an extension dialog (`RpcExtensionUIResponse` minus id/type). */
export type DialogResponseValue =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

// Views — structured agent-authored pages (design D11, §7)

/**
 * A typed content block within a view tab. Discriminated union of three
 * block kinds: inline/sourced markdown, a KPI grid, and a bar-list chart.
 */
export type ViewBlock =
  | { kind: 'markdown'; source: { node_id: string; path: string } | { inline: string } }
  | { kind: 'kpis'; items: { label: string; value: string; unit?: string; sub?: string }[] }
  | { kind: 'barlist'; title: string; rows: { label: string; value: number; max?: number; note?: string }[] };
