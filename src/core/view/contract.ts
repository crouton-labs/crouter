// contract.ts — the dual-target view contract (portable core + thin presenters).
//
// One view definition renders to two targets — the tmux TUI (`crtr view run`)
// and a React+Tailwind web page (`crtr view serve`) — from ONE portable core.
// On disk a view is a directory of up to four files, each loaded only by the
// runtime that can execute it:
//
//   <view>/
//     core.mjs   REQUIRED  manifest · init · sources · commands · intents.
//                          Runs in BOTH Node and the browser. Imports NOTHING —
//                          no `node:*`, no crtr. Pure JS + the injected ctx.
//     tui.mjs    optional  render(state, draw, content) + keymap   (Node only)
//     web.jsx    optional  default React component (Tailwind)      (browser only)
//     text.mjs   optional  dump(state, ctx) for the piped path     (Node only)
//
// The invariant: ALL state + ALL behavior live in the core; presenters are pure
// reads of state that emit named intents. It is enforced structurally — only
// `core.mjs` ever sees a mutating `IntentCtx`; presenters receive `state` plus a
// `dispatch`/`keymap` that names intents, so a presenter has no path to data or
// logic.

import type { Draw, Rect } from '../tui/draw.js';

// ── Manifest ────────────────────────────────────────────────────────────────

export interface ViewManifest {
  id: string;            // unique key; MUST equal the view dir name; `crtr view run <id>`
  title: string;         // header chrome + picker
  subtitle?: string;     // optional muted subtitle after the title
  description: string;   // picker + `crtr view list`
  refreshMs?: number;    // view-wide auto-poll cadence; omit ⇒ on-demand only
  // NOTE: no `keymap` here — footer hints come from the tui keymap bindings'
  // `hint` field (single source of truth, no drift).
}

// ── Chrome signals (shared vocabulary, target-specific rendering) ───────────

/** Severity of a {@link HostSignals.setBanner} banner — drives glyph + hue and
 *  the derived state chip (error→blocked, action→attention, info→neutral). */
export type BannerLevel = 'info' | 'action' | 'error';

export interface Banner { msg: string; level: BannerLevel; }

/** Optional host context passed to the text presenter's dump on the piped path. */
export interface DumpContext { banner: Banner | null; }

/** Semantic chrome signals the core raises; each target renders them in its own
 *  idiom (TUI footer/banner/title-chip vs web status line/alert bar/pill). */
export interface HostSignals {
  setStatus(msg: string | null): void;
  setBanner(msg: string, level: BannerLevel): void;
  clearBanner(): void;
  setSubtitle(s: string | null): void;
  /** Interaction-mode chip override (compose/react); null returns to derived. */
  setMode(mode: string | null): void;
  /** TUI: leave the pane; web: no-op/close tab. */
  quit(): void;
}

/** The host-tracked chrome record both targets render. */
export interface ChromeState {
  status: string | null;
  banner: Banner | null;
  subtitle: string | null;
  mode: string | null;
  busy: boolean;
  loaded: boolean;       // a refresh has completed at least once ⇒ ready vs idle
  lastRefresh: number;   // epoch ms of the last refresh
}

// ── Sources, commands, transport (the cloud seam) ───────────────────────────

/** A transport-agnostic request descriptor the host fulfills. The core never
 *  executes anything itself — it describes WHAT to run/read/fetch and the
 *  host's Transport decides HOW (local exec today, a cloud endpoint later). */
export type SourceRequest =
  | { kind: 'exec'; bin: string; args: string[]; cwd?: string; stdin?: string }
  | { kind: 'file'; path: string }
  | { kind: 'http'; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; headers?: Record<string, string>; body?: string };

export interface RawResponse {
  ok: boolean;          // transport-level success (spawned / connected, no I/O error)
  exitCode?: number;    // exec
  status?: number;      // http
  stdout: string;       // exec stdout · file contents · http body
  stderr: string;       // exec stderr · file/http error text
}

/** Typed error with a render-ready display. Presenters render `display`
 *  VERBATIM and never branch on `kind` (the view-internal taxonomy). */
export interface SourceError {
  kind: string;
  display: {
    headline: string;
    explanation: string;
    nextStep: string;
    level: BannerLevel;
    blocking: boolean;  // true ⇒ whole-view takeover; false ⇒ degrade one section
  };
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SourceError };

/** A READ: declarative descriptor + pure parse + optional cadence. Resolved by
 *  the host through its Transport via `ctx.resolve(source, args)`. */
