// graph-overlay.ts — the alt+g GRAPH navigator overlay for `crtr attach` (Unit Q).
//
// Native reimplementation of canvas-nav.ts's GRAPH modal as a pi-tui OVERLAY
// (the viewer has no pi extension host). `tui.showOverlay(this, …)` mounts this
// Component as a BOUNDED, centered modal (~72% of the terminal, themed frame) and
// CAPTURES keyboard focus (mirrors extension-dialogs.ts);
// `OverlayHandle.hide()` tears it down and restores focus to the editor. While
// shown, every key routes to handleInput() — a fold-aware NERDTree of the local
// subscription graph with the canvas-nav keymap:
//   j/k move · h/l fold/ascend-descend · g/G top/bottom · ↵ focus (swap into
//   this pane) · m focus manager · x kill (y/n confirm) · esc close.
// `e` is a tmux-menu prefixBind, not a GRAPH key, so it is swallowed (per
// canvas-nav). All model/render comes from the shared nav-model layer; keys are
// decoded with pi-tui's canonical matchesKey (kitty/CSI-u aware).
//
// Enter/m/x SHELL `crtr` out-of-process (node focus / node close) — the viewer
// itself never spawns pi or opens a session (the §0 one-writer invariant). It
// passes its own pane as `crtr node focus --pane <anchor>`: under the
// one-viewer-per-node model the target's existing viewer is navigated in place,
// or a fresh viewer opens BESIDE this pane — never a second pane for the same node.

import { execFile } from 'node:child_process';
import { matchesKey, truncateToWidth, type Component, type OverlayHandle, type TUI } from '@earendil-works/pi-tui';
import { fullName } from '../../core/canvas/index.js';
import type { AttachPalette } from './config-load.js';
import {
  beginFrame, cNode, managerOf, sortedChildIds, climbRoot, computeSubtreeActivity,
  buildGraphModel, renderGraphRow, focusedNodeIds, shortId, visibleWidth,
  VIEWPORT_FALLBACK_ROWS,
  DIM, RESET, BOLD, YELLOW,
} from '../../core/canvas/nav-model.js';
import type { FoldState } from '../../core/canvas/nav-model.js';

// A BOUNDED, centered modal (CTO ruling: not full-bleed). Width/height are capped
// at ~72% of the terminal; the overlay clips our lines to maxHeight, and render()
// budgets the panel to the SAME fraction (HEIGHT_PCT) so the framed box is never
// clipped. margin keeps it off the screen edges.
const HEIGHT_PCT = 0.72;
const OVERLAY_OPTIONS = { anchor: 'center', width: '72%', minWidth: 48, maxHeight: '72%', margin: 1 } as const;

// Viewer-specific hint: nav-model's shared GRAPH_HINT advertises "e expand",
// but that key is the tmux pane-expand prefix-bind canvas-nav installs in its
// host pane — the attach overlay has no such bind and swallows `e`, so the key
// would do nothing here. Drop it.
const GRAPH_HINT = `${DIM}jk move · hl fold · ↵ focus · x kill · m mgr · esc${RESET}`;

export class GraphOverlay implements Component {
  private handle: OverlayHandle | undefined;

  /** Manual fold OVERRIDES (h collapses → userCollapsed, l expands → userExpanded);
   *  both override the default activity-driven policy and survive open/close. */
  private readonly userExpanded = new Set<string>();
  private readonly userCollapsed = new Set<string>();
  private readonly folds: FoldState = { userExpanded: this.userExpanded, userCollapsed: this.userCollapsed };

