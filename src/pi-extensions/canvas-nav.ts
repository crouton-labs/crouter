// canvas-nav.ts — pi extension for pi-native canvas agent nodes.
//
// Renders a navigable "spine" of the node graph as chrome around the editor.
// The editor itself is "you"; the three lanes are your neighbours, stacked so
// the spine reads top→bottom (managers · peers · you · reports):
//
//   ABOVE EDITOR  crtr-asks      ⚑ N waiting                    (only when N > 0)
//   ABOVE EDITOR  crtr-managers  ↑ managers  <name> ●  …   (or  ↑ (root))
//   ABOVE EDITOR  crtr-siblings  ↔ peers     <name> ○  …        (omitted when none)
//   ───────────── EDITOR (you) ─────────────
//   BELOW EDITOR  crtr-reports   ↓ reports   <name> ○  …  · ctx <k>
//
// Navigation (only on an EMPTY editor, so composing is never disturbed):
//   Alt+k → managers (up)      Alt+j → reports (down)
//   Alt+h / Alt+l → peers (left / right)
//   ↵ focus the selected node · esc clears the selection
// Selection is shown by weight + a ▸ caret — NOT the status dot (which encodes
// active ● / idle ○ / done ✓ / dead ✗) and not colour alone, so it reads under
// NO_COLOR and on any background.
//
// INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// Refresh triggers:
//   • session_start — initial paint once we have a ctx.ui handle
//   • turn_end      — statuses may have changed during the turn
//   • background timer (ASK_POLL_MS) — polls `crtr canvas attention count` and
//     repaints whenever the count changes
//
// Double-timer prevention (copied from canvas-inbox-watcher):
//   `liveTimer` is module-level. A /reload re-enters this factory and clears
//   the previous interval before starting a new one — exactly one timer lives.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, subscribersOf, subscriptionsOf, jobDir } from '../core/canvas/index.js';
import type { NodeMeta } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*)
//
// Exact signatures sourced from:
//   /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
//
//   export type WidgetPlacement = "aboveEditor" | "belowEditor";
//   export interface ExtensionWidgetOptions { placement?: WidgetPlacement; }
//   setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
// ---------------------------------------------------------------------------

type PiEvents = 'session_start' | 'turn_end' | 'session_shutdown';

interface ExtensionWidgetOptions {
  /** Where the widget is rendered. "aboveEditor" | "belowEditor" */
  placement?: 'aboveEditor' | 'belowEditor';
}

