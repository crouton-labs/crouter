// canvas-nav.ts — pi extension for pi-native canvas agent nodes.
//
// A BASE/GRAPH state machine drawn as chrome around the editor. The editor is
// "you" (this node); the chrome shows your place in the canvas graph.
//
//   BASE  (default, passive) — a vertical stack: your manager above the editor,
//         your live reports below it. Captures NO keys; typing is never touched.
//
//   GRAPH (modal, opt-in) — a NERDTree-style tree of your local graph (ancestry
//         root → you → your subtree, with peers) drawn into one tall widget.
//         While in GRAPH the extension consumes EVERY key and interprets it:
//           j/k move · h/l fold · g/G top/bottom · ↵ focus · m focus manager ·
//           e expand→tmux · x kill (y/n confirm) · esc back to BASE
//         plus any user-defined graphBinds (additive; built-ins are reserved).
//
// Enter/leave GRAPH with the `/graph` slash command, the `prefixKey` shortcut
// (default alt+g, configurable), or the tmux alt+c menu's `g` item. Inside tmux
// alt+c is a tmux display-menu (not a pi key), so prefix chords (m/e/1-9/custom)
// are tmux menu items that route through `crtr canvas chord`.
//
// Selection / attachment signals:
//   CURSOR (selected)  = reverse-video bar (ESC[7m), full width — an attribute,
//                        not a colour, so it reads under NO_COLOR.
//   ATTACHED (watched) = a coloured background bar — a human is currently
//                        viewing the node: a `focuses` viewport points at it
//                        (tmux host) or ≥1 helloed viewer is connected to its
//                        broker (job/attach.json). Running is a separate axis,
//                        signaled by the dot glyph alone (● = engine active on
//                        its host — which may be an unwatched backstage pane
//                        or a paneless broker).
//   SELF               = bold name — a quiet "you are here" marker.
//
// Folding is auto by default: a branch stays COLLAPSED unless its subtree holds
// a running ('active') agent or self. h/l override that per-node and persist.
// A ▸ caret marks an expandable (collapsed-with-kids) row — but NOT the cursor
// row, whose reverse-video bar already sets it apart.
//
// ⚑K pending-asks is PER-NODE, inline on each waiting node's own row (manager,
// reports, tree rows; self shows a trailing ⚑ line in BASE). ⤳M direct-children
// badge shows only on orchestrator rows.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session or legacy job agent).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fullName } from '../core/canvas/index.js';
import {
  beginFrame, cNode, managerOf, liveReports, sortedChildIds, subtreeIds,
  climbRoot, computeSubtreeActivity, buildGraphModel, renderGraphRow,
  navLabel, coloredGlyph, truncate, tokensCell, cycleBadge, childBadge,
  liveBelowBadge, askBadge, activityCell, focusedNodeIds, graphWidgetBudget,
  fetchAsksMap, shortId,
  DIM, RESET, BOLD, YELLOW, GRAPH_HINT,
} from '../core/canvas/nav-model.js';
import type { FoldState } from '../core/canvas/nav-model.js';
import { readConfig } from '../core/config.js';
import { onNavRerender } from './widget-order-bus.js';
import type { CanvasNavConfig, CanvasBind } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids a hard dep on @earendil-works/*)
//
// Signatures sourced from pi-coding-agent's
//   dist/core/extensions/types.d.ts (setWidget / onTerminalInput / getEditorText)
//   docs/extensions.md (registerCommand / registerShortcut)
// ---------------------------------------------------------------------------

type PiEvents = 'session_start' | 'turn_end' | 'session_shutdown';

interface ExtensionWidgetOptions {
  placement?: 'aboveEditor' | 'belowEditor';
}

interface UIContext {
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  /** Raw key tap that fires BEFORE the editor. Return {consume:true} to swallow
   *  the key. Returns an unsub. */
  onTerminalInput?(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText?(): string;
  notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
}

