// app.ts — the interactive `crtr canvas browse` runtime.
//
// Owns the browser state + the stdin keystroke loop. Pure logic lives in
// model.ts (buildTree/flatten/fuzzyMatch) and render.ts (renderFrame); this file
// wires the canvas data access in, holds mutable state, and translates keys.
//
// Resume is one action: Enter routes the chosen node through `crtr node focus`,
// which goes via reviveNode() — the ONLY sanctioned open. NEVER spawn
// `pi --session` directly (see canvas-resume.ts header for the desync hazard).

import { execFileSync } from 'node:child_process';

import { dashboardRowsAll, renderForest } from '../render.js';
import { listNodes, subscriptionsOf } from '../canvas.js';
import {
  setupTerminal,
  restoreTerminal,
  getTerminalSize,
  parseKeypress,
  type Key,
} from './terminal.js';
import { buildTree, flatten, TABS, type Tab, type Tree, type VisibleRow } from './model.js';
import { renderFrame, detectColorCaps, type ColorCaps } from './render.js';

interface BrowseState {
  tab: Tab;
  cursor: number; // index into the visible-rows array
  collapsed: Set<string>;
  query: string;
  search: boolean;
  scrollOffset: number;
}

/** Header lines renderFrame draws above the body — title + tabs + [search/filter
 *  line] + separator. A committed (non-search) query keeps its own indicator
 *  line, so scroll math must count it too. Must match render.ts's layout. */
function headerLines(search: boolean, hasQuery: boolean): number {
  return 2 + (search || hasQuery ? 1 : 0) + 1;
}

function viewportHeight(rowsTotal: number, search: boolean, hasQuery: boolean): number {
  const rows = Math.max(8, rowsTotal);
  return Math.max(1, rows - headerLines(search, hasQuery) - 1 /* footer */);
}