  /** Cursor as a node id (indices shift as topology changes). */
  private cursorId: string | undefined;
  /** Viewport scroll offset (row index of the top visible tree row). */
  private scrollTop = 0;
  /** Transient y/n confirm gate (kill). */
  private pendingConfirm: { label: string; action: () => void } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly self: string,
    private readonly getAsks: () => Record<string, number>,
    private readonly palette: AttachPalette,
  ) {}

  isOpen(): boolean {
    return this.handle !== undefined;
  }

  open(): void {
    if (this.handle !== undefined) return;
    this.scrollTop = 0;
    this.pendingConfirm = undefined;
    if (this.cursorId === undefined || cNode(this.cursorId) === null) this.cursorId = this.self;
    this.handle = this.tui.showOverlay(this, OVERLAY_OPTIONS);
    this.tui.requestRender();
  }

  close(): void {
    if (this.handle === undefined) return;
    this.pendingConfirm = undefined;
    this.handle.hide();
    this.handle = undefined;
    this.tui.requestRender();
  }

  toggle(): void {
    if (this.handle === undefined) this.open();
    else this.close();
  }

  /** Repaint if shown (the low-rate ask poll calls this). */
  refresh(): void {
    if (this.handle !== undefined) this.tui.requestRender();
  }

  invalidate(): void {
    /* no cached render state — rebuilt every render() */
  }

  // -------------------------------------------------------------------------

  render(width: number): string[] {
    // Fresh snapshot per paint (mirror canvas-nav's per-frame cache).
    beginFrame();
    const asks = this.getAsks();
    const activity = computeSubtreeActivity(climbRoot(this.self), this.self);
    const rows = buildGraphModel(this.self, this.folds, activity.expand);

    // Re-resolve the cursor id → row (it may have vanished under a fold/close).
    let cursorIdx = rows.findIndex((r) => r.id === this.cursorId);
    if (cursorIdx < 0) {
      cursorIdx = rows.findIndex((r) => r.id === this.self);
      if (cursorIdx < 0) cursorIdx = 0;
    }
    this.cursorId = rows[cursorIdx]?.id ?? this.self;

    // Bounded panel budget (centered modal, not full-bleed): the box height
    // shrinks to content but is capped at HEIGHT_PCT of the terminal — matching
    // the overlay's maxHeight so our framed lines are never clipped. 2 rows go to
    // the top/bottom border, the rest to tree rows.
    const term = process.stdout.rows ?? VIEWPORT_FALLBACK_ROWS;
    // Never exceed the overlay's own maxHeight (term-2 after the margin), so the
    // bottom border is never slice-clipped even on a very short terminal.
    const maxPanelH = Math.max(3, Math.min(Math.floor(term * HEIGHT_PCT), term - 2));
    const treeArea = Math.max(2, Math.min(rows.length, maxPanelH - 2));

    // Track the cursor within treeArea, reserving ↑/↓ "more" indicators. Up to
    // 4 passes converge the mutual dependency between window size and indicators
    // (an indicator steals a tree row → can re-home scrollTop → toggles the other
    // indicator); see canvas-nav.ts renderGraph for the rationale.
    let viewportH = treeArea;
    for (let pass = 0; pass < 4; pass++) {
      if (cursorIdx < this.scrollTop) this.scrollTop = cursorIdx;
      if (cursorIdx >= this.scrollTop + viewportH) this.scrollTop = cursorIdx - viewportH + 1;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - viewportH)));
      const fit = treeArea - (this.scrollTop > 0 ? 1 : 0) - (this.scrollTop + viewportH < rows.length ? 1 : 0);
      if (fit === viewportH) break;
      viewportH = Math.max(1, fit);
    }
    const end = Math.min(rows.length, this.scrollTop + viewportH);

    const focused = focusedNodeIds();
    const body: string[] = [];
    if (this.scrollTop > 0) body.push(`${DIM}  ↑ ${this.scrollTop} more${RESET}`);
    for (let i = this.scrollTop; i < end; i++) {
      body.push(renderGraphRow(rows[i]!, i === cursorIdx, focused, activity.activeBelow, asks));
    }
    if (end < rows.length) body.push(`${DIM}  ↓ ${rows.length - end} more${RESET}`);
    while (body.length < treeArea) body.push(''); // fill so the overlay is opaque

    const title = `${BOLD}⌗ canvas graph${RESET} ${DIM}(${cursorIdx + 1}/${rows.length})${RESET}`;
    const hint = this.pendingConfirm !== undefined
      ? `${YELLOW}${this.pendingConfirm.label} ${BOLD}y/n${RESET}`
      : GRAPH_HINT;

    // Frame the panel: title in the top border, hint in the bottom border, tree
    // rows boxed with themed side bars (truncate/pad to the inner width so the
    // right edge stays flush and opaque).
    const B = this.palette.border;
    const innerW = Math.max(1, width - 4); // "│ " + content + " │"
    // Hard-cut (empty ellipsis) + pad to innerW: ANSI-aware, so the cursor fill
    // bar reaches the right border flush with no stray "…" and the box edge is
    // opaque.
    const boxed = body.map(
      (line) => `${B('│')} ${truncateToWidth(line, innerW, '', true)} ${B('│')}`,
    );
    // Paint the WHOLE modal — border rows + boxed body + opaque space-fill — on
    // the theme's distinct-surface background (selectedBg) so the float reads as
    // a separate surface, not a hole in the viewer behind it (CTO ruling).
    const S = this.palette.surface;
    return [
      this.borderRow('╭', '╮', title, width),
      ...boxed,
      this.borderRow('╰', '╯', hint, width),
    ].map(S);
  }

  /** A top/bottom border row: `<lc>─ <label> ────<rc>`, frame in the theme border
   *  color, the label keeping its own styling. The label is visible-truncated to
   *  the available span so a long label (a narrow pane, or a long `kill <name>?`
   *  confirm) never spills past the corner. */
  private borderRow(lc: string, rc: string, label: string, width: number): string {
    const B = this.palette.border;
    const span = Math.max(1, width - 5); // lc ─ _ <span> _ ─… rc
    const lbl = truncateToWidth(label, span, '…');
    const fill = Math.max(0, width - 5 - visibleWidth(lbl));
    return `${B(`${lc}─`)} ${lbl} ${B('─'.repeat(fill) + rc)}`;
  }

  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    try {
      this.dispatch(data);
    } catch {
      /* a key handler is best-effort; never throw out of the input pump */
    }
  }

  private dispatch(data: string): void {
    // y/n confirm gate takes precedence over everything.
    if (this.pendingConfirm !== undefined) {
      if (matchesKey(data, 'y')) {
        const act = this.pendingConfirm.action;
        this.pendingConfirm = undefined;
        act();
      } else {
        this.pendingConfirm = undefined; // any other key cancels
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'escape')) { this.close(); return; }

    const rows = buildGraphModel(this.self, this.folds);
    let idx = rows.findIndex((r) => r.id === this.cursorId);
    if (idx < 0) idx = Math.max(0, rows.findIndex((r) => r.id === this.self));
    const cur = rows[idx];

    if (matchesKey(data, 'j')) { idx = Math.min(rows.length - 1, idx + 1); this.cursorId = rows[idx]?.id ?? this.cursorId; this.tui.requestRender(); return; }
    if (matchesKey(data, 'k')) { idx = Math.max(0, idx - 1); this.cursorId = rows[idx]?.id ?? this.cursorId; this.tui.requestRender(); return; }
    if (matchesKey(data, 'g')) { this.cursorId = rows[0]?.id ?? this.cursorId; this.tui.requestRender(); return; }
    if (matchesKey(data, 'shift+g')) { this.cursorId = rows[rows.length - 1]?.id ?? this.cursorId; this.tui.requestRender(); return; }

    if (matchesKey(data, 'h')) {
      if (cur !== undefined && cur.hasKids && !cur.collapsed) {
        this.userCollapsed.add(cur.id);
        this.userExpanded.delete(cur.id);
      } else {
        const p = managerOf(this.cursorId ?? this.self);
        if (p !== undefined && rows.some((r) => r.id === p)) this.cursorId = p;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'l')) {
      if (cur !== undefined && cur.collapsed && cur.hasKids) {
        this.userExpanded.add(cur.id);
        this.userCollapsed.delete(cur.id);
      } else if (cur !== undefined && cur.hasKids) {
        const c = sortedChildIds(cur.id)[0];
        if (c !== undefined) this.cursorId = c;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'enter')) {
      if (this.cursorId !== undefined) this.focusTarget(this.cursorId);
      this.close();
      return;
    }
    if (matchesKey(data, 'm')) {
      const mgr = managerOf(this.self);
      if (mgr !== undefined) { this.focusTarget(mgr); this.close(); }
      return;
    }
    if (matchesKey(data, 'x')) {
      const target = this.cursorId ?? this.self;
      const n = cNode(target);
      const nm = n !== null ? fullName(n) : shortId(target);
      this.pendingConfirm = { label: `kill ${nm}?`, action: () => this.shellCrtr(['node', 'close', '--node', target]) };
      this.tui.requestRender();
      return;
    }

    // Modal: swallow everything else (incl. the `e` tmux-menu bind) so a stray
    // key never reaches the editor underneath.
  }

  // -------------------------------------------------------------------------

  /** Focus node `id` from the overlay by shelling `crtr node focus <id> --pane <here>`.
   *  Under the one-viewer-per-node model `--pane` is the ANCHOR to open beside: if
   *  `id` has no viewer yet a fresh one splits beside this pane; if it already has
   *  one, that viewer is navigated in place (this pane is left as-is). We pass
   *  TMUX_PANE explicitly so the anchor is THIS pane even if env resolution differs. */
  private focusTarget(id: string): void {
    const argv = ['node', 'focus', id];
    const pane = process.env['TMUX_PANE'];
    if (pane !== undefined && pane !== '') argv.push('--pane', pane);
    this.shellCrtr(argv);
  }

  private shellCrtr(argv: string[]): void {
    try {
      execFile('crtr', argv, () => { /* best-effort; the overlay is fire-and-forget */ });
    } catch {
      /* best-effort */
    }
  }
}
