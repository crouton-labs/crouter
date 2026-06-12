// Shell.tsx — the crouter web shell (design §3): a sidebar canvas navigator beside
// a tabbed main area. v1 is single-focus tabs (fork B), not a window manager. Two
// pane primitives compose here: a ViewHost (any builtin view) and a ConversationPane
// (a node's live broker). Clicking a node row in the sidebar canvas raises `activate`
// (the §5 intent tap) → opens that node's conversation tab; [Wake] on a dormant node
// routes through the bridge command path (§6). Layout is browser-side localStorage.

import { useEffect, useRef, useState, type JSX } from 'react';
import type { IntentTap } from '@crouton-kit/crouter/web';
import { ConversationPane } from './ConversationPane.js';
import { ViewHost } from './ViewHost.js';
import { Sidebar } from './Sidebar.js';
import { reviveNode } from './command-client.js';
import { OPENABLE_VIEW_IDS, viewTitle } from './view-registry.js';
import {
  closePane,
  loadLayout,
  openPane,
  paneFromUrl,
  paneId,
  saveLayout,
  type Layout,
  type PaneRef,
} from './layout-store.js';

export function Shell(): JSX.Element {
  const [layout, setLayout] = useState<Layout>(() => {
    const base = loadLayout();
    const urlPane = paneFromUrl(window.location.pathname);
    return urlPane ? openPane(base, urlPane) : base;
  });

  useEffect(() => saveLayout(layout), [layout]);

  const open = (ref: PaneRef): void => setLayout((l) => openPane(l, ref));
  const openConversation = (nodeId: string): void => open({ kind: 'conversation', nodeId });
  const openView = (viewId: string): void => open({ kind: 'view', viewId });
  const focus = (id: string): void => setLayout((l) => ({ ...l, activePaneId: id }));
  const close = (id: string): void => setLayout((l) => closePane(l, id));

  const onWake = async (nodeId: string): Promise<void> => {
    await reviveNode(nodeId);
  };

  // The shell intent vocabulary (design §5), tapped on every hosted view pane:
  // `activate {nodeId}` opens that node's conversation, `open {viewId}` opens a
  // view. So clicking a node row in ANY canvas pane (sidebar or main) navigates.
  const onViewIntent: IntentTap = (name, payload) => {
    if (name === 'activate') {
      const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
      if (typeof nodeId === 'string' && nodeId !== '') openConversation(nodeId);
    } else if (name === 'open') {
      const viewId = (payload as { viewId?: string } | undefined)?.viewId;
      if (typeof viewId === 'string' && viewId !== '') openView(viewId);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-slate-900">
      <Sidebar width={layout.sidebarWidth} onActivateNode={openConversation} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar layout={layout} onFocus={focus} onClose={close} onOpenView={openView} />
        <div className="relative min-h-0 flex-1">
          {layout.openPanes.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              Click a node in the sidebar to open its conversation.
            </div>
          )}
          {layout.openPanes.map((p) => {
            const id = paneId(p);
            const active = id === layout.activePaneId;
            // All panes stay MOUNTED (hidden when inactive) so conversation WS
            // streams stay live and views keep polling across tab switches.
            return (
              <div
                key={id}
                className={`absolute inset-0 ${active ? '' : 'hidden'} ${
                  p.kind === 'view' ? 'overflow-auto' : 'overflow-hidden'
                }`}
              >
                {p.kind === 'view' ? (
                  <ViewHost
                    viewId={p.viewId}
                    onIntent={onViewIntent}
                    sseKinds={p.viewId === 'inbox' ? ['inbox', 'nodes'] : ['nodes']}
                  />
                ) : (
                  <ConversationPane nodeId={p.nodeId} onWake={onWake} />
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function TabBar({
  layout,
  onFocus,
  onClose,
  onOpenView,
}: {
  layout: Layout;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onOpenView: (viewId: string) => void;
}): JSX.Element {
  return (
    <div className="flex items-stretch border-b border-slate-200 bg-slate-50">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {layout.openPanes.map((p) => {
          const id = paneId(p);
          const active = id === layout.activePaneId;
          return (
            <Tab key={id} active={active} onClick={() => onFocus(id)} onClose={() => onClose(id)}>
              {p.kind === 'view' ? (
                viewTitle(p.viewId)
              ) : (
                <>
                  <span className="text-sky-500">▸</span> {shortNode(p.nodeId)}
                </>
              )}
            </Tab>
          );
        })}
      </div>
      <ViewMenu onOpenView={onOpenView} />
    </div>
  );
}

function Tab({
  active,
  onClick,
  onClose,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      className={`group flex shrink-0 cursor-pointer items-center gap-2 border-r border-slate-200 px-3 py-2 text-sm ${
        active ? 'bg-white font-medium text-slate-900' : 'text-slate-500 hover:bg-white/60'
      }`}
    >
      <span className="max-w-[14rem] truncate">{children}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="rounded text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100"
        aria-label="close tab"
      >
        ✕
      </button>
    </div>
  );
}

function ViewMenu({ onOpenView }: { onOpenView: (viewId: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center border-l border-slate-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-2 text-sm text-slate-500 hover:bg-white hover:text-slate-800"
        title="open a view"
      >
        + view
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-px w-44 rounded-b border border-slate-200 bg-white shadow-lg">
          {OPENABLE_VIEW_IDS.map((id) => (
            <button
              key={id}
              onClick={() => {
                onOpenView(id);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {viewTitle(id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function shortNode(nodeId: string): string {
  return nodeId.length > 10 ? `${nodeId.slice(0, 8)}…` : nodeId;
}