interface UIContext {
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  /** Raw key tap that fires BEFORE the editor. Return {consume:true} to swallow
   *  the key (so e.g. UP doesn't trigger pi's history recall). Returns unsub. */
  onTerminalInput?(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  /** Current editor buffer text — used to only hijack keys on an empty editor. */
  getEditorText?(): string;
  /** Transient toast, used to report a failed focus. */
  notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
}

interface ExtensionCtx {
  ui: UIContext;
}

interface PiLike {
  on(event: PiEvents, handler: (event: any, ctx: ExtensionCtx) => void | Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Module-level state — persist across /reload to prevent stacking
// ---------------------------------------------------------------------------

/** The one live background timer. Cleared and replaced on every re-registration. */
let liveTimer: ReturnType<typeof setInterval> | undefined;

/** The one live onTerminalInput unsubscribe. Cleared/replaced on /reload so
 *  exactly one key tap exists (mirrors the liveTimer double-guard). */
let liveUnsub: (() => void) | undefined;

/** Last-known ask count — cached across renders so the UI stays cheap. */
let cachedAskCount = 0;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const ASK_POLL_MS = 5_000;    // how often to shell out for ask count
const RENDER_DEBOUNCE_MS = 150; // coalesce rapid turn_end bursts

// ---------------------------------------------------------------------------
// ANSI styling. pi wraps widget string[] lines in Text components that render
// embedded escapes (the same path used internally for theme.fg(...)), and it
// measures width with an ANSI-aware visibleWidth — so raw escapes are safe here
// and need no pi-tui dependency. Selection uses theme-agnostic attributes
// (bold/dim weight + a ▸ caret) so it pops on any terminal; status uses the
// standard 8 colors on the dot, which read on both light and dark backgrounds.
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;

/** Status glyph colored by state: active green, idle dim, done cyan, dead red. */
function coloredGlyph(node: NodeMeta | null): string {
  if (node === null) return '?';
  switch (node.status) {
    case 'active': return `${GREEN}●${RESET}`;
    case 'idle':   return `${GRAY}○${RESET}`;
    case 'done':   return `${CYAN}✓${RESET}`;
    case 'dead':   return `${RED}✗${RESET}`;
    default:       return '?';
  }
}

// ---------------------------------------------------------------------------
// ANSI-aware truncation — single-row, no pi-tui dep
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width, ignoring ANSI escapes. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Truncate to `max` VISIBLE columns: escape sequences are copied through
 *  verbatim (so a cut never lands mid-escape) and the result always ends in
 *  RESET, so a clipped style can't bleed into the editor below. */
function truncate(s: string, max = 180): string {
  if (visibleWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length && w < max - 1) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i];
    w++;
    i++;
  }
  return `${out}…${RESET}`;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

interface Telemetry {
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
  updated_at?: string;
}

function readTelemetry(nodeId: string): Telemetry {
  try {
    const p = join(jobDir(nodeId), 'telemetry.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) as Telemetry;
  } catch {
    return {};
  }
}

function fmtTokens(n: number): string {
  return n < 1_000 ? `${n}` : `${Math.round(n / 1_000)}k`;
}

// ---------------------------------------------------------------------------
// Ask count — shells out synchronously with a tight timeout so the timer
// callback is cheap (< 2 s). Result is cached; the UI reads only the cache.
// ---------------------------------------------------------------------------

function fetchAskCount(nodeId: string): number {
  try {
    const raw = execFileSync('crtr', ['canvas', 'attention', 'count', '--node', nodeId], {
      timeout: 2_000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw.trim()) as { count?: unknown };
    return typeof parsed.count === 'number' ? parsed.count : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Neighbors — the navigable spine around this node
// ---------------------------------------------------------------------------

interface Neighbor {
  id: string;
  name: string;
  node: NodeMeta | null;
}

function toNeighbor(refId: string): Neighbor {
  const node = getNode(refId);
  return { id: refId, name: node?.name ?? refId.slice(0, 8), node };
}

/** Managers — who this node reports up to (the UP direction). */
function managersOf(nodeId: string): Neighbor[] {
  try {
    return subscribersOf(nodeId).map((ref) => toNeighbor(ref.node_id));
  } catch {
    return [];
  }
}

/** Live reports — children (the DOWN direction). Finished/dead workers fall
 *  off: a terminal agent that's done its job no longer needs a chrome slot. */
function reportsOf(nodeId: string): Neighbor[] {
  try {
    return subscriptionsOf(nodeId)
      .map((ref) => toNeighbor(ref.node_id))
      .filter((n) => n.node?.status === 'active' || n.node?.status === 'idle');
  } catch {
    return [];
  }
}

/** Peers — other live reports of this node's managers (the SIDE direction):
 *  nodes that share a manager with us, minus ourselves. Deduped across multiple
 *  managers; like reports, only active/idle peers earn a chrome slot. */
function siblingsOf(nodeId: string): Neighbor[] {
  try {
    const seen = new Set<string>([nodeId]);
    const out: Neighbor[] = [];
    for (const mgr of subscribersOf(nodeId)) {
      for (const ref of subscriptionsOf(mgr.node_id)) {
        if (seen.has(ref.node_id)) continue;
        seen.add(ref.node_id);
        const nb = toNeighbor(ref.node_id);
        if (nb.node?.status === 'active' || nb.node?.status === 'idle') out.push(nb);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Selection cursor — the spine is three lanes around this node:
//   'up'   = managers  (Alt+k)        ↑ who I report to
//   'side' = peers     (Alt+h / Alt+l) ↔ siblings sharing a manager
//   'down' = reports   (Alt+j)        ↓ my children
// `idx` indexes within the active lane; 'none' means nothing is selected and
// the chrome renders calm (no caret, no focus hint).
// ---------------------------------------------------------------------------

type Lane = 'none' | 'up' | 'side' | 'down';
interface Cursor {
  lane: Lane;
  idx: number;
}

const FOCUS_HINT = `${DIM}  ↵ focus · esc cancel${RESET}`;

/** Dim, fixed-width lane label so the slot columns line up across rows. */
function laneLabel(glyph: string, word: string): string {
  return `${DIM}${glyph} ${word.padEnd(8)}${RESET}`;
}

/** One neighbor slot. Selection is carried by WEIGHT + a caret — never by the
 *  status dot (it already encodes active/idle/done/dead) and never by colour
 *  alone, so it reads under NO_COLOR and on any background:
 *    selected   → `▸ name ●`  bold, leading caret
 *    unselected → `  name ●`  dim, caret column reserved (no horizontal jitter)
 *  The trailing glyph stays status-colored in both states. */
function slot(n: Neighbor, selected: boolean): string {
  const glyph = coloredGlyph(n.node);
  if (selected) return `${BOLD}▸ ${n.name}${RESET} ${glyph}`;
  return `${DIM}  ${n.name}${RESET} ${glyph}`;
}

/** Join one lane's slots, marking the selected index and emitting the focus
 *  hint only when this lane actually holds the selection. */
function laneSlots(neighbors: Neighbor[], selIdx: number): { body: string; hint: string } {
  const body = neighbors.map((n, i) => slot(n, i === selIdx)).join('  ');
  return { body, hint: selIdx >= 0 ? FOCUS_HINT : '' };
}

/** ↑ managers <slots>   (or  ↑ (root)  when this node reports to no one) */
function buildManagersLines(managers: Neighbor[], cursor: Cursor): string[] {
  if (managers.length === 0) return [`${DIM}↑ ${'(root)'.padEnd(8)}${RESET}`];
  const selIdx = cursor.lane === 'up' ? cursor.idx : -1;
  const { body, hint } = laneSlots(managers, selIdx);
  return [truncate(`${laneLabel('↑', 'managers')} ${body}${hint}`)];
}

/** ↔ peers <slots>   (the whole row is omitted when this node has no peers) */
function buildSiblingsLines(siblings: Neighbor[], cursor: Cursor): string[] | undefined {
  if (siblings.length === 0) return undefined;
  const selIdx = cursor.lane === 'side' ? cursor.idx : -1;
  const { body, hint } = laneSlots(siblings, selIdx);
  return [truncate(`${laneLabel('↔', 'peers')} ${body}${hint}`)];
}

/** ↓ reports <slots> · ctx <k>   (slots → (none) when this node has no reports) */
function buildReportsLines(nodeId: string, reports: Neighbor[], cursor: Cursor): string[] {
  const tel = readTelemetry(nodeId);
  const ctx =
    tel.tokens_in != null && tel.tokens_in > 0 ? `${DIM}· ctx ${fmtTokens(tel.tokens_in)}${RESET}` : '';
  const label = laneLabel('↓', 'reports');

  if (reports.length === 0) {
    return [truncate(`${label} ${DIM}(none)${RESET}${ctx !== '' ? ` ${ctx}` : ''}`)];
  }

  const selIdx = cursor.lane === 'down' ? cursor.idx : -1;
  const { body, hint } = laneSlots(reports, selIdx);
  const tail = ctx !== '' ? ` ${ctx}` : '';
  return [truncate(`${label} ${body}${tail}${hint}`)];
}

// ---------------------------------------------------------------------------
// Key decoding — Alt+j / Alt+k reach us in different encodings depending on the
// terminal's active keyboard protocol. pi enables the kitty / modifyOtherKeys
// protocols, and a tmux with `extended-keys csi-u` then delivers a *modified*
// key as a CSI-u sequence — NOT the legacy ESC-prefix form. Comparing against a
// single literal ("\x1bj") silently fails on any such terminal, so we accept
// every encoding:
//
//   legacy           ESC j                 "\x1bj"
//   kitty / csi-u    ESC [ 106 ; 3 u       "\x1b[106;3u"     (mod 3 → alt)
//   modifyOtherKeys  ESC [ 27 ; 3 ; 106 ~  "\x1b[27;3;106~"
//
// The CSI-u modifier value is `mod-1` as a bitmask (shift 1, alt 2, ctrl 4,
// super 8, …); Alt-alone is bit 2 set with shift/ctrl/super/etc. all clear
// (lock bits ignored). Mirrors pi-tui's own parseKey, kept dependency-free.
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
  if (data === `\x1b${letter}`) return true; // legacy ESC-prefix
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

/** Plain Enter across legacy and kitty (ESC [ 13 u). */
function isEnterKey(data: string): boolean {
  return data === '\r' || data === '\n' || /^\x1b\[13(?:;1)?u$/.test(data);
}

/** Plain Escape across legacy and kitty (ESC [ 27 u). */
function isEscKey(data: string): boolean {
  return data === '\x1b' || /^\x1b\[27(?:;1)?u$/.test(data);
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

  // Debounce flag — prevents stacked renders from rapid turn_end bursts.
  let renderScheduled = false;

  // Spine cursor across the three lanes (see Lane / Cursor above): which lane
  // is active ('none' = nothing selected, chrome calm) and the index within it.
  // Driven by the key tap below.
  let cursor: Cursor = { lane: 'none', idx: 0 };

  // -------------------------------------------------------------------------
  // Core render — pushes all three widgets in one pass
  // -------------------------------------------------------------------------
  // Re-clamp the cursor against the current lane's length (the graph may have
  // shrunk since the last keypress); collapse to 'none' if the lane emptied.
  const clampCursor = (managers: Neighbor[], siblings: Neighbor[], reports: Neighbor[]): void => {
    if (cursor.lane === 'none') return;
    const len =
      cursor.lane === 'up' ? managers.length :
      cursor.lane === 'side' ? siblings.length :
      reports.length;
    if (len === 0) { cursor = { lane: 'none', idx: 0 }; return; }
    cursor.idx = Math.max(0, Math.min(len - 1, cursor.idx));
  };

  const render = (): void => {
    if (ui === undefined) return;
    try {
      const managers = managersOf(nodeId);
      const siblings = siblingsOf(nodeId);
      const reports = reportsOf(nodeId);
      clampCursor(managers, siblings, reports);

      // ⚑ pending asks — top of the stack, omitted entirely when count is 0.
      ui.setWidget(
        'crtr-asks',
        cachedAskCount > 0 ? [`${YELLOW}⚑ ${cachedAskCount} waiting${RESET}`] : undefined,
        { placement: 'aboveEditor' },
      );

      // ↑ managers, then ↔ peers directly above the editor — the spine reads
      // top→bottom: managers · peers · [you] · reports. setWidget(…, undefined)
      // drops the peers row entirely when this node has none.
      ui.setWidget('crtr-managers', buildManagersLines(managers, cursor), { placement: 'aboveEditor' });
      ui.setWidget('crtr-siblings', buildSiblingsLines(siblings, cursor), { placement: 'aboveEditor' });

      // ↓ reports row, below the editor.
      ui.setWidget('crtr-reports', buildReportsLines(nodeId, reports, cursor), { placement: 'belowEditor' });
    } catch {
      /* render is best-effort; never throw out of a handler */
    }
  };

  // Debounced render: coalesces rapid event bursts into one paint.
  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout((): void => {
      renderScheduled = false;
      render();
    }, RENDER_DEBOUNCE_MS);
  };

  // Bring the selected node's window forefront. Reuses the `crtr node focus`
  // CLI (which revives a dormant target first) via the same execFile pattern
  // as the ask-count poll — keeps tmux/revive logic out of the extension.
  const focusTarget = (id: string): void => {
    try {
      execFile('crtr', ['node', 'focus', id], (err): void => {
        if (err != null && ui?.notify != null) {
          try { ui.notify(`focus failed: ${id.slice(0, 8)}`, 'error'); } catch { /* best-effort */ }
        }
      });
    } catch {
      /* best-effort */
    }
  };

  // Pre-editor key tap. Only acts on an EMPTY editor so message composition
  // (multi-line cursor moves, history, submit) is never disturbed. Vim-style
  // Alt+h/j/k/l walk the spine — Alt+k UP (managers), Alt+j DOWN (reports),
  // Alt+h/Alt+l LEFT/RIGHT (peers) — so the bare arrow keys stay bound to pi's
  // normal history recall and never conflict with canvas nav.
  const handleKey = (data: string): { consume?: boolean; data?: string } | undefined => {
    try {
      if (ui === undefined) return undefined;

      let editorEmpty = true;
      try { editorEmpty = (ui.getEditorText?.() ?? '').trim() === ''; } catch { editorEmpty = false; }
      if (!editorEmpty) return undefined; // composing — leave every key alone

      // Alt+h/j/k/l walk the spine — recognized across legacy ESC-prefix,
      // kitty/CSI-u and modifyOtherKeys encodings (see isAltKey above) so nav
      // works regardless of the terminal's keyboard protocol.
      const isUp = isAltKey(data, 'k');
      const isDown = isAltKey(data, 'j');
      const isLeft = isAltKey(data, 'h');
      const isRight = isAltKey(data, 'l');
      const isEnter = isEnterKey(data);
      const isEsc = isEscKey(data);

      if (!isUp && !isDown && !isLeft && !isRight && !isEnter && !isEsc) {
        // Any other key cancels an active selection, then passes through so the
        // character lands in the editor as normal.
        if (cursor.lane !== 'none') { cursor = { lane: 'none', idx: 0 }; render(); }
        return undefined;
      }

      const managers = managersOf(nodeId);
      const siblings = siblingsOf(nodeId);
      const reports = reportsOf(nodeId);

      // Move within (or hop into) a lane, cycling with wrap. Entering a lane
      // lands on the first slot for forward motion, the last for backward.
      const step = (lane: Exclude<Lane, 'none'>, count: number, dir: 1 | -1): void => {
        if (count === 0) return;
        if (cursor.lane !== lane) cursor = { lane, idx: dir === 1 ? 0 : count - 1 };
        else cursor = { lane, idx: (cursor.idx + dir + count) % count };
      };

      if (isUp)    { step('up',   managers.length, +1); render(); return { consume: true }; }
      if (isDown)  { step('down', reports.length,  +1); render(); return { consume: true }; }
      if (isRight) { step('side', siblings.length, +1); render(); return { consume: true }; }
      if (isLeft)  { step('side', siblings.length, -1); render(); return { consume: true }; }

      if (isEsc) {
        if (cursor.lane === 'none') return undefined;
        cursor = { lane: 'none', idx: 0 };
        render();
        return { consume: true };
      }

      // isEnter — focus the selected neighbor, if any; else normal submit.
      if (cursor.lane === 'none') return undefined; // nothing selected → submit
      const lane = cursor.lane === 'up' ? managers : cursor.lane === 'side' ? siblings : reports;
      const target = lane[cursor.idx];
      if (target !== undefined) focusTarget(target.id);
      cursor = { lane: 'none', idx: 0 };
      render();
      return { consume: true };
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  pi.on('session_start', (_event: any, ctx: ExtensionCtx): void => {
    ui = ctx.ui;

    // Register the spine-navigation key tap once. Double-guard against /reload
    // stacking (mirrors liveTimer): clear any previous tap before adding ours.
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
    try {
      if (typeof ctx.ui.onTerminalInput === 'function') {
        liveUnsub = ctx.ui.onTerminalInput(handleKey);
      }
    } catch {
      /* onTerminalInput unavailable (older pi / non-interactive) — chrome stays display-only */
    }

    scheduleRender();
  });

  pi.on('turn_end', (_event: any, _ctx: ExtensionCtx): void => {
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Background timer — ask-count polling + periodic refresh
  // -------------------------------------------------------------------------
  if (liveTimer !== undefined) clearInterval(liveTimer);

  const timer = setInterval((): void => {
    try {
      const fresh = fetchAskCount(nodeId);
      // Only repaint when the count actually changed — avoids constant flicker.
      if (fresh !== cachedAskCount) {
        cachedAskCount = fresh;
        scheduleRender();
      }
    } catch {
      /* timer is best-effort */
    }
  }, ASK_POLL_MS);

  // unref() so the timer doesn't keep the Node process alive after everything
  // else has finished — matches the inbox-watcher convention.
  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  // Clear on shutdown so a /reload never discovers a live sibling timer.
  pi.on('session_shutdown', (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
    if (liveUnsub !== undefined) { try { liveUnsub(); } catch { /* ignore */ } liveUnsub = undefined; }
  });
}

export default registerCanvasNav;
