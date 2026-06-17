// protocol.ts — the one type surface the web client imports.
//
// Everything here is TYPE-ONLY: the broker wire frames come from the canonical
// `broker-protocol.ts` (so they never drift from the broker), and the pi message
// model comes from the pi packages' public roots. Type-only imports are erased by
// the bundler, so NONE of the Node-only runtime in those modules (FrameDecoder,
// StringDecoder, the SDK) reaches the browser bundle.

export type {
  // pi message model (snapshot.messages entries + streamed deltas)
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';

export type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export type {
  ClientRole,
  ClientToBroker,
  BrokerToClient,
  BrokerSnapshot,
  WelcomeFrame,
  ControlChangedFrame,
  ModelChangedFrame,
  ErrorFrame,
  AckFrame,
  DisplayStatusFrame,
  DisplayWidgetFrame,
  DisplayTitleFrame,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from '../../../core/runtime/broker-protocol.js';

import type { Message } from '@earendil-works/pi-ai';

/** A message as it appears in `snapshot.messages` / a `message_*` event: the pi
 *  `Message` union (user | assistant | toolResult) OR an app-custom message
 *  (`bashExecution`, `compactionSummary`, `skillInvocation`, …) that still
 *  carries a `role`. We render the three core roles precisely and fall back to a
 *  generic block for any other `role`. */
export type AnyMessage = Message | ({ role: string } & Record<string, unknown>);
