/**
 * Graph rail (design contract §1) — left sidebar that is really two things:
 * the current node's subtree ("THIS GRAPH") and a project/graph switcher
 * ("ELSEWHERE"). Gated on `node.graphRail`. Alt+ArrowUp/Down cycles the
 * current graph's nodes (chord surfaced in the section-header tooltip).
 *
 * IA rebuild (§1): both sections port the canvas `.node-row` two-line pattern
 * with a 2px status spine. THIS GRAPH leads with the node name + kind and
 * spends line 2 on liveness (status + age). ELSEWHERE LEADS WITH THE PROJECT
 * (cwd basename) — the field that actually differs across ~30 "general" roots —
 * sorts live-first, and demotes finished graphs behind a `Show N finished`
 * disclosure. No field renders below 12px.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Flag, ChevronRight, Keyboard } from 'lucide-react';
import { useCapability } from '../profile/provider.js';
import { useCanvasStore } from '../lib/use-canvas-store.js';
import { buildGraphTree } from '../lib/graph.js';
import { Badge } from '@/components/ui/badge.js';
import { cn } from '@/lib/utils.js';
import type { NodeSummary } from '@/shared/protocol.js';

interface Props {
  currentId: string;
  onNavigate: (id: string) => void;
}

const FINISHED = new Set(['done', 'dead', 'canceled']);

export function GraphRail({ currentId, onNavigate }: Props): ReactNode {
  const canRender = useCapability('node.graphRail');
  const { nodes } = useCanvasStore();
  const [showFinished, setShowFinished] = useState(false);

  const { thisGraph } = buildGraphTree(nodes, currentId);
  const currentRootId = thisGraph[0]?.node.node_id ?? null;

  // ELSEWHERE = roots of every OTHER broker graph (including finished ones, so
  // we can demote rather than drop them). Derived here — not via buildGraphTree,
  // which filters finished roots out — so the §1b live-first/collapse move works.
  const { liveRoots, deadRoots } = useMemo(() => {
    const roots = nodes.filter(
      (n) => n.parent === null && n.host_kind === 'broker' && n.node_id !== currentRootId,
    );
    const live: NodeSummary[] = [];
    const dead: NodeSummary[] = [];
    for (const n of roots) (FINISHED.has(n.status) && n.attention_count === 0 ? dead : live).push(n);
    const recency = (a: NodeSummary, b: NodeSummary): number =>
      Date.parse(b.created) - Date.parse(a.created);
    // Blocked, then active, then the rest — each bucket by recency.
    const rank = (n: NodeSummary): number =>
      n.attention_count > 0 ? 0 : n.status === 'active' ? 1 : 2;
    live.sort((a, b) => rank(a) - rank(b) || recency(a, b));
    dead.sort(recency);
    return { liveRoots: live, deadRoots: dead };
  }, [nodes, currentRootId]);

  // Alt+ArrowUp/Down: navigate thisGraph order
  useEffect(() => {
    if (!canRender) return;
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      const idx = thisGraph.findIndex((g) => g.node.node_id === currentId);
      if (idx === -1) return;
      e.preventDefault();
      const next = e.key === 'ArrowUp' ? thisGraph[idx - 1] : thisGraph[idx + 1];
      if (next) onNavigate(next.node.node_id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canRender, thisGraph, currentId, onNavigate]);

  if (!canRender) return null;

  return (
    <aside className="graphrail rv" style={GRAPHRAIL}>
      <SectionHeader label="This graph" chord="⌥↑↓ to cycle" />
      {thisGraph.map(({ node, depth }) => (
        <NodeRow
          key={node.node_id}
          node={node}
          depth={depth}
          current={node.node_id === currentId}
          onClick={() => onNavigate(node.node_id)}
        />
      ))}
      {thisGraph.length === 0 && <EmptyRow />}

      {(liveRoots.length > 0 || deadRoots.length > 0) && (
        <>
          <div className="gr-gap" />
          <SectionHeader label="Elsewhere" />
          {liveRoots.map((n) => (
            <NodeRow
              key={n.node_id}
              node={n}
              depth={0}
              current={false}
              elsewhere
              onClick={() => onNavigate(n.node_id)}
            />
          ))}
          {deadRoots.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowFinished((v) => !v)}
                className="mt-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs text-[var(--dim)] transition-colors hover:text-[var(--ink2)]"
              >
                <ChevronRight
                  className={cn('size-3.5 transition-transform', showFinished && 'rotate-90')}
                />
                {showFinished ? 'Hide' : 'Show'} {deadRoots.length} finished
              </button>
              {showFinished &&
                deadRoots.map((n) => (
                  <NodeRow
                    key={n.node_id}
                    node={n}
                    depth={0}
                    current={false}
                    elsewhere
                    onClick={() => onNavigate(n.node_id)}
                  />
                ))}
            </>
          )}
        </>
      )}
    </aside>
  );
}

// `.graphrail` carries no CSS — the column geometry lives here (mockup: 228px,
// right rule, faint inset background).
const GRAPHRAIL = {
  width: '228px',
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid var(--line)',
  background: 'rgba(0,0,0,.16)',
  padding: '14px 9px',
  overflowY: 'auto',
  zIndex: 1,
  ['--i' as string]: 2,
} as const;

function SectionHeader({ label, chord }: { label: string; chord?: string }): ReactNode {
  return (
    <div className="gr-sec">
      <span className="instlabel">{label}</span>
      <div className="rule" />
      {chord && (
        <span title={chord} aria-label={chord} className="flex items-center text-[var(--dim)]">
          <Keyboard className="size-3.5" />
        </span>
      )}
    </div>
  );
}

function EmptyRow(): ReactNode {
  return (
    <span className="px-3 py-1 font-mono text-xs" style={{ color: 'var(--dim)' }}>
      —
    </span>
  );
}

const STATUS_HUE: Record<string, string> = {
  active: 'var(--status-active)',
  idle: 'var(--status-idle)',
  done: 'var(--status-done)',
  dead: 'var(--status-dead)',
  canceled: 'var(--status-canceled)',
  blocked: 'var(--blk)',
};

/** Coarse human age from an ISO timestamp (e.g. `4m`, `2h`, `3d`). */
function relAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Last non-empty path segment — the project identity for ELSEWHERE rows. */
function basename(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd;
}

