// contract.ts — the view contract every `crtr view` module implements.
//
// A view is a self-contained ESM module whose DEFAULT export is a `ViewModule`.
// State is a single mutable object the view owns (mirrors browse/app.ts's
// BrowseState); hooks mutate it in place and return a `ViewAction` telling the
// host what to do next. The host injects `Draw` (from ./draw) + `ViewHost`; a
// view imports NOTHING from crtr internals.

import type { Key } from './terminal.js';
import type { Draw, Rect } from './draw.js';

export interface ViewManifest {
  id: string;            // unique key; MUST equal the view dir name; `crtr view run <id>`
  title: string;         // header chrome + picker
  description: string;   // picker + `crtr view list`
  refreshMs?: number;    // auto-poll cadence (monitor views); omit ⇒ on-demand (g) only
  keymap?: KeyHint[];    // footer hints + picker; e.g. { keys: 'j/k', label: 'move' }
}

export interface KeyHint { keys: string; label: string; }

export interface ViewHost {
  /** CLI flags forwarded verbatim, e.g. { port: '9222', target: '...' }. */
  readonly options: Readonly<Record<string, string>>;
  /** Transient status line (left of the footer): "Loading…", "Sent". */
  setStatus(msg: string | null): void;
  /** Sticky error/guidance banner above the footer; null clears it. */
  setError(msg: string | null): void;
}

export type ViewAction =
  | { type: 'render' }    // repaint now (sync state change)
  | { type: 'refresh' }   // run refresh() then repaint (host shows busy)
  | { type: 'quit' }      // leave the view
  | { type: 'none' };     // swallow, no repaint

export interface ViewKey { input: string; key: Key; }  // Key from core/tui/terminal

export interface ViewModule<S = unknown> {
  manifest: ViewManifest;
  /** Build initial state. CHEAP + synchronous-ish — no screen, no slow fetch.
   *  Slow data loads on the first refresh() so the host can paint a loading state. */
  init(host: ViewHost): S | Promise<S>;
  /** Fetch/poll. Mutates state in place. Host calls it on launch, on `refreshMs`,
   *  and whenever a hook returns { type:'refresh' }. The host runs it in the
   *  single-flight lane (busy indicator; never re-entrant). */
  refresh?(state: S, host: ViewHost): Promise<void>;
  /** Paint the view into `content` (the body rect, host chrome excluded).
   *  Pure: reads state, calls draw.*; returns nothing. NEVER writes ANSI. */
  render(state: S, draw: Draw, content: Rect): void;
  /** Handle one keystroke. Mutates state; returns the next action. May be async
   *  (open thread / send) — the host serializes async hooks in the single lane. */
  onKey?(k: ViewKey, state: S, host: ViewHost): ViewAction | Promise<ViewAction>;
  /** Static text for the non-TTY / piped path (exit 0). Snapshot of current state. */
  dump(state: S): string;
}
