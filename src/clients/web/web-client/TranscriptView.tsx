// Transcript.tsx — renders the ConvState message list. A fresh React surface
// (not a port of the TUI painter): one block per role, content blocks rendered
// by `type`. v1 renders the three core roles + the four content-block kinds
// precisely, with a generic fallback for app-custom messages.

import type { JSX } from 'react';
import type {
  AnyMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from './protocol.js';
import type { ConvState } from './transcript.js';

function roleOf(m: AnyMessage): string {
  return (m as { role?: string }).role ?? '';
}

function ImageBlock({ block }: { block: ImageContent }): JSX.Element {
  return (
    <img
      src={`data:${block.mimeType};base64,${block.data}`}
      alt="attached"
      className="my-1 max-h-64 max-w-full rounded border border-neutral-700"
    />
  );
}

function TextBlock({ block }: { block: TextContent }): JSX.Element {
  return <div className="whitespace-pre-wrap break-words text-neutral-100">{block.text}</div>;
}

function ThinkingBlock({ block }: { block: ThinkingContent }): JSX.Element {
  return (
    <details className="my-1 rounded border border-neutral-700 bg-neutral-900/60 px-2 py-1">
      <summary className="cursor-pointer text-xs text-neutral-400 select-none">💭 thinking</summary>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-400">
        {block.redacted ? '[redacted]' : block.thinking}
      </div>
    </details>
  );
}

function ToolCallBlock({ block, executing }: { block: ToolCall; executing: boolean }): JSX.Element {
  return (
    <div className="my-1 rounded border border-sky-800/60 bg-sky-950/30 px-2 py-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sky-300">⚙ {block.name}</span>
        {executing && <span className="animate-pulse text-xs text-amber-400">executing…</span>}
      </div>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-neutral-400">
        {safeJson(block.arguments)}
      </pre>
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function contentBlock(block: unknown, key: number, executingToolIds: ReadonlySet<string>): JSX.Element {
  const b = block as { type?: string };
  switch (b.type) {
    case 'text':
      return <TextBlock key={key} block={block as TextContent} />;
    case 'thinking':
      return <ThinkingBlock key={key} block={block as ThinkingContent} />;
    case 'toolCall': {
      const tc = block as ToolCall;
      return <ToolCallBlock key={key} block={tc} executing={executingToolIds.has(tc.id)} />;
    }
    case 'image':
      return <ImageBlock key={key} block={block as ImageContent} />;
    default:
      return (
        <pre key={key} className="my-1 whitespace-pre-wrap break-words text-xs text-neutral-500">
          {safeJson(block)}
        </pre>
      );
  }
}

function Bubble({ label, tone, children }: { label: string; tone: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-3 py-2">
      <div className={`mb-0.5 text-xs font-semibold uppercase tracking-wide ${tone}`}>{label}</div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function UserBlock({ m }: { m: UserMessage }): JSX.Element {
  const content =
    typeof m.content === 'string'
      ? [<TextBlock key={0} block={{ type: 'text', text: m.content }} />]
      : m.content.map((b, i) => contentBlock(b, i, new Set()));
  return (
    <Bubble label="you" tone="text-emerald-400">
      {content}
    </Bubble>
  );
}

function AssistantBlock({ m, executingToolIds }: { m: AssistantMessage; executingToolIds: ReadonlySet<string> }): JSX.Element {
  return (
    <Bubble label="agent" tone="text-sky-400">
      {m.content.map((b, i) => contentBlock(b, i, executingToolIds))}
      {m.errorMessage && (
        <div className="mt-1 rounded border border-red-800 bg-red-950/40 px-2 py-1 text-sm text-red-300">
          {m.stopReason === 'aborted' ? 'aborted' : 'error'}: {m.errorMessage}
        </div>
      )}
    </Bubble>
  );
}

function ToolResultBlock({ m }: { m: ToolResultMessage }): JSX.Element {
  const tone = m.isError ? 'text-red-400' : 'text-violet-400';
  return (
    <Bubble label={`result · ${m.toolName}`} tone={tone}>
      <div
        className={`rounded border px-2 py-1 ${
          m.isError ? 'border-red-800 bg-red-950/30' : 'border-neutral-700 bg-neutral-900/60'
        }`}
      >
        {m.content.map((b, i) => contentBlock(b, i, new Set()))}
      </div>
    </Bubble>
  );
}

function GenericBlock({ m }: { m: AnyMessage }): JSX.Element {
  return (
    <Bubble label={roleOf(m)} tone="text-neutral-500">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-neutral-500">{safeJson(m)}</pre>
    </Bubble>
  );
}

function messageNode(m: AnyMessage, key: number, executingToolIds: ReadonlySet<string>): JSX.Element {
  switch (roleOf(m)) {
    case 'user':
      return <UserBlock key={key} m={m as UserMessage} />;
    case 'assistant':
      return <AssistantBlock key={key} m={m as AssistantMessage} executingToolIds={executingToolIds} />;
    case 'toolResult':
      return <ToolResultBlock key={key} m={m as ToolResultMessage} />;
    default:
      return <GenericBlock key={key} m={m} />;
  }
}

export function Transcript({ conv }: { conv: ConvState }): JSX.Element {
  return (
    <div className="divide-y divide-neutral-800/70">
      {conv.messages.length === 0 && (
        <div className="px-3 py-6 text-center text-sm text-neutral-500">No messages yet.</div>
      )}
      {conv.messages.map((m, i) => messageNode(m, i, conv.executingToolIds))}
      {conv.activity && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-amber-400">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          {conv.activity}
        </div>
      )}
    </div>
  );
}