interface ExtensionCtx {
  ui: UIContext;
  /** Current run mode: "tui" | "rpc" | "json" | "print". The nav chrome +
   *  ask-poll timer are interactive-only; headless brokers bind 'print'. */
  mode: string;
}

interface CommandCtx {
  ui: UIContext;
}

interface PiLike {
  on(event: PiEvents, handler: (event: any, ctx: ExtensionCtx) => void | Promise<void>): void;
  registerCommand?(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
  ): void;
  registerShortcut?(
    shortcut: string,
    options: { description?: string; handler: (ctx: CommandCtx) => void | Promise<void> },
  ): void;
}

// ---------------------------------------------------------------------------
// Module-level state — persists across /reload so guards don't stack and fold
// state / current view survive a hot-swap.
// ---------------------------------------------------------------------------

/** The one live background timer. Cleared and replaced on every re-registration. */
let liveTimer: ReturnType<typeof setInterval> | undefined;

/** The one live onTerminalInput unsubscribe. Cleared/replaced on /reload so
 *  exactly one key tap exists (mirrors the liveTimer double-guard). */
let liveUnsub: (() => void) | undefined;

/** Current view. Reset to 'base' on every session_start (incl. /reload). */
type View = 'base' | 'graph';
let view: View = 'base';

/** Manual fold OVERRIDES in GRAPH, keyed by id (so a topology change can't
 *  corrupt them; stale ids are ignored). They override the default policy —
 *  collapsed UNLESS the subtree holds a running ('active') agent or self (see
 *  computeDefaultExpanded). `h` collapses → userCollapsed; `l` expands →
 *  userExpanded. Both survive renders AND BASE↔GRAPH toggles. */
const userCollapsed = new Set<string>();
const userExpanded = new Set<string>();

/** A live view of the manual fold overrides for the pure nav-model layer; the
 *  Sets above are mutated in place, so this reference stays current across
 *  renders and BASE↔GRAPH toggles. */
const folds: FoldState = { userExpanded, userCollapsed };

/** GRAPH cursor (a node id, not an index — indices shift as topology changes). */
let cursorId: string | undefined;

/** GRAPH viewport scroll offset (row index of the top visible row). */
let scrollTop = 0;

/** Transient y/n confirm gate inside GRAPH (kill / confirm-binds). */
let pendingConfirm: { label: string; action: () => void } | undefined;

/** Per-node pending-ask counts, refreshed by the timer; renders read this. */
let asksMap: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const ASK_POLL_MS = 5_000;
const RENDER_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Key decoding — recognizers tolerant of legacy, kitty/CSI-u and
// modifyOtherKeys encodings (pi enables the kitty / modifyOtherKeys protocols,
// and tmux with `extended-keys csi-u` delivers modified keys as CSI-u, not the
// legacy ESC-prefix form). Mirrors pi-tui's parseKey, kept dependency-free.
// ---------------------------------------------------------------------------