export interface Source<T, A = void> {
  id: string;
  request(args: A): SourceRequest;       // NO node imports — just a spec
  parse(raw: RawResponse): Result<T>;    // pure: bytes → typed data | typed error
  refreshMs?: number;                    // optional per-source cadence override
}

/** A WRITE: same {request, parse} pair, no cadence — invoked by an intent via
 *  `ctx.execute(command, args)`. */
export interface Command<T, A = void> {
  id: string;
  request(args: A): SourceRequest;
  parse(raw: RawResponse): Result<T>;
}

// ── Intents — the one behavior model for both targets ───────────────────────

/** A semantic action. State updates are immutable via `ctx.set`; async effects
 *  (transport calls) live in the same handler — a thunk, not a pure reducer.
 *  Sync intents call `ctx.set` once; async intents `await ctx.resolve/execute`
 *  between `set`s. The host serializes async intents in its single-flight lane. */
export type Intent<S, P = void> = (ctx: IntentCtx<S>, payload: P) => void | Promise<void>;

export interface IntentCtx<S> {
  /** Snapshot of state at read time. */
  readonly state: S;
  /** Immutable update → triggers a re-render. Value or (prev)=>next fn. */
  set(next: S | ((prev: S) => S)): void;
  /** Run a READ source through the host's transport → typed Result. */
  resolve<T, A>(source: Source<T, A>, args?: A): Promise<Result<T>>;
  /** Run a WRITE command through the host's transport → typed Result. */
  execute<T, A>(command: Command<T, A>, args?: A): Promise<Result<T>>;
  /** Semantic chrome signals (status/banner/subtitle/mode/quit). */
  signal: HostSignals;
  /** Chain another intent by name. */
  dispatch(intent: string, payload?: unknown): Promise<void>;
}

// ── The portable core (core.mjs default export) ─────────────────────────────

export interface ViewCore<S = unknown> {
  manifest: ViewManifest;
  /** Cheap, synchronous initial state. No fetch, no screen. The host mounts,
   *  paints a loading frame, then dispatches the first 'refresh'. */
  init(opts: Readonly<Record<string, string>>): S;
  /** Declarative READ dependencies the host resolves through the transport. */
  sources?: Record<string, Source<any, any>>;
  /** WRITE descriptors invoked from intents. */
  commands?: Record<string, Command<any, any>>;
  /** Semantic actions. Both presenters emit these. */
  intents: Record<string, Intent<S, any>>;
}

// ── TUI presenter (tui.mjs) ─────────────────────────────────────────────────

export interface KeyHint { keys: string; label: string; }

export type KeyBinding<S> =
  | {
      keys: string[];                    // e.g. ['j','down']
      intent: string;
      payload?: (state: S) => unknown;   // e.g. bind select to the cursor row
      when?: (state: S) => boolean;      // gate by mode
      hint?: KeyHint;                    // footer hint
    }
  | {
      /** Text-capture binding: while `when(state)` is true the host runs a
       *  built-in line-edit buffer over raw printable/backspace keys and
       *  dispatches `capture` with the next draft value on each edit. */
      capture: string;                   // intent name, dispatched as capture(nextDraft)
      when: (state: S) => boolean;
      hint?: KeyHint;
    };

export interface TuiPresenter<S = unknown> {
  /** Pure read of state, paints via draw.*; never ANSI. */
  render(state: S, draw: Draw, content: Rect): void;
  /** Pure input→intent mapping. */
  keymap: KeyBinding<S>[];
}

// ── Web presenter (web.jsx) ─────────────────────────────────────────────────

/** Props handed to web.jsx's default-export React component. The component is a
 *  pure function of state; DOM events call `dispatch`. (Typed loosely here so
 *  the core contract carries no React type dependency.) */
export interface ViewProps<S = unknown> {
  state: S;
  dispatch: (intent: string, payload?: unknown) => void;
  chrome: ChromeState;
}

export type WebPresenter<S = unknown> = (props: ViewProps<S>) => unknown;

// ── Text presenter (text.mjs) ───────────────────────────────────────────────

export interface TextPresenter<S = unknown> {
  /** Static text for the non-TTY / piped path. Snapshot of current state. */
  dump(state: S, ctx?: DumpContext): string;
}

// ── Result helpers (re-exported for view authors' convenience in tests) ─────

export function ok<T>(data: T): Result<T> { return { ok: true, data }; }
export function fail<T = never>(error: SourceError): Result<T> { return { ok: false, error }; }