export async function runBrowse(opts: { returnPane?: string } = {}): Promise<void> {
  // No TTY → print the static forest and exit 0 (no raw mode).
  if (!process.stdin.isTTY) {
    process.stdout.write(renderForest() + '\n');
    return;
  }

  // Snapshot the canvas. Drop kind:'human' control-plane decks — they have no pi
  // session, so `node focus` refuses them; they are never a navigation/resume
  // target (mirrors canvas-resume.ts / the node focus guard).
  const rows = dashboardRowsAll().filter((r) => r.kind !== 'human');
  const rootIds = listNodes()
    .filter((n) => n.parent === null && n.kind !== 'human')
    .map((n) => n.node_id);
  const tree: Tree = buildTree(rows, rootIds, (id) => subscriptionsOf(id).map((s) => s.node_id));
  const totalNodes = tree.nodes.size;

  const state: BrowseState = {
    tab: 'All',
    cursor: 0,
    // Initial collapse = every node with children → only roots/top-level show.
    collapsed: new Set<string>(
      [...tree.nodes.entries()].filter(([, n]) => n.childIds.length > 0).map(([id]) => id),
    ),
    query: '',
    search: false,
    scrollOffset: 0,
  };

  let visible: VisibleRow[] = [];

  // Color capability is fixed for the session (it's a property of the tty/env).
  const caps: ColorCaps = detectColorCaps();

  // Restore the terminal exactly once, however we leave (quit, resume, crash).
  let restored = false;
  const cleanup = (): void => {
    if (restored) return;
    restored = true;
    try { restoreTerminal(); } catch { /* best-effort */ }
  };
  // Safety net: an uncaught throw in the (un-unit-tested) keystroke path must
  // never strand the tty in raw + alt-screen + hidden-cursor.
  process.once('exit', cleanup);

  /** Open the chosen node — the ONLY sanctioned path (reviveNode via node focus). */
  const selectAndFocus = (id: string): never => {
    cleanup();
    const args = ['node', 'focus', id, ...(opts.returnPane !== undefined && opts.returnPane !== '' ? ['--pane', opts.returnPane] : [])];
    try {
      execFileSync('crtr', args, { stdio: 'inherit' });
    } catch {
      // `node focus` swaps panes out from under us; a sync call can be
      // interrupted. Best-effort — the swap is what matters.
    }
    process.exit(0);
  };

  const recompute = (keepId?: string): void => {
    visible = flatten(tree, { collapsed: state.collapsed, tab: state.tab, query: state.query });
    if (keepId !== undefined) {
      const idx = visible.findIndex((v) => v.id === keepId);
      if (idx >= 0) state.cursor = idx;
    }
    if (state.cursor > visible.length - 1) state.cursor = Math.max(0, visible.length - 1);
    if (state.cursor < 0) state.cursor = 0;
  };

  const flush = (): void => {
    const size = getTerminalSize();
    const viewport = viewportHeight(size.rows, state.search, state.query !== '');
    // Keep the cursor inside the viewport window.
    if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;
    if (state.cursor >= state.scrollOffset + viewport) state.scrollOffset = state.cursor - viewport + 1;
    if (state.scrollOffset < 0) state.scrollOffset = 0;
    const frame = renderFrame(
      { tree, visible, tab: state.tab, cursor: state.cursor, scrollOffset: state.scrollOffset, query: state.query, search: state.search, totalNodes },
      size,
      caps,
    );
    process.stdout.write(frame);
  };

  const quit = (): never => {
    cleanup();
    process.exit(0);
  };

  const curRow = (): VisibleRow | undefined => visible[state.cursor];
  const isExpanded = (id: string): boolean => !state.collapsed.has(id);

  const cycleTab = (dir: 1 | -1): void => {
    const i = TABS.indexOf(state.tab);
    state.tab = TABS[(i + dir + TABS.length) % TABS.length]!;
    state.cursor = 0;
    state.scrollOffset = 0;
    recompute();
  };

  const onKeySearch = (input: string, key: Key): void => {
    if (key.escape) {
      state.search = false;
      state.query = '';
      recompute();
      flush();
      return;
    }
    if (key.return) {
      // Commit: keep the filter, drop search mode, land on the first match.
      state.search = false;
      const firstMatch = visible.findIndex((v) => v.matched);
      if (firstMatch >= 0) state.cursor = firstMatch;
      recompute();
      flush();
      return;
    }
    if (key.backspace) {
      state.query = state.query.slice(0, -1);
      recompute();
      flush();
      return;
    }
    // Any ctrl-combo: Ctrl+C quits; everything else is swallowed (never typed).
    if (key.ctrl) {
      if (input === 'c') quit();
      return;
    }
    // Printable single char → append. Ignore multi-byte / control chunks.
    if (input.length === 1 && input >= ' ') {
      state.query += input;
      recompute();
      flush();
    }
  };

  const onKeyNav = (input: string, key: Key): void => {
    // Ctrl-combos first: only Ctrl+C is meaningful (quit); swallow the rest so
    // Ctrl+L / Ctrl+J / Ctrl+Q etc. don't masquerade as l/j/q commands.
    if (key.ctrl) {
      if (input === 'c') quit();
      return;
    }

    const row = curRow();

    // Quit.
    if (input === 'q' || key.escape) quit();

    // Move.
    if (key.upArrow || input === 'k') { state.cursor = Math.max(0, state.cursor - 1); flush(); return; }
    if (key.downArrow || input === 'j') { state.cursor = Math.max(0, Math.min(visible.length - 1, state.cursor + 1)); flush(); return; }
    if (input === 'g') { state.cursor = 0; flush(); return; }
    if (input === 'G') { state.cursor = Math.max(0, visible.length - 1); flush(); return; }

    // Expand / descend.
    if (key.rightArrow || input === 'l') {
      if (row !== undefined && row.hasChildren) {
        if (!isExpanded(row.id)) {
          state.collapsed.delete(row.id);
          recompute(row.id);
        } else if (state.cursor + 1 < visible.length && visible[state.cursor + 1]!.depth > row.depth) {
          state.cursor += 1; // already expanded → step onto first child
        }
      }
      flush();
      return;
    }

    // Collapse / ascend.
    if (key.leftArrow || input === 'h') {
      if (row !== undefined && row.hasChildren && isExpanded(row.id)) {
        state.collapsed.add(row.id);
        recompute(row.id);
      } else if (row !== undefined) {
        const parentId = tree.nodes.get(row.id)?.parentId ?? null;
        if (parentId !== null) {
          const idx = visible.findIndex((v) => v.id === parentId);
          if (idx >= 0) state.cursor = idx;
        }
      }
      flush();
      return;
    }

    // Toggle collapse.
    if (input === ' ') {
      if (row !== undefined && row.hasChildren) {
        if (isExpanded(row.id)) state.collapsed.add(row.id);
        else state.collapsed.delete(row.id);
        recompute(row.id);
      }
      flush();
      return;
    }

    // Tabs.
    if (key.tab || input === ']') { cycleTab(1); flush(); return; }
    if (key.shiftTab || input === '[') { cycleTab(-1); flush(); return; }
    if (input >= '1' && input <= '4') {
      const idx = Number(input) - 1;
      if (idx < TABS.length) { state.tab = TABS[idx]!; state.cursor = 0; state.scrollOffset = 0; recompute(); }
      flush();
      return;
    }

    // Search.
    if (input === '/') {
      state.search = true;
      state.query = '';
      state.cursor = 0;
      state.scrollOffset = 0;
      recompute();
      flush();
      return;
    }

    // Resume.
    if (key.return) {
      if (row !== undefined) selectAndFocus(row.id);
      return;
    }
  };

  // Boot.
  recompute();
  setupTerminal();
  flush();

  await new Promise<void>(() => {
    const onData = (data: Buffer): void => {
      try {
        const { input, key } = parseKeypress(data);
        if (state.search) onKeySearch(input, key);
        else onKeyNav(input, key);
      } catch {
        // Never let a keystroke crash leave the tty wedged.
        cleanup();
        process.exit(1);
      }
    };
    process.stdin.on('data', onData);
    process.stdout.on('resize', flush);
  });
}
