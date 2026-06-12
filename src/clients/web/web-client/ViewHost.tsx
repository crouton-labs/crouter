// ViewHost.tsx — the shell's wrapper for hosting a builtin view as a pane. Built
// from the exported primitives (useViewCore + ViewChrome from
// @crouton-kit/crouter/web), it adds the two shell concerns the bare <ViewPane>
// doesn't expose: the onIntent TAP (design §5 — observe `activate`/`open` to drive
// the shell) and SSE-invalidation refresh (design §7 — re-pull on a canvas/inbox
// change instead of only on the poll tick).

import { createElement, type JSX } from 'react';
import { useViewCore, ViewChrome } from '@crouton-kit/crouter/web';
import type { IntentTap } from '@crouton-kit/crouter/web';
import { VIEW_REGISTRY, type ViewEntry } from './view-registry.js';
import { useSseRefresh, type ChangeKind } from './sse.js';

export function ViewHost({
  viewId,
  onIntent,
  sseKinds = [],
}: {
  viewId: string;
  onIntent?: IntentTap;
  sseKinds?: readonly ChangeKind[];
}): JSX.Element {
  const entry = VIEW_REGISTRY[viewId];
  if (entry === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-slate-500">
        Unknown view: <code className="ml-1 rounded bg-slate-100 px-1.5 py-0.5">{viewId}</code>
      </div>
    );
  }
  // Key by viewId so switching the hosted view remounts the store (no stale state).
  return <ViewHostInner key={viewId} entry={entry} onIntent={onIntent} sseKinds={sseKinds} />;
}

function ViewHostInner({
  entry,
  onIntent,
  sseKinds,
}: {
  entry: ViewEntry;
  onIntent?: IntentTap;
  sseKinds: readonly ChangeKind[];
}): JSX.Element {
  const { state, chrome, dispatch, refresh } = useViewCore(entry.core, { onIntent });
  useSseRefresh(sseKinds, refresh);
  return (
    <ViewChrome chrome={chrome} title={entry.core.manifest.title}>
      {createElement(entry.View, { state, dispatch, chrome })}
    </ViewChrome>
  );
}