/**
 * Abbreviate a cwd to ~/… or …/last-two — a local copy of meta-strip's helper
 * (that file is another surface's and must not be edited for an export).
 */
function abbreviateCwd(cwd: string): string {
  const home = cwd.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/);
  if (home) return `~${home[1]}`;
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

const SPINE_CLASS: Record<string, string> = {
  active: 's-active',
  idle: 's-idle',
  done: 's-done',
  dead: 's-dead',
  canceled: 's-canceled',
};

function NodeRow({
  node,
  depth,
  current,
  elsewhere = false,
  onClick,
}: {
  node: NodeSummary;
  depth: number;
  current: boolean;
  elsewhere?: boolean;
  onClick: () => void;
}): ReactNode {
  const isDead = FINISHED.has(node.status);
  const blocked = node.attention_count > 0;
  const statusKey = blocked ? 'blocked' : node.status;
  const hue = STATUS_HUE[statusKey] ?? 'var(--status-dead)';
  const age = relAge(node.created);
  // THIS GRAPH shares the root cwd, so spend line 2 on liveness; ELSEWHERE
  // leads with the project basename and keeps the cwd-tail for disambiguation.
  const indent = depth > 0 ? { marginLeft: `${depth * 12}px` } : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      style={indent}
      className={cn(
        'node-row w-full text-left',
        blocked ? 's-blocked' : SPINE_CLASS[node.status],
        isDead && !blocked && 'dimmed',
        current &&
          'rounded-md border border-[var(--line2)] bg-[oklch(0.92_0.013_80_/_8%)] shadow-[inset_0_1px_0_var(--raise)]',
      )}
    >
      <span className="node-id">
        <span className="node-l1">
          <span className={cn('node-name truncate', current && 'font-semibold')}>
            {elsewhere ? basename(node.cwd) : node.name}
          </span>
          {elsewhere ? (
            <span className="node-kind truncate">
              {node.name} · {node.kind}
            </span>
          ) : (
            <span className="node-kind">{node.kind}</span>
          )}
          {blocked && (
            <Badge variant="destructive" className="ml-auto gap-1 text-xs">
              <Flag className="size-3.5" />
              {node.attention_count}
            </Badge>
          )}
        </span>
        <span className="node-l2">
          {elsewhere && <span className="node-cwd">{abbreviateCwd(node.cwd)}</span>}
          <span
            className="font-[family-name:var(--font-inst)] uppercase tracking-[0.12em]"
            style={{ color: hue }}
          >
            {blocked ? 'blocked' : node.status}
          </span>
          {age && <span className="text-[var(--dim)]">{age}</span>}
        </span>
      </span>
    </button>
  );
}
