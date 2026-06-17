/**
 * Render ONE folded AgentMessage (spec C.4–C.7).
 *
 * Dispatches on role. Assistant messages iterate their content blocks
 * (text / thinking / tool-call); user messages render string or block content;
 * a tool result that has NO matching tool call (orphan) falls to a generic
 * card — paired results are rendered inside the assistant's tool card and are
 * filtered out upstream by MessageList.
 *
 * Streaming rule (design D9): the in-progress block is the TRAILING block of the
 * last assistant message while `streaming` is true. Only that block renders
 * via the escaped-plain-text path; every finished block runs full markdown.
 */

import type { ComponentType } from 'react';
import type {
  FoldedMessage,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
  ToolCall,
} from '@/shared/protocol.js';
import { TextBlock } from './text-block.js';
import { ThinkingBlock } from './thinking-block.js';
import { ImageBlock } from './image-block.js';
import { getToolCard } from './tool-card/registry.js';
import type { ToolCardProps } from './tool-card/parts.js';
import { usePeek } from './tool-card/parts.js';
import { extractPeekablePaths } from '../lib/file-link.js';
import { extractInboxSender } from '@/shared/inbox-detect.js';

export interface MessageViewProps {
  message: FoldedMessage;
  /** True iff this is the last assistant message in history. */
  isLastAssistant: boolean;
  streaming: boolean;
  /** Look up the tool result for a tool-call id. */
  resultFor: (toolCallId: string) => ToolResultMessage | undefined;
}

export function MessageView({ message, isLastAssistant, streaming, resultFor }: MessageViewProps) {
  const role = message.role;
  if (role === 'user') {
    if (message.origin === 'inbox') {
      return <InboundView message={message as UserMessage} />;
    }
    return (
      <div className="text-sm leading-[1.55] break-words">
        <UserView message={message as UserMessage} />
      </div>
    );
  }
  if (role === 'assistant') {
    return (
      <div className="text-sm leading-[1.55] break-words">
        <AssistantView
          message={message as AssistantMessage}
          isLastAssistant={isLastAssistant}
          streaming={streaming}
          resultFor={resultFor}
        />
      </div>
    );
  }
  if (role === 'toolResult') {
    // Reaches here only for an ORPHAN tool result (no matching call).
    return (
      <div className="text-sm leading-[1.55] break-words">
        <OrphanToolResult message={message as ToolResultMessage} />
      </div>
    );
  }
  if (role === 'bashExecution') {
    return (
      <div className="text-sm leading-[1.55] break-words">
        <BashView message={message as unknown as BashExecutionLike} />
      </div>
    );
  }
  // Unknown role: render nothing structural.
  return null;
}

interface BashExecutionLike {
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext?: boolean;
}

// A `!` bash run: monospace terminal block. The `!`/`!!` prefix is shown so the
// excluded-from-context (`!!`) form reads distinctly. Output streams in live.
function BashView({ message }: { message: BashExecutionLike }) {
  const prefix = message.excludeFromContext ? '!!' : '!';
  const running = message.exitCode === undefined && !message.cancelled;
  return (
    <div className="font-mono text-xs rounded border border-[var(--border,#333)] overflow-hidden">
      <div className="px-2 py-1 bg-[var(--surface-raised,#1a1a1a)] flex items-center gap-2">
        <span className="opacity-60 select-none">{prefix}</span>
        <span className="whitespace-pre-wrap break-all">{message.command}</span>
        {running && <span className="ml-auto opacity-50">running…</span>}
        {message.cancelled && <span className="ml-auto opacity-70">cancelled</span>}
        {!running && !message.cancelled && message.exitCode !== 0 && (
          <span className="ml-auto opacity-70">exit {message.exitCode}</span>
        )}
      </div>
      {message.output !== '' && (
        <pre className="px-2 py-1 whitespace-pre-wrap break-all m-0">{message.output}</pre>
      )}
      {message.truncated && <div className="px-2 py-1 opacity-50">output truncated</div>}
    </div>
  );
}

function UserView({ message }: { message: UserMessage }) {
  const content = message.content;
  // The user "input" voice: warm filled `.user` block + bone left rail. Role is
  // carried by surface alone — no word label.
  return (
    <div className="user">
      {typeof content === 'string' ? (
        <div className="whitespace-pre-wrap">{content}</div>
      ) : (
        (content as (TextContent | ImageContent)[]).map((block, i) => {
          if (block.type === 'text') {
            return <div key={i} className="whitespace-pre-wrap">{(block as TextContent).text}</div>;
          }
          if (block.type === 'image') {
            return <ImageBlock key={i} image={block as ImageContent} />;
          }
          return null;
        })
      )}
    </div>
  );
}

