// canvas-nav.ts — pi extension for pi-native canvas agent nodes.
//
// Renders nav chrome inside the node's pi editor:
//   ABOVE EDITOR  crtr-managers  ↑ reports up to: <name>(●) …  (or ↑ root)
//   ABOVE EDITOR  crtr-asks      ⚑ N waiting          (only when N > 0)
//   BELOW EDITOR  crtr-reports   ↓ reports: <name>(○) … · ctx <k>
//
// INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// Refresh triggers:
//   • session_start — initial paint once we have a ctx.ui handle
//   • turn_end      — statuses may have changed during the turn
//   • background timer (ASK_POLL_MS) — polls `crtr attention count` and
//     repaints whenever the count changes
//
// Double-timer prevention (copied from canvas-inbox-watcher):
//   `liveTimer` is module-level. A /reload re-enters this factory and clears
//   the previous interval before starting a new one — exactly one timer lives.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, subscribersOf, subscriptionsOf, jobDir } from '../core/canvas/index.js';
import type { NodeMeta, SubscriptionRef } from '../core/canvas/index.js';

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

/** Last-known ask count — cached across renders so the UI stays cheap. */
let cachedAskCount = 0;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const ASK_POLL_MS = 5_000;    // how often to shell out for ask count
const RENDER_DEBOUNCE_MS = 150; // coalesce rapid turn_end bursts

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

function statusGlyph(node: NodeMeta | null): string {
  if (node === null) return '?';
  switch (node.status) {
    case 'active': return '●';
    case 'idle':   return '○';
    case 'done':   return '✓';
    case 'dead':   return '✗';
    default:       return '?';
  }
}

// ---------------------------------------------------------------------------
// Cheap truncation — single-row, no pi-tui dep
// ---------------------------------------------------------------------------

function truncate(s: string, max = 180): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
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
    const raw = execFileSync('crtr', ['attention', 'count', '--node', nodeId], {
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
// Line builders
// ---------------------------------------------------------------------------

/** ↑ reports up to: <name>(●) …  or  ↑ root */
function buildManagersLines(nodeId: string): string[] {
  try {
    const managers: SubscriptionRef[] = subscribersOf(nodeId);
    if (managers.length === 0) return ['↑ root'];
    const parts = managers.map((ref) => {
      const node = getNode(ref.node_id);
      const name = node?.name ?? ref.node_id.slice(0, 8);
      return `${name}(${statusGlyph(node)})`;
    });
    return [truncate(`↑ reports up to: ${parts.join(' ')}`)];
  } catch {
    return [];
  }
}

/** ↓ reports: <name>(○) … · ctx <k>  or just  · ctx <k> when no reports */
function buildReportsLines(nodeId: string): string[] {
  try {
    // Drop finished/dead workers from the chrome — a terminal agent that has
    // done its job no longer needs a slot in the editor. Keep only live
    // reports (active | idle); done (✓) and dead (✗) fall off.
    const reports: SubscriptionRef[] = subscriptionsOf(nodeId).filter((ref) => {
      const s = getNode(ref.node_id)?.status;
      return s === 'active' || s === 'idle';
    });
    const tel = readTelemetry(nodeId);
    const ctxSuffix =
      tel.tokens_in != null && tel.tokens_in > 0
        ? `· ctx ${fmtTokens(tel.tokens_in)}`
        : '';

    if (reports.length === 0) {
      const line = ctxSuffix !== '' ? ctxSuffix : '↓ no reports';
      return [truncate(line)];
    }

    const parts = reports.map((ref) => {
      const node = getNode(ref.node_id);
      const name = node?.name ?? ref.node_id.slice(0, 8);
      return `${name}(${statusGlyph(node)})`;
    });

    const joined = parts.join(' ');
    const line = ctxSuffix !== '' ? `↓ reports: ${joined} ${ctxSuffix}` : `↓ reports: ${joined}`;
    return [truncate(line)];
  } catch {
    return [];
  }
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

  // -------------------------------------------------------------------------
  // Core render — pushes all three widgets in one pass
  // -------------------------------------------------------------------------
  const render = (): void => {
    if (ui === undefined) return;
    try {
      // ↑ managers row
      const managersLines = buildManagersLines(nodeId);
      ui.setWidget(
        'crtr-managers',
        managersLines.length > 0 ? managersLines : undefined,
        { placement: 'aboveEditor' },
      );

      // ⚑ pending asks — omit widget entirely when count is 0
      ui.setWidget(
        'crtr-asks',
        cachedAskCount > 0 ? [`⚑ ${cachedAskCount} waiting`] : undefined,
        { placement: 'aboveEditor' },
      );

      // ↓ reports row
      const reportsLines = buildReportsLines(nodeId);
      ui.setWidget(
        'crtr-reports',
        reportsLines.length > 0 ? reportsLines : undefined,
        { placement: 'belowEditor' },
      );
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

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  pi.on('session_start', (_event: any, ctx: ExtensionCtx): void => {
    ui = ctx.ui;
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
  });
}

export default registerCanvasNav;