const CSI_U_RE = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/;
const MOK_RE = /^\x1b\[27;(\d+);(\d+)~$/;

/** True when a decoded CSI-u modifier (already `mod-1`) is Alt and nothing else
 *  besides lock keys. */
function isAltOnly(mod: number): boolean {
  return (mod & 2) !== 0 && (mod & (1 | 4 | 8 | 16 | 32)) === 0;
}

/** Recognize Alt+<letter> across legacy, kitty/CSI-u and modifyOtherKeys. */
function isAltKey(data: string, letter: string): boolean {
  const code = letter.charCodeAt(0);
  if (data === `\x1b${letter}`) return true;
  const u = CSI_U_RE.exec(data);
  if (u !== null) {
    const mod = u[2] !== undefined ? parseInt(u[2], 10) - 1 : 0;
    return parseInt(u[1], 10) === code && isAltOnly(mod);
  }
  const m = MOK_RE.exec(data);
  if (m !== null) {
    return parseInt(m[2], 10) === code && isAltOnly(parseInt(m[1], 10) - 1);
  }
  return false;
}

/** Recognize a PLAIN letter (no Alt) across the bare byte and kitty CSI-u
 *  single-char form. Uppercase letters also match lowercase-code + Shift. */
function isPlain(data: string, ch: string): boolean {
  if (data === ch) return true;
  const lower = ch.toLowerCase();
  const needShift = ch !== lower;
  const code = lower.charCodeAt(0);
  const m = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(data);
  if (m !== null) {
    if (parseInt(m[1], 10) !== code) return false;
    const mod = m[2] !== undefined ? parseInt(m[2], 10) - 1 : 0;
    return needShift ? (mod & 1) !== 0 && (mod & ~1) === 0 : mod === 0;
  }
  return false;
}

/** Plain Enter across legacy and kitty (ESC [ 13 u). */
function isEnterKey(data: string): boolean {
  return data === '\r' || data === '\n' || /^\x1b\[13(?:;1)?u$/.test(data);
}

/** Plain Escape across legacy and kitty (ESC [ 27 u). */
function isEscKey(data: string): boolean {
  return data === '\x1b' || /^\x1b\[27(?:;1)?u$/.test(data);
}

/** Extract the bare letter of an `alt+<letter>` prefix spec (else undefined). */
function altLetterOf(spec: string | undefined): string | undefined {
  const m = /^alt\+([a-zA-Z])$/.exec(spec ?? '');
  return m ? m[1]!.toLowerCase() : undefined;
}

// Built-in GRAPH keys are reserved; graphBinds may only ADD other keys.
const RESERVED_GRAPH_KEYS = new Set(['j', 'k', 'h', 'l', 'g', 'G', 'm', 'e', 'x', 'y', 'n']);

/** Split a `run` string argv-style and interpolate {id|self|name|manager|lane|
 *  subtree}. A bare `{subtree}` token expands to several argv elements; every
 *  other placeholder substitutes in place (kept as one element so a multi-word
 *  name survives as a single argument under execFile). */
function interpolateArgv(run: string, vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const tok of run.split(/\s+/).filter((t) => t !== '')) {
    if (tok === '{subtree}') {
      for (const part of (vars['subtree'] ?? '').split(/\s+/).filter((p) => p !== '')) out.push(part);
      continue;
    }
    out.push(tok.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the canvas nav chrome on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasNav(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  // Captured from session_start; used in every subsequent render.
  let ui: UIContext | undefined;
  let renderScheduled = false;
  // Run mode captured at session_start. The nav chrome + ask-poll timer are
  // interactive-only; a headless ('print') broker leaves this non-'tui' so the
  // timer no-ops (no per-tick `crtr` shell-out) and no chrome is rendered.
  let liveMode: string | undefined;

  // Cache config once (binds rarely change within a session; readConfig is sync
  // and never throws). prefixKey drives the non-tmux GRAPH toggle shortcut.
  let navConfig: CanvasNavConfig;
  try { navConfig = readConfig('user').canvasNav; } catch { navConfig = { prefixBinds: {}, graphBinds: {} }; }
  const prefixAltLetter = altLetterOf(navConfig.prefixKey);

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------

  /** BASE: manager line above the editor, reports stack below it. */
  const renderBase = (): void => {
    if (ui === undefined) return;

    // One subtree-activity pass (rooted at the ancestry root) feeds the ⇣N
    // live-work-below badge on both the manager line and every report row.
    const activity = computeSubtreeActivity(climbRoot(nodeId), nodeId);

    const mgr = managerOf(nodeId);
    if (mgr === undefined) {
      // Root node: no manager → drop the widget rather than show "↑ (root)" chrome.
      ui.setWidget('crtr-managers', undefined, { placement: 'aboveEditor' });
    } else {
      const mn = cNode(mgr);
      const name = navLabel(mn, mgr);
      const mgrLine = truncate(
        `↑ ${name} ${coloredGlyph(mn)} ${DIM}${mn?.kind ?? ''}${RESET} ${DIM}${tokensCell(mgr)}${RESET}${cycleBadge(mn)}${childBadge(mn)}${liveBelowBadge(mn, activity.activeBelow)}${askBadge(mgr, asksMap)}${activityCell(mgr, mn)}`,
      );
      ui.setWidget('crtr-managers', [mgrLine], { placement: 'aboveEditor' });
    }

    const reports = liveReports(nodeId);
    const lines: string[] = [];
    // Report rows only — no "↓ reports (N)" header (the label carries no signal).
    if (reports.length > 0) {
      const nameW = Math.min(20, Math.max(...reports.map((id) => navLabel(cNode(id), id).length)));
      for (const id of reports) {
        const n = cNode(id);
        const name = navLabel(n, id).padEnd(nameW);
        const kind = `${DIM}${(n?.kind ?? '').padEnd(6)}${RESET}`;
        const tokens = `${DIM}${tokensCell(id).padStart(5)}${RESET}`;
        lines.push(truncate(`  ${coloredGlyph(n)} ${name} ${kind} ${tokens}${cycleBadge(n)}${childBadge(n)}${liveBelowBadge(n, activity.activeBelow)}${askBadge(id, asksMap)}${activityCell(id, n)}`));
      }
    }
    // Self's own pending asks (no self row in BASE) → a trailing inline line.
    const selfAsks = asksMap[nodeId] ?? 0;
    if (selfAsks > 0) lines.push(`${YELLOW}⚑${selfAsks}${RESET}`);
    // Nothing to show → drop the widget rather than render an empty bar.
    ui.setWidget('crtr-base', lines.length > 0 ? lines : undefined, { placement: 'belowEditor' });

    // Drop GRAPH chrome so nothing bleeds through.
    ui.setWidget('crtr-graph', undefined, { placement: 'belowEditor' });
  };

  /** GRAPH: the fold-aware tree + a one-line hint/footer, viewport-bounded. */
  const renderGraph = (): void => {
    if (ui === undefined) return;

    // One subtree-activity pass feeds BOTH the fold policy (which rows show) and
    // the ⇣N live-work-below badge — computed once here, never re-walked per row.
    const activity = computeSubtreeActivity(climbRoot(nodeId), nodeId);
    const rows = buildGraphModel(nodeId, folds, activity.expand);

    // Re-resolve the cursor id → row (it may have vanished under a fold or a
    // close); clamp to nearest visible row.
    let cursorIdx = rows.findIndex((r) => r.id === cursorId);
    if (cursorIdx < 0) {
      cursorIdx = rows.findIndex((r) => r.id === nodeId);
      if (cursorIdx < 0) cursorIdx = 0;
    }
    cursorId = rows[cursorIdx]?.id ?? nodeId;

    // Budget WITHIN pi's widget cap (see graphWidgetBudget): reserve 1 line for
    // the footer hint, up to 2 for the ↑/↓ "more" indicators, the rest for tree
    // rows. The window then tracks the cursor, so j/k scrolls through the WHOLE
    // list rather than hitting pi's hard truncation. The passes settle the
    // mutual dependency between "how many rows fit" and "are indicators shown":
    // each ↑/↓ indicator steals a tree row, which can push the cursor out of
    // view, which moves the window, which changes whether an indicator shows.
    // This needs up to 3 passes to converge (an indicator appearing shrinks the
    // window, the smaller window re-homes scrollTop, that re-home can toggle the
    // *other* indicator). Bailing early (the old 2-pass cap) left the cursor one
    // row off-screen for a single keypress near the bottom — the arrow vanished
    // and only the NEXT press scrolled. 4 passes always settles to a stable,
    // cursor-visible window.
    const treeArea = Math.max(2, graphWidgetBudget() - 1);
    let viewportH = treeArea;
    for (let pass = 0; pass < 4; pass++) {
      if (cursorIdx < scrollTop) scrollTop = cursorIdx;
      if (cursorIdx >= scrollTop + viewportH) scrollTop = cursorIdx - viewportH + 1;
      scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - viewportH)));
      const fit = treeArea - (scrollTop > 0 ? 1 : 0) - (scrollTop + viewportH < rows.length ? 1 : 0);
      if (fit === viewportH) break;
      viewportH = Math.max(1, fit);
    }
    const end = Math.min(rows.length, scrollTop + viewportH);

    const lines: string[] = [];
    const focused = focusedNodeIds(); // one sqlite read per render pass
    if (scrollTop > 0) lines.push(`${DIM}  ↑ ${scrollTop} more${RESET}`);
    for (let i = scrollTop; i < end; i++) lines.push(renderGraphRow(rows[i]!, i === cursorIdx, focused, activity.activeBelow, asksMap));
    if (end < rows.length) lines.push(`${DIM}  ↓ ${rows.length - end} more${RESET}`);

    const hint = pendingConfirm !== undefined
      ? `${YELLOW}${pendingConfirm.label} ${BOLD}y/n${RESET}`
      : GRAPH_HINT;
    lines.push(truncate(`${hint}  ${DIM}${cursorIdx + 1}/${rows.length}${RESET}`));

    ui.setWidget('crtr-graph', lines, { placement: 'belowEditor' });
    // Drop BASE chrome.
    ui.setWidget('crtr-managers', undefined, { placement: 'aboveEditor' });
    ui.setWidget('crtr-base', undefined, { placement: 'belowEditor' });
  };

  const render = (): void => {
    if (ui === undefined) return;
    // Fresh snapshot per render: drop last frame's memoized node/telemetry/edge
    // reads so this paint reflects current disk+db state, then read-once within it.
    beginFrame();
    try {
      if (view === 'graph') renderGraph();
      else renderBase();
    } catch {
      /* render is best-effort; never throw out of a handler */
    }
  };

  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout((): void => {
      renderScheduled = false;
      render();
    }, RENDER_DEBOUNCE_MS);
  };

  // Let canvas-recap ask us to re-assert the manager line so its recap card
  // stays the topmost aboveEditor chrome (pi's widget store is insertion-
  // ordered; re-setting crtr-managers drops it below crtr-recap).
  onNavRerender(scheduleRender);

  // -------------------------------------------------------------------------
  // Actions (all shell out; the extension stays tmux/revive-free)
  // -------------------------------------------------------------------------

  const shellCrtr = (argv: string[], onDone?: () => void): void => {
    try {
      execFile('crtr', argv, (err): void => {
        if (err != null && ui?.notify != null) {
          try { ui.notify(`crtr ${argv[0]} failed`, 'error'); } catch { /* best-effort */ }
        }
        if (onDone !== undefined) { try { onDone(); } catch { /* best-effort */ } }
      });
    } catch {
      /* best-effort */
    }
  };

  const focusTarget = (id: string): void => shellCrtr(['node', 'focus', id]);

  const enterGraph = (): void => {
    view = 'graph';
    pendingConfirm = undefined;
    scrollTop = 0;
    if (cursorId === undefined || cNode(cursorId) === null) cursorId = nodeId;
    render();
  };
  const exitGraph = (): void => {
    view = 'base';
    pendingConfirm = undefined;
    render();
  };
  const toggleGraph = (): void => {
    if (view === 'graph') exitGraph();
    else enterGraph();
  };

  /** Template vars for a graphBind, resolved against the CURSOR node. */
  const graphVars = (cur: string): Record<string, string> => {
    const cn = cNode(cur);
    return {
      id: cur,
      self: nodeId,
      lane: cur,
      name: cn !== null ? fullName(cn) : cur,
      manager: managerOf(cur) ?? '',
      subtree: subtreeIds(cur).join(' '),
    };
  };

  // -------------------------------------------------------------------------
  // GRAPH modal key handler — consumes EVERY key while in GRAPH.
  // -------------------------------------------------------------------------
  const handleGraphKey = (data: string): { consume?: boolean; data?: string } | undefined => {
    // y/n confirm gate takes precedence over everything.
    if (pendingConfirm !== undefined) {
      if (isPlain(data, 'y')) {
        const act = pendingConfirm.action;
        pendingConfirm = undefined;
        act();
        render();
        return { consume: true };
      }
      pendingConfirm = undefined; // any other key cancels
      render();
      return { consume: true };
    }

    // Let the prefix shortcut (alt+g) through so pi's registerShortcut can
    // toggle us back to BASE; esc also exits, handled below.
    if (prefixAltLetter !== undefined && isAltKey(data, prefixAltLetter)) return undefined;

    if (isEscKey(data)) { exitGraph(); return { consume: true }; }

    const rows = buildGraphModel(nodeId, folds);
    let idx = rows.findIndex((r) => r.id === cursorId);
    if (idx < 0) idx = Math.max(0, rows.findIndex((r) => r.id === nodeId));
    const cur = rows[idx];

    if (isPlain(data, 'j')) { idx = Math.min(rows.length - 1, idx + 1); cursorId = rows[idx]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'k')) { idx = Math.max(0, idx - 1); cursorId = rows[idx]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'g')) { cursorId = rows[0]?.id ?? cursorId; render(); return { consume: true }; }
    if (isPlain(data, 'G')) { cursorId = rows[rows.length - 1]?.id ?? cursorId; render(); return { consume: true }; }

    if (isPlain(data, 'h')) {
      if (cur !== undefined && cur.hasKids && !cur.collapsed) {
        userCollapsed.add(cur.id);
        userExpanded.delete(cur.id);
      } else {
        const p = managerOf(cursorId ?? nodeId);
        if (p !== undefined && rows.some((r) => r.id === p)) cursorId = p;
      }
      render();
      return { consume: true };
    }
    if (isPlain(data, 'l')) {
      if (cur !== undefined && cur.collapsed && cur.hasKids) {
        userExpanded.add(cur.id);
        userCollapsed.delete(cur.id);
      } else if (cur !== undefined && cur.hasKids) {
        const c = sortedChildIds(cur.id)[0];
        if (c !== undefined) cursorId = c;
      }
      render();
      return { consume: true };
    }

    if (isEnterKey(data)) { if (cursorId !== undefined) focusTarget(cursorId); render(); return { consume: true }; }
    if (isPlain(data, 'm')) { const mgr = managerOf(nodeId); if (mgr !== undefined) focusTarget(mgr); render(); return { consume: true }; }
    if (isPlain(data, 'x')) {
      const target = cursorId ?? nodeId;
      const n = cNode(target);
      const nm = n !== null ? fullName(n) : shortId(target);
      pendingConfirm = { label: `kill ${nm}?`, action: () => shellCrtr(['node', 'close', '--node', target], render) };
      render();
      return { consume: true };
    }
    if (isPlain(data, 'e')) {
      // Expand → tmux: spread the cursor node's local subtree into a tiled tmux
      // window (same action as the alt+c → e menu chord), for parity.
      shellCrtr(['canvas', 'tmux-spread', cursorId ?? nodeId], render);
      render();
      return { consume: true };
    }

    // Custom graphBinds — additive only (built-in keys reserved).
    for (const [key, bind] of Object.entries(navConfig.graphBinds) as [string, CanvasBind][]) {
      if (key.length !== 1 || RESERVED_GRAPH_KEYS.has(key)) continue;
      if (!isPlain(data, key)) continue;
      const target = cursorId ?? nodeId;
      const argv = interpolateArgv(bind.run, graphVars(target));
      if (argv.length === 0) return { consume: true };
      if (bind.confirm === true) {
        const n = cNode(target);
        const nm = n !== null ? fullName(n) : shortId(target);
        pendingConfirm = { label: `${bind.desc ?? bind.run} ${nm}?`, action: () => shellCrtr(argv, render) };
      } else {
        shellCrtr(argv, render);
      }
      render();
      return { consume: true };
    }

    // Modal: swallow everything else so stray keys never reach the editor.
    return { consume: true };
  };

  // Pre-editor key tap. BASE passes EVERY key through (composing is never
  // disturbed); GRAPH is fully modal. One persistent tap (preserving the
  // /reload single-unsub guard); its body branches on `view`.
  const handleKey = (data: string): { consume?: boolean; data?: string } | undefined => {
    try {
      if (ui === undefined) return undefined;
      if (view === 'base') return undefined;
      return handleGraphKey(data);
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // Slash command + shortcut to toggle GRAPH (registered once per load, like
  // canvas-commands.ts; pi dedupes duplicate names on /reload).
  // -------------------------------------------------------------------------
  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand('graph', {
      description: 'Toggle the canvas GRAPH view (NERDTree of your local graph)',
      handler: async (_args, ctx): Promise<void> => {
        if (ui === undefined) ui = ctx.ui;
        toggleGraph();
      },
    });
  }
  if (typeof pi.registerShortcut === 'function' && navConfig.prefixKey !== undefined && navConfig.prefixKey !== '') {
    try {
      pi.registerShortcut(navConfig.prefixKey, {
        description: 'Toggle the canvas GRAPH view',
        handler: async (ctx): Promise<void> => {
          if (ui === undefined) ui = ctx.ui;
          toggleGraph();
        },
      });
    } catch {
      /* shortcut spec rejected by pi — /graph + the alt+c menu still work */
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  pi.on('session_start', (_event: any, ctx: ExtensionCtx): void => {
    liveMode = ctx.mode;
    // The nav chrome (widgets, key taps, the ask-poll timer) is interactive-only.
    // A headless (print-mode) broker loads this extension but renders no chrome
    // and must not poll. Under tmux ctx.mode is always 'tui' — byte-identical.
    if (ctx.mode !== 'tui') return;
    ui = ctx.ui;

    // Fresh session / hot-swap: start in BASE and clear any legacy or
    // inactive-view widgets so nothing stale bleeds through.
    view = 'base';
    pendingConfirm = undefined;
    for (const key of ['crtr-asks', 'crtr-siblings', 'crtr-reports', 'crtr-graph']) {
      try { ctx.ui.setWidget(key, undefined, { placement: 'belowEditor' }); } catch { /* ignore */ }
      try { ctx.ui.setWidget(key, undefined, { placement: 'aboveEditor' }); } catch { /* ignore */ }
    }

    // Register the modal key tap once. Double-guard against /reload stacking
    // (mirrors liveTimer): clear any previous tap before adding ours.
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
    try {
      if (typeof ctx.ui.onTerminalInput === 'function') {
        liveUnsub = ctx.ui.onTerminalInput(handleKey);
      }
    } catch {
      /* onTerminalInput unavailable — chrome stays display-only */
    }

    scheduleRender();
  });

  pi.on('turn_end', (_event: any, _ctx: ExtensionCtx): void => {
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Background timer — per-node ask polling (one shell-out) + periodic refresh
  // -------------------------------------------------------------------------
  if (liveTimer !== undefined) clearInterval(liveTimer);

  const timer = setInterval((): void => {
    // Inert in a headless ('print') broker — never shell out to `crtr` per tick.
    if (liveMode !== 'tui') return;
    try {
      const rootId = climbRoot(nodeId);
      const fresh = fetchAsksMap(rootId);
      // Repaint only when the map actually changed — avoids constant flicker.
      if (JSON.stringify(fresh) !== JSON.stringify(asksMap)) {
        asksMap = fresh;
        scheduleRender();
      }
    } catch {
      /* timer is best-effort */
    }
  }, ASK_POLL_MS);

  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  pi.on('session_shutdown', (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
  });
}

export default registerCanvasNav;
