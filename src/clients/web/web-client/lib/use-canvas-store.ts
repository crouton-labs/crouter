/**
 * Canvas snapshot store. Reads the browser roster from the in-tree bridge and
 * refreshes on SSE invalidations (`nodes`/`inbox`) instead of a standalone WS.
 */

import { useCallback, useEffect, useState } from 'react';
import type { NodeSummary } from '@/shared/protocol.js';
import { getCanvas } from '../net/rest-compat.js';
import { useSseRefresh } from '../sse.js';
import { useServerStatus } from './server-status.js';

const POLL_INTERVAL_MS = 30_000;

export interface CanvasStore {
  nodes: NodeSummary[];
  generatedAt: string | null;
  loading: boolean;
}

export function useCanvasStore(): CanvasStore {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useSseRefresh(['nodes', 'inbox'], refetch);

  useEffect(() => {
    let disposed = false;

    const apply = (snap: Awaited<ReturnType<typeof getCanvas>>): void => {
      if (disposed) return;
      setNodes(snap.nodes);
      setGeneratedAt(snap.generated_at);
      setLoading(false);
      useServerStatus.getState().setReachable(true);
    };

    const load = async (): Promise<void> => {
      try {
        apply(await getCanvas());
      } catch {
        if (!disposed) {
          setLoading(false);
          useServerStatus.getState().setReachable(false);
        }
      }
    };

    void load();
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [nonce]);

  return { nodes, generatedAt, loading };
}
