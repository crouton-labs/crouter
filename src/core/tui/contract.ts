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
  subtitle?: string;     // optional dim ` · <subtitle>` after the title (e.g. "3 unread")
  description: string;   // picker + `crtr view list`
  refreshMs?: number;    // auto-poll cadence (monitor views); omit ⇒ on-demand (g) only
  keymap?: KeyHint[];    // footer hints + picker; e.g. { keys: 'j/k', label: 'move' }
}

export interface KeyHint { keys: string; label: string; }

/** Severity of a {@link ViewHost.setBanner} banner — drives glyph + hue + the
 *  derived state chip (error→blocked/red, action→attention/yellow, info→neutral). */
export type BannerLevel = 'info' | 'action' | 'error';

/** The current host banner, threaded into {@link ViewModule.dump} so the static
 *  (non-TTY) path can surface guidance without the view mirroring it into state. */
export interface Banner { msg: string; level: BannerLevel; }

/** Optional host context passed to {@link ViewModule.dump} on the piped path. */
export interface DumpContext { banner: Banner | null; }

export interface ViewHost {
  /** CLI flags forwarded verbatim, e.g. { port: '9222', target: '...' }. */
  readonly options: Readonly<Record<string, string>>;
  /** Transient status line (left of the footer): "Loading…", "Sent". */
  setStatus(msg: string | null): void;
  /** Severity-coded guidance banner above the footer (info/action/error). The
   *  level drives the banner glyph + hue AND the derived title state chip. */
  setBanner(msg: string, level: BannerLevel): void;
  /** Sticky error banner above the footer; null clears. Back-compat shorthand
   *  for setBanner(msg, 'error'). */
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
  /** Static text for the non-TTY / piped path (exit 0). Snapshot of current
   *  state. The host threads its current banner via the optional `ctx` so a view
   *  can surface guidance without mirroring it into state (older views ignore the
   *  arg and read their own state). */
  dump(state: S, ctx?: DumpContext): string;
}
