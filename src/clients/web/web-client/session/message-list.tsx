/**
 * MessageList — virtualized message history (spec C.9 / AC-10).
 *
 * Renders only visible rows via `@tanstack/react-virtual`. Sticky-bottom
 * auto-scroll yields to the user the moment they scroll up, and restores when
 * they return to the bottom. Tool results whose call exists in history are
 * filtered from the row list here (they render inside the assistant's card).
 */

import { useMemo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FoldedMessage, ToolResultMessage } from '@/shared/protocol.js';
import { MessageView } from './message-view.js';
import { useTranscriptDetail } from '../lib/transcript-detail.js';

export interface MessageListProps {
  /** The folded message history. */
  messages: FoldedMessage[];
  /** True while the engine is producing a turn. */
  streaming: boolean;
}

interface Derived {
  visible: FoldedMessage[];
  resultMap: Map<string, ToolResultMessage>;
  lastAssistant: FoldedMessage | undefined;
  /** Per-row turn label (e.g. "turn 3") for the first row of each turn, else null. */
  turnLabels: (string | null)[];
}

export function MessageList({ messages, streaming }: MessageListProps) {
  // The Detail control (con-head, S2) drives the whole transcript via this
  // global store; turn dividers go label-less in `focused`.
  const detail = useTranscriptDetail();

  // Single pass over history → row list, tool-result lookup, last-assistant ref.
  const derived = useMemo<Derived>(() => {
    const resultMap = new Map<string, ToolResultMessage>();
    const callIds = new Set<string>();
    let lastAssistant: FoldedMessage | undefined;
    for (const m of messages) {
      if (m.role === 'assistant') {
        lastAssistant = m;
        for (const b of m.content) if (b.type === 'toolCall') callIds.add(b.id);
      } else if (m.role === 'toolResult') {
        resultMap.set(m.toolCallId, m);
      }
    }
    const visible = messages.filter(
      (m) => !(m.role === 'toolResult' && callIds.has(m.toolCallId)),
    );
    // A turn starts at each live user prompt (inbox-origin messages don't open a
    // turn — they're an inbound event mid-turn). Label the opening row only.
    let turn = 0;
    const turnLabels = visible.map((m) => {
      if (m.role === 'user' && m.origin !== 'inbox') {
        turn += 1;
        return `turn ${turn}`;
      }
      return null;
    });
    return { visible, resultMap, lastAssistant, turnLabels };
  }, [messages]);

  const rows = derived.visible;
  const resultFor = (id: string): ToolResultMessage | undefined => derived.resultMap.get(id);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-bottom: true while parked at (or near) the end; false when user scrolls up.
  const stuckRef = useRef(true);
  // True while pinToBottom drives the scroll position, so onScroll doesn't
  // mistake our own scroll events for the user scrolling away.
  const pinningRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 10,
  });

  const onScroll = (): void => {
    if (pinningRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckRef.current = gap < 48;
  };

  // Drive scrollTop to the true bottom across several frames. One scroll isn't
  // enough: row heights start as estimates, and as the bottom rows render and
  // measure, scrollHeight shifts — so we re-pin until the layout settles.
  const pinToBottom = (frames = 8): void => {
    const el = scrollRef.current;
    if (!el || !stuckRef.current) {
      pinningRef.current = false;
      return;
    }
    pinningRef.current = true;
    el.scrollTop = el.scrollHeight;
    if (frames > 0) {
      requestAnimationFrame(() => pinToBottom(frames - 1));
    } else {
      requestAnimationFrame(() => {
        pinningRef.current = false;
      });
    }
  };

  // Re-pin to the bottom whenever content grows or the trailing message mutates
  // (streaming deltas replace the last message object), unless the user scrolled
  // up. Tracking rows (reference changes on any mutation) + streaming covers
  // both new-turn arrivals and in-flight delta updates. Also fires on mount,
  // so a freshly opened chat starts at the bottom.
  useEffect(() => {
    if (!stuckRef.current) return;
    if (rows.length > 0) queueMicrotask(() => pinToBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, streaming]);

  return (
    <div
      ref={scrollRef}
      className="flex flex-col flex-1 overflow-auto py-2"
      onScroll={onScroll}
    >
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const message = rows[vi.index];
            if (!message) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="px-3.5 py-1.5 box-border"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {derived.turnLabels[vi.index] && (
                  <div className="flex items-center gap-3 mt-2.5 mb-3.5">
                    {detail !== 'focused' && (
                      <span className="font-[family-name:var(--font-inst)] text-xs tracking-[0.16em] uppercase text-[var(--dim)]">
                        {derived.turnLabels[vi.index]}
                      </span>
                    )}
                    <div className="flex-1 h-px bg-[var(--line2)]" />
                  </div>
                )}
                <MessageView
                  message={message}
                  isLastAssistant={message === derived.lastAssistant}
                  streaming={streaming}
                  resultFor={resultFor}
                />
              </div>
            );
          })}
        </div>
      </div>
  );
}
