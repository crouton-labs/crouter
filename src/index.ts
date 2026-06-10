// @crouton-kit/crouter — the sanctioned library surface (design D1).
//
// This barrel is the ONLY supported way to import crouter as a library; the
// `exports` map gates off deep subpath imports, so consumers (notably
// @crouton-kit/crouter-web) depend on exactly the symbols re-exported here.
// Everything below is a stable, server-facing surface: runtime control that
// keeps the canvas-row ⇄ pi-session lockstep guarantees, read-only canvas/
// telemetry queries, and the broker socket client + wire protocol. Nothing
// internal (CLI plumbing, helpers) is exported. This module has no load-time
// side effects and no circular imports — keep it that way.

// ── Runtime control ──────────────────────────────────────────────────────
// Sanctioned launchers/mutators. reviveNode is the ONLY sanctioned launcher of
// `pi --session`; spawnChild's host is chosen via `hostKind: 'tmux' | 'broker'`.
export { spawnChild } from './core/runtime/spawn.js';
export type { SpawnChildOpts, SpawnChildResult } from './core/runtime/spawn.js';
export { reviveNode } from './core/runtime/revive.js';
export type { ReviveResult } from './core/runtime/revive.js';
export { closeNode } from './core/runtime/close.js';
export type { CloseNodeResult } from './core/runtime/close.js';
export { appendInbox } from './core/feed/inbox.js';
export type { InboxEntry, InboxTier, InboxKind } from './core/feed/inbox.js';

// ── Canvas reads ─────────────────────────────────────────────────────────
export { getNode, listNodes } from './core/canvas/canvas.js';
export { nodeDir } from './core/canvas/paths.js';
export type {
  NodeMeta,
  NodeRow,
  NodeStatus,
  Lifecycle,
  Mode,
} from './core/canvas/types.js';
export { asksForNodes, asksAcrossCanvas } from './core/canvas/attention.js';
export type { AskEntry } from './core/canvas/attention.js';
export { readTelemetry, readContextTokens } from './core/canvas/telemetry.js';
export type { Telemetry } from './core/canvas/telemetry.js';

// ── Broker client ────────────────────────────────────────────────────────
export { ViewSocketClient, BrokerUnavailableError } from './clients/attach/view-socket.js';

// ── Broker wire protocol (codec + frame/protocol types) ──────────────────
export {
  encodeFrame,
  FrameDecoder,
  FrameOverflowError,
  CLIENT_READ_CAPS,
  BROKER_READ_CAPS,
} from './core/runtime/broker-protocol.js';
export type {
  // Codec config
  FrameDecoderCaps,
  // Snapshot + roles
  BrokerSnapshot,
  ClientRole,
  // Broker → client frames + union
  WelcomeFrame,
  ControlChangedFrame,
  AckFrame,
  ErrorFrame,
  ExtensionUIRequestFrame,
  BrokerToClient,
  // Client → broker frames + union
  HelloFrame,
  PromptFrame,
  SteerFrame,
  FollowUpFrame,
  AbortFrame,
  RequestControlFrame,
  ReleaseControlFrame,
  ByeFrame,
  ShutdownFrame,
  SetModelFrame,
  CycleModelFrame,
  SetThinkingLevelFrame,
  SetAutoRetryFrame,
  SetAutoCompactionFrame,
  CompactFrame,
  NewSessionFrame,
  SwitchSessionFrame,
  ForkFrame,
  SetSessionNameFrame,
  GetCommandsFrame,
  NavigateTreeFrame,
  ReloadFrame,
  ExportFrame,
  ClientToBroker,
  // Extension UI request/response (chrome + dialog routing)
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  ExtensionUIResponseFrame,
} from './core/runtime/broker-protocol.js';
// SessionStats is pi's type (BrokerSnapshot.stats); re-export from the package
// root so consumers get it without a deep/peer-dep import.
export type { SessionStats } from '@earendil-works/pi-coding-agent';
