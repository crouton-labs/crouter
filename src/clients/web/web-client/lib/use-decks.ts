/**
 * Inbox deck hooks. The pending-deck list comes from `crtr human list --json`
 * through the bridge-native deck adapter; it re-fetches on SSE inbox/node
 * invalidations and on demand. The badge count is derived straight from the
 * canvas snapshot, so it updates instantly with zero extra round-trips (design
 * §4.1 badge, §5.2 list). Polling fallback is inherited from the canvas store.
 */

import { useEffect, useState, useCallback } from 'react';
import type { DeckSummary, NodeSummary } from '@/shared/protocol.js';
import { getDecks } from './decks.js';
import { useCanvasStore } from './use-canvas-store.js';
import { useSseRefresh } from '../sse.js';

/** Total pending asks across the canvas (deduped by cwd at the source). */
export function totalAttention(nodes: NodeSummary[]): number {
  let sum = 0;
  for (const n of nodes) sum += Math.max(0, n.attention_count);
  return sum;
}

/** The inbox badge count, derived live from the canvas snapshot. */
export function useInboxCount(): number {
  const { nodes } = useCanvasStore();
  return totalAttention(nodes);
}

export interface DecksStore {
  decks: DeckSummary[];
  /** True until the first fetch resolves. */
  loading: boolean;
  refetch: () => void;
}

/** Self-managing pending-deck list. Refetches on SSE invalidations and on
 *  demand. */
export function useDecks(): DecksStore {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useSseRefresh(['inbox', 'nodes'], refetch);

  useEffect(() => {
    let disposed = false;
    getDecks()
      .then((d) => {
        if (!disposed) {
          setDecks(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
    // Re-fetch on SSE inbox/node invalidations and on explicit refetch
    // (e.g. after resolving a deck).
  }, [nonce]);

  return { decks, loading, refetch };
}

/** Pending decks belonging to one conversation (its spine root id) — for the
 *  inline ask card in the conversation view (design §4.3/§5.1). */
export function useConversationDecks(conversationId: string): DeckSummary[] {
  const { decks } = useDecks();
  return decks.filter((d) => d.conversation_id === conversationId);
}
