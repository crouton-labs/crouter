import { useEffect, useState, useCallback } from 'react';
import { listViews, type ViewSummary } from '../command-client.js';
import { VIEW_REGISTRY } from '../view-registry.js';

const POLL_MS = 30_000;

export interface ViewsStore {
  views: ViewSummary[];
  loading: boolean;
  refetch: () => void;
}

function builtinViews(): ViewSummary[] {
  return Object.values(VIEW_REGISTRY).map((entry) => ({
    id: entry.core.manifest.id,
    title: entry.core.manifest.title,
    description: entry.core.manifest.description,
  }));
}

export function useViews(): ViewsStore {
  const [views, setViews] = useState<ViewSummary[]>(builtinViews());
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let disposed = false;

    const fetch = (): void => {
      listViews()
        .then((items) => {
          if (disposed) return;
          setViews(items.length > 0 ? items : builtinViews());
          setLoading(false);
        })
        .catch(() => {
          if (disposed) return;
          setViews(builtinViews());
          setLoading(false);
        });
    };

    fetch();

    const interval = setInterval(fetch, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') fetch();
    };

    window.addEventListener('focus', fetch);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener('focus', fetch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [nonce]);

  return { views, loading, refetch };
}
