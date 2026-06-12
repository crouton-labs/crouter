// Sidebar.tsx — the always-live canvas navigator (design §3). The canvas view,
// hosted as a ViewHost, IS the navigator: it polls the node graph + attention and
// renders the live tree. Its `activate {nodeId}` intent is tapped (design §5) and
// raised to the shell, which opens that node's ConversationPane. A [+ spawn] button
// opens the SpawnModal. SSE 'nodes' invalidations refresh the tree event-driven.

import { useState, type JSX } from 'react';
import type { IntentTap } from '@crouton-kit/crouter/web';
import { ViewHost } from './ViewHost.js';
import { SpawnModal } from './SpawnModal.js';

export function Sidebar({
  width,
  onActivateNode,
}: {
  width: number;
  onActivateNode: (nodeId: string) => void;
}): JSX.Element {
  const [spawning, setSpawning] = useState(false);

  const onIntent: IntentTap = (name, payload) => {
    if (name === 'activate') {
      const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
      if (typeof nodeId === 'string' && nodeId !== '') onActivateNode(nodeId);
    }
  };

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-slate-200 bg-slate-50"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-sm font-semibold text-slate-800">crouter</span>
        <button
          onClick={() => setSpawning(true)}
          className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
          title="spawn a node"
        >
          + spawn
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ViewHost viewId="canvas" onIntent={onIntent} sseKinds={['nodes']} />
      </div>
      {spawning && <SpawnModal onClose={() => setSpawning(false)} />}
    </aside>
  );
}
