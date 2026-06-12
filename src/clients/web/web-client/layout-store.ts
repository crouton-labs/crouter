// layout-store.ts — the shell's ephemeral UI layout (design §3). Which panes are
// open + which is focused is a browser-side view-arrangement preference, NOT
// durable graph state — so it lives in localStorage, never on the server. Durable
// graph state (what nodes exist) is read live via the canvas Source; a pane that
// references a vanished node renders a "gone" empty state, it is not pruned here.

export type PaneRef =
  | { kind: 'view'; viewId: string }
  | { kind: 'conversation'; nodeId: string };

export interface Layout {
  openPanes: PaneRef[];
  activePaneId: string | null;
  sidebarWidth: number;
}

/** Stable tab id for a pane (one view / one node ⇒ one tab; opening it again
 *  focuses the existing tab rather than duplicating it). */
export function paneId(p: PaneRef): string {
  return p.kind === 'view' ? `view:${p.viewId}` : `conv:${p.nodeId}`;
}

const KEY = 'crtr.web.layout.v1';
const DEFAULT: Layout = { openPanes: [{ kind: 'view', viewId: 'canvas' }], activePaneId: 'view:canvas', sidebarWidth: 300 };

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<Layout>;
    if (!Array.isArray(parsed.openPanes)) return { ...DEFAULT };
    return {
      openPanes: parsed.openPanes,
      activePaneId: parsed.activePaneId ?? (parsed.openPanes[0] ? paneId(parsed.openPanes[0]) : null),
      sidebarWidth: typeof parsed.sidebarWidth === 'number' ? parsed.sidebarWidth : DEFAULT.sidebarWidth,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage full / disabled — layout is best-effort, never fatal */
  }
}

/** Open a pane (or focus it if already open). Returns a new Layout. */
export function openPane(layout: Layout, ref: PaneRef): Layout {
  const id = paneId(ref);
  const exists = layout.openPanes.some((p) => paneId(p) === id);
  return {
    ...layout,
    openPanes: exists ? layout.openPanes : [...layout.openPanes, ref],
    activePaneId: id,
  };
}

/** Close a pane by id, re-focusing a neighbour if the closed one was active. */
export function closePane(layout: Layout, id: string): Layout {
  const idx = layout.openPanes.findIndex((p) => paneId(p) === id);
  if (idx === -1) return layout;
  const openPanes = layout.openPanes.filter((p) => paneId(p) !== id);
  let activePaneId = layout.activePaneId;
  if (activePaneId === id) {
    const neighbour = openPanes[idx] ?? openPanes[idx - 1] ?? openPanes[0] ?? null;
    activePaneId = neighbour ? paneId(neighbour) : null;
  }
  return { ...layout, openPanes, activePaneId };
}

/** Parse the boot URL into an initial-focus pane ref (design §3): /node/<id> →
 *  a conversation, /view/<id> → a view. Returns null for `/` (restore persisted). */
export function paneFromUrl(pathname: string): PaneRef | null {
  const node = /^\/node\/([^/?#]+)/.exec(pathname);
  if (node) {
    try {
      return { kind: 'conversation', nodeId: decodeURIComponent(node[1]!) };
    } catch {
      return null;
    }
  }
  const view = /^\/view\/([^/?#]+)/.exec(pathname);
  if (view) {
    try {
      return { kind: 'view', viewId: decodeURIComponent(view[1]!) };
    } catch {
      return null;
    }
  }
  return null;
}
