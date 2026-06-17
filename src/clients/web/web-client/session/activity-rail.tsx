/**
 * ActivityRail (design §4.3, §5.1) — the consumer view of a conversation's
 * sub-DAG. Studio never shows the child graph or node ids; the work the root's
 * children do surfaces here as plain-language activity, collapsed by default
 * with a badge when something is running. Gated by `subnodes.activity` (Studio
 * grants it; Operator shows the canvas graph instead), so this never branches on
 * profile name.
 *
 * Data source + limitation: synthesized from the canvas snapshot — each
 * descendant's name + lifecycle status. The snapshot exposes no per-node `push`
 * summary text, so a strand's line is "<name> — working/finished/idle" derived
 * from status, not the agent's own summary. If the snapshot grows summary text
 * later, the line upgrades for free; we deliberately do not block on a server
 * change.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { NodeLifeStatus, NodeSummary } from '@/shared/protocol.js';
import { useCanvasStore } from '../lib/use-canvas-store.js';
import { descendantsOf } from '../lib/conversations.js';
import { cn } from '@/lib/utils.js';

/** Status → plain-language verb for one strand. */
function strandPhrase(status: NodeLifeStatus): string {
  switch (status) {
    case 'active':
      return 'working';
    case 'idle':
      return 'waiting';
    case 'done':
      return 'finished';
    case 'dead':
    case 'canceled':
      return 'stopped';
  }
}

function strandRank(n: NodeSummary): number {
  if (n.attention_count > 0) return 0;
  if (n.status === 'active') return 1;
  if (n.status === 'idle') return 2;
  return 3;
}

export function ActivityRail({ rootId }: { rootId: string }) {
  const { nodes } = useCanvasStore();
  const [open, setOpen] = useState(false);

  const strands = useMemo(() => {
    const kids = descendantsOf(nodes, rootId);
    return [...kids].sort((a, b) => strandRank(a) - strandRank(b));
  }, [nodes, rootId]);

  const activeCount = strands.filter((s) => s.status === 'active').length;

  // Nothing has fanned out yet — keep the rail quiet (no empty disclosure).
  if (strands.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border bg-card/40 px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="font-medium text-foreground">Activity</span>
        {activeCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            {activeCount} working
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/70">Idle</span>
        )}
      </button>

      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 pl-6">
          {strands.map((s) => (
            <li key={s.node_id} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  s.status === 'active' ? 'animate-pulse bg-success' : 'bg-muted-foreground/40',
                )}
              />
              <span className="truncate text-foreground/80">{s.name}</span>
              <span className="text-xs text-muted-foreground/70">— {strandPhrase(s.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
