// status-glyph.ts — the canonical status→glyph/color map + overlay resolution
// for the TS canvas-GRAPH surfaces (the ASCII forest `render.ts` and the
// interactive `browse/render.ts`). It replaces the copy-pasted STATUS_GLYPH /
// STATUS_COLOR literals those two files used to carry.
//
// SCOPE: only the surfaces the hanging-node feature touches. The workspace rail,
// feed/push roster, and attach chat-view keep their own glyph copies (out of
// scope). The portable `.mjs` canvas monitor view CANNOT import this (TS dist) —
// it carries its own mirrored map with a pointer back to error-stall.ts.
//
// OVERLAY PRECEDENCE: hanging > streaming > status. `hanging` and `streaming` are
// mutually exclusive in practice (hanging means the turn ended, so `busy` is
// gone) but the precedence is defined regardless.

import type { NodeStatus } from './types.js';
import { ERROR_STALL_QUIET_MS, type ErrorStall, type ErrorStallKind } from '../runtime/error-stall.js';

// ── Status glyphs (the mono, color-free primary encoding) ─────────────────────
export const STATUS_GLYPH: Record<NodeStatus, string> = {
  active:   '●',
  idle:     '○',
  done:     '✓',
  dead:     '✗',
  canceled: '⊘',
};

// ── Status hue: numeric SGR codes per status (lifted from browse/render.ts). ───
// Reinforces the glyph; the glyph SHAPE stays the NO_COLOR carrier.
export const STATUS_COLOR: Record<NodeStatus, number> = {
  active:   32, // green
  idle:     33, // yellow
  done:     36, // cyan
  dead:     31, // red
  canceled: 90, // grey (bright-black)
};

// ── Streaming overlay (genuinely mid-turn) — browse's existing statusRail visual.
const STREAMING_GLYPH = '⟳';
const STREAMING_COLOR = 92; // bright green (brighter than active-status green)

// ── Hanging overlay (parked on an exhausted-retry engine error). ──────────────
export const HANGING_GLYPH = '⚠';
export const HANGING_COLOR = 33; // yellow

/** Per-kind short label for a hanging node. The KIND is conveyed by the label,
 *  not by distinct glyphs (one glyph for all hanging). */
export function hangingLabel(kind: ErrorStallKind): string {
  switch (kind) {
    case 'rate-limit': return 'rate-limited';
    case 'overloaded': return 'overloaded';
    case 'connection': return 'conn error';
    default:           return 'errored';
  }
}

export interface NodeVisual {
  glyph: string;
  color: number;
  /** Overlay word (hanging kind label / 'live'); undefined for a plain status
   *  (the caller supplies its own status word). */
  word?: string;
  bold?: boolean;
}

/** Resolve a node's glyph + hue + overlay word, applying the precedence
 *  hanging > streaming > status. */
export function resolveNodeVisual(
  status: NodeStatus,
  opts: { streaming?: boolean; hanging?: ErrorStall | { kind: ErrorStallKind } | null },
): NodeVisual {
  if (opts.hanging != null) {
    return { glyph: HANGING_GLYPH, color: HANGING_COLOR, word: hangingLabel(opts.hanging.kind), bold: true };
  }
  if (opts.streaming === true) {
    return { glyph: STREAMING_GLYPH, color: STREAMING_COLOR, word: 'live', bold: true };
  }
  return { glyph: STATUS_GLYPH[status] ?? '?', color: STATUS_COLOR[status] };
}

/** Human countdown to the daemon's auto-recovery, from the stall's `since`
 *  origin: `auto-revive ~2m` (or `~45s` under a minute), clamped to `reviving…`
 *  once the grace has elapsed (the daemon recycles on its next ~2s tick). */
export function hangingCountdown(since: string, now: number = Date.now()): string {
  const start = Date.parse(since);
  if (Number.isNaN(start)) return 'reviving…';
  const remaining = ERROR_STALL_QUIET_MS - (now - start);
  if (remaining <= 0) return 'reviving…';
  if (remaining >= 60_000) return `auto-revive ~${Math.max(1, Math.round(remaining / 60_000))}m`;
  return `auto-revive ~${Math.ceil(remaining / 1000)}s`;
}