function AssistantView({
  message,
  isLastAssistant,
  streaming,
  resultFor,
}: {
  message: AssistantMessage;
  isLastAssistant: boolean;
  streaming: boolean;
  resultFor: (id: string) => ToolResultMessage | undefined;
}) {
  const content = message.content;
  const isTrailing = (i: number): boolean =>
    isLastAssistant && streaming && i === content.length - 1;

  return (
    <>
      {content.map((block, i) => {
        if (block.type === 'text') {
          return (
            <TextBlock
              key={i}
              text={(block as TextContent).text}
              inProgress={isTrailing(i)}
            />
          );
        }
        if (block.type === 'thinking') {
          return (
            <ThinkingBlock
              key={i}
              thinking={(block as { thinking: string }).thinking}
              inProgress={isTrailing(i)}
            />
          );
        }
        if (block.type === 'toolCall') {
          return (
            <ToolCallBlock
              key={i}
              call={block as ToolCall}
              streaming={streaming}
              resultFor={resultFor}
            />
          );
        }
        return null;
      })}
    </>
  );
}

function ToolCallBlock({
  call,
  streaming,
  resultFor,
}: {
  call: ToolCall;
  streaming: boolean;
  resultFor: (id: string) => ToolResultMessage | undefined;
}) {
  const Card = getToolCard(call.name) as ComponentType<ToolCardProps>;
  const result = resultFor(call.id);
  const inProgress = streaming && (!result || result.content.length === 0);
  const isError = result?.isError ?? false;
  return <Card call={call} result={result} inProgress={inProgress} isError={isError} />;
}

function OrphanToolResult({ message }: { message: ToolResultMessage }) {
  const Card = getToolCard(message.toolName) as ComponentType<ToolCardProps>;
  // Synthesize the call from the result so the generic card has a name + id.
  const call: ToolCall = {
    type: 'toolCall',
    id: message.toolCallId,
    name: message.toolName,
    arguments: {},
  };
  return (
    <Card
      call={call}
      result={message}
      inProgress={false}
      isError={message.isError}
    />
  );
}

// ---------------------------------------------------------------------------
// InboundView — inbox-origin user messages (origin === 'inbox')
// Matches the mockup `.inbound` block: steel-blue left rail using --status-done,
// header "INBOX · FROM <sender>", body text, mono ref lines linkified for peek.
// ---------------------------------------------------------------------------

function InboundView({ message }: { message: UserMessage }) {
  const { onPeek, peekedPath } = usePeek();
  const raw = typeof message.content === 'string'
    ? message.content
    : (message.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('');

  const sender = extractInboxSender(raw);
  const peekablePaths = extractPeekablePaths(raw);

  // Render body text with peekable paths linkified inline via the `.filelink` atom.
  function renderBody(text: string) {
    if (peekablePaths.length === 0) {
      return <span className="whitespace-pre-wrap">{text}</span>;
    }
    // Split on peekable paths and interleave clickable spans.
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;
    for (const path of peekablePaths) {
      const idx = remaining.indexOf(path);
      if (idx === -1) continue;
      if (idx > 0) parts.push(<span key={key++} className="whitespace-pre-wrap">{remaining.slice(0, idx)}</span>);
      const isActive = peekedPath === path;
      parts.push(
        <span
          key={key++}
          onClick={(e) => { e.stopPropagation(); onPeek(path); }}
          className={['filelink text-xs', isActive && 'peeked'].filter(Boolean).join(' ')}
        >
          {path}
        </span>,
      );
      remaining = remaining.slice(idx + path.length);
    }
    if (remaining) parts.push(<span key={key++} className="whitespace-pre-wrap">{remaining}</span>);
    return <>{parts}</>;
  }

  return (
    <div className="inbound">
      <span className="ic select-none">◍</span>
      <div className="body">
        <div className="src">
          <span>inbox</span>
          {sender && (
            <>
              <span>·</span>
              <span>from {sender}</span>
            </>
          )}
        </div>
        {renderBody(raw)}
      </div>
    </div>
  );
}
