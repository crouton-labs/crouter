// chrome.ts — portable chrome-state derivation shared by both targets.
//
// The TUI's drawChrome and the web's <ViewChrome> both derive the one state
// chip from the same host signals via deriveState, so the two targets never
// drift on what "blocked" / "working" / "ready" mean.

import type { ChromeState } from './contract.js';

export type ChipState = 'working' | 'blocked' | 'attention' | 'ready' | 'idle';

/** Derive the state chip from host signals: busy→working, error banner→blocked,
 *  action banner→attention, else ready (once loaded) / idle. An info banner does
 *  not block. An explicit interaction mode (setMode) overrides the chip — that
 *  precedence is applied by each target's chrome renderer, not here. */
export function deriveState(c: ChromeState): ChipState {
  if (c.busy) return 'working';
  if (c.banner?.level === 'error') return 'blocked';
  if (c.banner?.level === 'action') return 'attention';
  return c.loaded ? 'ready' : 'idle';
}

/** A fresh chrome record (the shape both hosts start from). */
export function initialChrome(): ChromeState {
  return { status: null, banner: null, subtitle: null, mode: null, busy: false, loaded: false, lastRefresh: 0 };
}
