/**
 * The message-model reducer (design D12): a PURE fold of an `AgentSessionEvent`
 * into an `AgentMessage[]` snapshot — the exact shape a broker `WelcomeFrame`
 * (or the static-session normalizer) delivers as `snapshot.history`.
 *
 * ONE reduction, TWO consumers:
 *   - the server hub folds each relayed event to keep its cached snapshot
 *     current, so a tab entering mid-stream gets an up-to-date `snapshot`;
 *   - the SPA folds the same events to render the live stream.
 *
 * Framework-free: pure TS over pi types, no Solid, no DOM. The reducer never
 * mutates its input — it returns the same array reference when an event leaves
 * history unchanged, and a new array (with the touched message replaced by a
 * fresh object) when it changes, so reference identity drives change detection.
 *
 * Faithfulness to pi: streamed text/thinking are ASSEMBLED from the nested
 * `assistantMessageEvent` deltas; tool-call blocks are adopted from the event's
 * authoritative `partial`/final `toolCall` (their args are structured JSON, not
 * a delta string); `message_end` adopts pi's authoritative final message, so
 * the finalized history matches pi exactly regardless of mid-stream assembly.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

/** Assistant content block (assistant messages never carry images). */
type AssistantBlock = TextContent | ThinkingContent | ToolCall;

/**
 * Seed a reducer store from a catch-up `history` (the broker/static snapshot).
 * Returns a shallow copy so later `applyEvent` calls never mutate the source.
 */
export function initMessages(history: readonly AgentMessage[] = []): AgentMessage[] {
  return history.slice();
}

/**
 * Fold one engine event into the message store. Pure: `messages` is never
 * mutated. Returns the same reference for a no-op event, else a new array.
 */
export function applyEvent(
  messages: AgentMessage[],
  event: AgentSessionEvent,
): AgentMessage[] {
  switch (event.type) {
    case 'message_start':
      return [...messages, cloneMessage(event.message)];
    case 'message_update':
      return applyAssistantEvent(messages, event.assistantMessageEvent);
    case 'message_end':
      return finalizeMessage(messages, event.message);
    case 'tool_execution_start':
      return startToolResult(messages, event.toolCallId, event.toolName);
    case 'tool_execution_update':
      return fillToolResult(messages, event.toolCallId, event.partialResult, false);
    case 'tool_execution_end':
      return endToolResult(
        messages,
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
      );
    default:
      // agent_start / turn_start / turn_end / agent_end / queue_update /
      // compaction_* / session_info_changed / thinking_level_changed /
      // auto_retry_* — none mutate the resolved message history.
      return messages;
  }
}

// --- assistant streaming (message_update.assistantMessageEvent) -------------

function applyAssistantEvent(
  messages: AgentMessage[],
  ev: AssistantMessageEvent,
): AgentMessage[] {
  const idx = lastAssistantIndex(messages);

  if (idx === -1) {
    // No streaming assistant in the store yet (e.g. an update applied straight
    // onto a bare snapshot). Adopt the event's authoritative full message.
    const authoritative = authoritativeMessage(ev);
    return authoritative ? [...messages, cloneAssistant(authoritative)] : messages;
  }

  const active = cloneAssistant(messages[idx] as AssistantMessage);

  switch (ev.type) {
    case 'start':
      if (active.content.length === 0) {
        active.content = ev.partial.content.map(cloneBlock);
      }
      break;
    case 'text_start':
      setBlock(active, ev.contentIndex, { type: 'text', text: '' });
      break;
    case 'text_delta':
      ensureText(active, ev.contentIndex).text += ev.delta;
      break;
    case 'text_end':
      ensureText(active, ev.contentIndex).text = ev.content;
      break;
    case 'thinking_start':
      setBlock(active, ev.contentIndex, { type: 'thinking', thinking: '' });
      break;
    case 'thinking_delta':
      ensureThinking(active, ev.contentIndex).thinking += ev.delta;
      break;
    case 'thinking_end':
      ensureThinking(active, ev.contentIndex).thinking = ev.content;
      break;
    case 'toolcall_start':
    case 'toolcall_delta': {
      // Tool-call args stream as opaque partial JSON; the partial assistant
      // message carries the progressively-parsed `ToolCall` block — adopt it.
      const block = ev.partial.content[ev.contentIndex];
      if (block) setBlock(active, ev.contentIndex, cloneBlock(block));
      break;
    }
    case 'toolcall_end':
      setBlock(active, ev.contentIndex, cloneToolCall(ev.toolCall));
      break;
    case 'done':
      return replaceAt(messages, idx, cloneAssistant(ev.message));
    case 'error':
      return replaceAt(messages, idx, cloneAssistant(ev.error));
    default:
      return messages;
  }

  return replaceAt(messages, idx, active);
}

function finalizeMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  if (message.role === 'assistant') {
    const idx = lastAssistantIndex(messages);
    if (idx === -1) return [...messages, cloneMessage(message)];
    // Adopt pi's authoritative final assistant message.
    return replaceAt(messages, idx, cloneMessage(message));
  }
  // Non-assistant message_end: the message was already appended at
  // message_start, so finalization is a no-op on history.
  return messages;
}

// --- tool result streaming (tool_execution_*) -------------------------------

function startToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  toolName: string,
): AgentMessage[] {
  if (findToolResultIndex(messages, toolCallId) !== -1) return messages;
  const tr: ToolResultMessage = {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [],
    isError: false,
    timestamp: Date.now(),
  };
  return [...messages, tr];
}

function fillToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  result: unknown,
  isError: boolean,
): AgentMessage[] {
  const idx = findToolResultIndex(messages, toolCallId);
  if (idx === -1) return messages;
  const prev = messages[idx] as ToolResultMessage;
  const tr: ToolResultMessage = { ...prev, content: prev.content, isError };
  const r = result as { content?: ToolResultMessage['content']; details?: unknown } | undefined;
  if (r && Array.isArray(r.content)) tr.content = r.content.map(cloneBlock);
  if (r && 'details' in r) tr.details = r.details;
  return replaceAt(messages, idx, tr);
}

function endToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): AgentMessage[] {
  const idx = findToolResultIndex(messages, toolCallId);
  const r = result as { content?: ToolResultMessage['content']; details?: unknown } | undefined;
  const prev = idx === -1 ? undefined : (messages[idx] as ToolResultMessage);
  const tr: ToolResultMessage = {
    role: 'toolResult',
    toolCallId,
    toolName: prev?.toolName ?? toolName,
    content: r && Array.isArray(r.content) ? r.content.map(cloneBlock) : (prev?.content ?? []),
    details: r ? r.details : prev?.details,
    isError,
    timestamp: prev?.timestamp ?? Date.now(),
  };
  if (idx === -1) return [...messages, tr];
  return replaceAt(messages, idx, tr);
}

// --- helpers ----------------------------------------------------------------

function authoritativeMessage(ev: AssistantMessageEvent): AssistantMessage | undefined {
  if (ev.type === 'done') return ev.message;
  if (ev.type === 'error') return ev.error;
  return ev.partial;
}

function lastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

function findToolResultIndex(messages: AgentMessage[], toolCallId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'toolResult' && m.toolCallId === toolCallId) return i;
  }
  return -1;
}

function replaceAt(messages: AgentMessage[], idx: number, m: AgentMessage): AgentMessage[] {
  const out = messages.slice();
  out[idx] = m;
  return out;
}

function setBlock(m: AssistantMessage, i: number, block: AssistantBlock): void {
  while (m.content.length < i) m.content.push({ type: 'text', text: '' });
  m.content[i] = block;
}

function ensureText(m: AssistantMessage, i: number): TextContent {
  const b = m.content[i];
  if (b && b.type === 'text') return b;
  const nb: TextContent = { type: 'text', text: '' };
  setBlock(m, i, nb);
  return nb;
}

function ensureThinking(m: AssistantMessage, i: number): ThinkingContent {
  const b = m.content[i];
  if (b && b.type === 'thinking') return b;
  const nb: ThinkingContent = { type: 'thinking', thinking: '' };
  setBlock(m, i, nb);
  return nb;
}

function cloneBlock<T extends { type: string }>(b: T): T {
  if (b.type === 'toolCall') return cloneToolCall(b as unknown as ToolCall) as unknown as T;
  return { ...b };
}

function cloneToolCall(tc: ToolCall): ToolCall {
  return { ...tc, arguments: { ...tc.arguments } };
}

function cloneAssistant(m: AssistantMessage): AssistantMessage {
  return { ...m, content: m.content.map(cloneBlock) };
}

function cloneMessage(m: AgentMessage): AgentMessage {
  switch (m.role) {
    case 'assistant':
      return cloneAssistant(m);
    case 'toolResult':
      return { ...m, content: (m.content ?? []).map(cloneBlock) };
    case 'user':
      return {
        ...m,
        content: typeof m.content === 'string' ? m.content : m.content.map(cloneBlock),
      };
    default:
      return { ...m };
  }
}
