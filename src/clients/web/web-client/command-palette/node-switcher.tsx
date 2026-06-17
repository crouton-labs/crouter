/**
 * Global quick-switcher (design R3) — Cmd/Ctrl+K opens a minimal overlay that
 * lists live/recent enterable nodes by their derived title (R5) + state, filters
 * as you type, and jumps with ↑/↓ + Enter (Esc closes). This is a *node*
 * switcher, not the node-local slash palette: switching between conversations is
 * the front door, so it lives app-wide in the shell. Dev-brained and chromeless;
 * styling leans on the QI atoms (.panel/.dot/.instlabel).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCanvasStore } from '../lib/use-canvas-store.js';
import { deriveNodeTitle } from '../lib/conversations.js';
import type { NodeSummary } from '@/shared/protocol.js';
import { cn } from '@/lib/utils.js';

/** The .dot variant for a node row: a pending ask reads blocked, else status. */
function nodeDotVariant(n: NodeSummary): string {
  if (n.attention_count > 0) return 'blocked';
  return n.status;
}

interface SwitcherItem {
  id: string;
  title: string;
  dot: string;
  kind: string;
  last: string;
}

export function NodeSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { nodes } = useCanvasStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<SwitcherItem[]>(() => {
    const rows: SwitcherItem[] = nodes
      .filter((n) => n.enterable)
      .map((n) => ({
        id: n.node_id,
        title: deriveNodeTitle(n),
        dot: nodeDotVariant(n),
        kind: n.kind,
        last: n.last_activity ?? n.created,
      }));
    // Most-recent first (ISO compares lexically).
    rows.sort((a, b) => b.last.localeCompare(a.last));
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.title.toLowerCase().includes(q) || r.kind.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  // Reset + focus on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSel(0);
    inputRef.current?.focus();
  }, [open]);

  // Keep the selection in range as the filter narrows.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  const jump = (item: SwitcherItem | undefined): void => {
    if (!item) return;
    navigate(`/c/${encodeURIComponent(item.id)}`);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      jump(items[sel]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24"
      style={{ background: 'var(--scrim)' }}
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-xl overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <span className="instlabel" style={{ color: 'var(--dim)' }}>Jump to</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search conversations…"
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--ink)' }}
          />
          <span className="kbd">esc</span>
        </div>
        <ul className="max-h-80 overflow-auto py-1">
          {items.length === 0 ? (
            <li className="px-4 py-3 text-sm italic" style={{ color: 'var(--mut)' }}>
              no live nodes
            </li>
          ) : (
            items.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => jump(item)}
                  onMouseEnter={() => setSel(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                    i === sel && 'bg-[color-mix(in_oklch,var(--ink)_6%,transparent)]',
                  )}
                >
                  <span className={cn('dot shrink-0', item.dot)} />
                  <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--ink)' }}>
                    {item.title}
                  </span>
                  <span
                    className="shrink-0 text-xs"
                    style={{ fontFamily: 'var(--font-inst)', letterSpacing: '0.04em', color: 'var(--mut)' }}
                  >
                    {item.kind}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
