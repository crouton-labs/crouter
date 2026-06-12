// sse.ts — the shell's realtime invalidation lane (design §7). ONE same-origin
// EventSource on /__crtr/events carries change INVALIDATIONS ({kind:'nodes'|'inbox'}),
// never data. A pane subscribes its refresh() for the kinds it cares about; on an
// event the shell calls those refreshes, which re-pull through the existing Sources
// (the bridge). Invalidation-only — data still flows through Sources, the view
// contract is unchanged (a ViewPane still just runs its `refresh` intent).

import { useEffect, useRef } from 'react';

export type ChangeKind = 'nodes' | 'inbox';

interface Sub {
  kinds: readonly ChangeKind[];
  refresh: () => void;
}

const subs = new Set<Sub>();
let started = false;

/** Open the single EventSource lazily (first subscriber) and fan its events out
 *  to matching subscribers. Lives for the page lifetime — same-origin, so the
 *  server's M1 origin gate admits it. */
function ensureStream(): void {
  if (started) return;
  started = true;
  let es: EventSource;
  try {
    es = new EventSource('/__crtr/events');
  } catch {
    started = false; // EventSource unavailable — panes fall back to poll cadence
    return;
  }
  es.onmessage = (ev: MessageEvent<string>) => {
    let kind: ChangeKind | undefined;
    try {
      kind = (JSON.parse(ev.data) as { kind?: ChangeKind }).kind;
    } catch {
      return;
    }
    if (kind === undefined) return;
    for (const sub of subs) if (sub.kinds.includes(kind)) sub.refresh();
  };
  // On error the browser EventSource auto-reconnects; nothing to do here.
}

/** Subscribe a pane's refresh() to SSE invalidations of the given kinds. The
 *  refresh closure is kept fresh via a ref so re-renders don't re-register. */
export function useSseRefresh(kinds: readonly ChangeKind[], refresh: () => void): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const key = kinds.join(',');
  useEffect(() => {
    ensureStream();
    const sub: Sub = { kinds, refresh: () => refreshRef.current() };
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
