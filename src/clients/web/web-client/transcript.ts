// transcript.ts — the pure, framework-free reducer that turns the broker's
// `welcome.snapshot` + the streamed `AgentSessionEvent`s into a renderable
// transcript. This is the React parallel of `chat-view.ts`'s accumulation model,
// but far simpler: every streaming `message_update`/`message_end` carries the
// FULL current `message` (pi's events embed `partial`/`message`), so we REPLACE
// the in-progress message wholesale rather than hand-applying per-delta diffs.
//
// No React, no DOM — just `applySnapshot` + `reduce`, unit-testable in isolation.

import type { AgentSessionEvent, AnyMessage, BrokerSnapshot } from './protocol.js';
import { isInboxDigest } from './shared/inbox-detect.js';

export interface ConvState {
  /** The full ordered transcript (snapshot history + streamed messages). */
  messages: AnyMessage[];
  /** Index of the assistant message currently streaming, or null. */
  streamingIndex: number | null;
  /** toolCallIds whose `tool_execution_*` is in flight (for an "executing…" badge). */
  executingToolIds: ReadonlySet<string>;
  /** True between `agent_start` and `agent_end` (drives prompt-vs-steer + Stop). */
  isStreaming: boolean;
  /** A transient activity label (Working… / Compacting… / Retrying…), or null. */
  activity: string | null;
}

export function initialConvState(): ConvState {
  return {
    messages: [],
    streamingIndex: null,
    executingToolIds: new Set(),
    isStreaming: false,
    activity: null,
  };
}

/** Plain text of a user message (string content or concatenated text blocks),
 *  for inbox-digest detection. */
function userMessageText(m: AnyMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && (b as { type?: string }).type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** Tag a `role:'user'` message as inbox-origin when its text matches the
 *  canvas-inbox-watcher coalesce digest; other messages pass through unchanged.
 *  The broker relays pi AgentMessages verbatim and never carries `origin` on the
 *  wire, so this is the sole writer of `origin:'inbox'` — recognized from the
 *  digest text. (Idempotent: a message already tagged is left as-is.) */
function tagInboxOrigin(m: AnyMessage): AnyMessage {
  if (roleOf(m) !== 'user') return m;
  if ((m as { origin?: string }).origin) return m;
  if (!isInboxDigest(userMessageText(m))) return m;
  return { ...m, origin: 'inbox' } as AnyMessage;
}

/** Seed state from the broker's catch-up snapshot. */
export function applySnapshot(snapshot: BrokerSnapshot): ConvState {
  return {
    messages: (snapshot.messages as AnyMessage[]).map(tagInboxOrigin),
    streamingIndex: null,
    executingToolIds: new Set(),
    isStreaming: snapshot.state?.isStreaming === true,
    activity: snapshot.state?.isStreaming === true ? 'Working…' : null,
  };
}

function roleOf(m: AnyMessage): string {
  return (m as { role?: string }).role ?? '';
}

// ---------------------------------------------------------------------------
// `!` bash execution (broker bash_start/bash_output/bash_end frames). These are
// broker control frames, NOT AgentSessionEvents, so the hook routes them here
// explicitly. They build a synthetic `bashExecution` message in the transcript
// that mirrors the one pi persists to context — rendered by MessageView.
// ---------------------------------------------------------------------------

/** Index of the most recent bashExecution message (the active `!` run), or null. */
function lastBashIndex(state: ConvState): number | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (roleOf(state.messages[i]!) === 'bashExecution') return i;
  }
  return null;
}

export function bashStart(state: ConvState, command: string, excludeFromContext?: boolean): ConvState {
  const msg = {
    role: 'bashExecution',
    command,
    output: '',
    exitCode: undefined,
    cancelled: false,
    truncated: false,
    excludeFromContext,
    timestamp: Date.now(),
  } as unknown as AnyMessage;
  return { ...state, messages: [...state.messages, msg] };
}

export function bashOutput(state: ConvState, chunk: string): ConvState {
  const idx = lastBashIndex(state);
  if (idx === null) return state;
  const messages = [...state.messages];
  const m = messages[idx] as Record<string, unknown>;
  messages[idx] = { ...m, output: `${(m.output as string) ?? ''}${chunk}` } as unknown as AnyMessage;
  return { ...state, messages };
}

export function bashEnd(
  state: ConvState,
  result: { exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string },
): ConvState {
  const idx = lastBashIndex(state);
  if (idx === null) return state;
  const messages = [...state.messages];
  const m = messages[idx] as Record<string, unknown>;
  messages[idx] = {
    ...m,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    truncated: result.truncated,
    fullOutputPath: result.fullOutputPath,
  } as unknown as AnyMessage;
  return { ...state, messages };
}

/** Apply one broker→client AGENT event (an `AgentSessionEvent`) to the transcript.
 *  Broker control frames (welcome/control_changed/error/…) are handled by the hook,
 *  NOT here — only pi agent events reach this function. Returns a NEW state object
 *  (with fresh `messages`/`executingToolIds` only when they actually change) so
 *  React re-renders correctly. */
export function reduce(state: ConvState, event: AgentSessionEvent): ConvState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, isStreaming: true, activity: 'Working…' };

    case 'agent_end':
      return {
        ...state,
        isStreaming: false,
        activity: null,
        streamingIndex: null,
        executingToolIds: state.executingToolIds.size ? new Set() : state.executingToolIds,
      };

    case 'message_start': {
      // User messages arrive complete on message_start (no streaming deltas), so
      // tagging here is sufficient — update/end only mutate the assistant message.
      const tagged = tagInboxOrigin(event.message as AnyMessage);
      const messages = [...state.messages, tagged];
      const isAssistant = roleOf(tagged) === 'assistant';
      return { ...state, messages, streamingIndex: isAssistant ? messages.length - 1 : state.streamingIndex };
    }

    case 'message_update': {
      // Only assistant messages stream. Replace the in-progress message with the
      // event's full `message`. If we attached mid-stream (no message_start seen),
      // adopt the last message when it is the assistant being streamed.
      let idx = state.streamingIndex;
      if (idx === null) {
        const last = state.messages.length - 1;
        if (last >= 0 && roleOf(state.messages[last]!) === 'assistant') idx = last;
      }
      if (idx === null) return state;
      const messages = [...state.messages];
      messages[idx] = event.message as AnyMessage;
      return { ...state, messages, streamingIndex: idx };
    }

    case 'message_end': {
      if (state.streamingIndex === null) return state;
      const messages = [...state.messages];
      messages[state.streamingIndex] = event.message as AnyMessage;
      return { ...state, messages, streamingIndex: null };
    }

    case 'tool_execution_start': {
      const next = new Set(state.executingToolIds);
      next.add(event.toolCallId);
      return { ...state, executingToolIds: next };
    }

    case 'tool_execution_end': {
      if (!state.executingToolIds.has(event.toolCallId)) return state;
      const next = new Set(state.executingToolIds);
      next.delete(event.toolCallId);
      return { ...state, executingToolIds: next };
    }

    case 'compaction_start':
      return { ...state, activity: 'Compacting context…' };

    case 'compaction_end':
      return { ...state, activity: state.isStreaming ? 'Working…' : null };

    case 'auto_retry_start':
      return {
        ...state,
        activity: `Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.ceil(event.delayMs / 1000)}s…`,
      };

    case 'auto_retry_end':
      return { ...state, activity: state.isStreaming ? 'Working…' : null };

    // tool_execution_update / turn_* / queue_update / session_info_changed /
    // thinking_level_changed — no transcript mutation in v1 (footer-only or
    // covered by the toolResult message that follows).
    default:
      return state;
  }
}
