// runtime.tsx — the framework-agnostic dispatch-loop STORE for a dual-target
// view. It is what <ViewPane>/useViewCore (ViewPane.tsx) are built from.
//
// createViewStore() seeds state from core.init, builds the IntentCtx
// (set/resolve/execute/signal/dispatch) over the HTTP transport (→ the local
// bridge), runs the dispatch loop with the busy-guarded refreshMs auto-poll, and
// exposes a tiny external-store surface (subscribe/getVersion) the React layer
// binds via useSyncExternalStore. The core it drives is byte-identical to the
// TUI's; only the injected Transport differs.
//
// THE TAP: dispatch calls `onIntent(name, payload, state)` BEFORE delegating to
// core.intents[name]. This is the host-level pre-dispatch hook the shell uses to
// observe/intercept semantic intents (e.g. canvas `activate` → open a
// conversation). When onIntent is undefined the loop is byte-identical to the
// pre-shell behavior — a view in a ViewPane is unaware it is in a shell.
//
// THE SEAM (Wave 3): store.refresh() forces an immediate, busy-guarded refresh.
// It is both the auto-poll callback AND the entry point the shell calls when an
// SSE `/__crtr/events` invalidation arrives — event-driven refresh with no
// contract change (the view still just runs its `refresh` intent).

import type { ViewCore, IntentCtx, ChromeState, HostSignals, Source, Command, Result } from '../core/view/contract.js';
import { initialChrome } from '../core/view/chrome.js';
import { createHttpTransport } from './transport-http.js';

/** Host-level pre-dispatch hook: observes every dispatched intent + its payload
 *  against a snapshot of state, before the view's own handler runs. The shell
 *  taps the small documented shell-intent vocabulary (`activate`, `open`) and
 *  lets everything else pass through untouched. */
export type IntentTap = (name: string, payload: unknown, state: unknown) => void;

export interface ViewStoreOptions {
  /** Frozen options map handed to core.init (e.g. forwarded --target). */
  options?: Record<string, string>;
  /** Bridge endpoint for the HTTP transport; defaults to /__crtr/source. */
  endpoint?: string;
  /** The host TAP (§5). Omit ⇒ standalone, byte-identical to no shell. */
  onIntent?: IntentTap;
}

export interface ViewStore {
  /** Snapshot of the current view state (read after a subscribe fires). */
  getState(): unknown;
  /** Snapshot of the current chrome record. */
  getChrome(): ChromeState;
  /** Dispatch a named intent — runs the TAP, then the core handler. */
  dispatch(intent: string, payload?: unknown): Promise<void>;
  /** Force an immediate, busy-guarded refresh (auto-poll cb + the SSE seam). */
  refresh(): void;
  /** External-store subscribe (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  /** Monotonic version the external store snapshots on. */
  getVersion(): number;
  /** Run the first refresh + start the refreshMs auto-poll. Idempotent. */
  start(): void;
  /** Stop the auto-poll. Idempotent. */
  stop(): void;
  /** The host TAP — mutable so the React layer keeps it fresh per render
   *  WITHOUT restarting the store. */
  onIntent?: IntentTap;
}

/** Build the running store for one view (its core + the HTTP transport). The
 *  React layer (useViewCore) owns lifecycle (start on mount, stop on unmount)
 *  and re-renders off subscribe/getVersion; this factory is React-free. */
export function createViewStore(core: ViewCore, opts: ViewStoreOptions = {}): ViewStore {
  const transport = createHttpTransport(opts.endpoint);

  let state: unknown = core.init(Object.freeze({ ...(opts.options ?? {}) }));
  let chrome: ChromeState = initialChrome();
  let onIntentTap: IntentTap | undefined = opts.onIntent;

  // External store: a version counter the React tree subscribes to. state and
  // chrome are read via the getters on each render; bumping `version` re-renders.
  let version = 0;
  const listeners = new Set<() => void>();
  const emit = (): void => { version += 1; for (const l of listeners) l(); };
  const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

  const setChrome = (patch: Partial<ChromeState>): void => { chrome = { ...chrome, ...patch }; emit(); };

  const signal: HostSignals = {
    setStatus: (msg) => setChrome({ status: msg }),
    setBanner: (msg, level) => setChrome({ banner: { msg, level } }),
    clearBanner: () => setChrome({ banner: null }),
    setSubtitle: (s) => setChrome({ subtitle: s }),
    setMode: (mode) => setChrome({ mode }),
    // Web has no pane to leave; closing the tab is up to the user. No-op.
    quit: () => { /* web: no-op */ },
  };

  const makeCtx = (): IntentCtx<unknown> => ({
    get state() { return state; },
    set(next) {
      state = typeof next === 'function' ? (next as (p: unknown) => unknown)(state) : next;
      emit();
    },
    async resolve<T, A>(source: Source<T, A>, args?: A): Promise<Result<T>> {
      const raw = await transport.send(source.request(args as A));
      return source.parse(raw);
    },
    async execute<T, A>(command: Command<T, A>, args?: A): Promise<Result<T>> {
      const raw = await transport.send(command.request(args as A));
      return command.parse(raw);
    },
    signal,
    dispatch,
  });

  // busyDepth counts in-flight async intents — it drives the "working" chip /
  // spinner. It is NOT itself the single-flight lane; the auto-poll guards on it
  // (refresh() below) so a bridge slower than refreshMs can never stack
  // overlapping refreshes that race on ctx.set. The first completed *refresh*
  // marks the view loaded (ready vs idle in deriveState) — a non-refresh async
  // intent before that must not flip the chip to ready.
  let busyDepth = 0;

  async function dispatch(intent: string, payload?: unknown): Promise<void> {
    // THE TAP — the shell observes (and may act on) every intent against a
    // snapshot of state BEFORE the view's own handler runs. Standalone (no tap)
    // this is a no-op and the loop is byte-identical to the pre-shell behavior.
    onIntentTap?.(intent, payload, state);

    const fn = core.intents[intent];
    if (!fn) {
      // eslint-disable-next-line no-console
      console.warn(`[crtr view] unknown intent: ${intent}`);
      return;
    }
    const result = fn(makeCtx(), payload);
    if (result instanceof Promise) {
      busyDepth += 1;
      setChrome({ busy: true });
      try {
        await result;
      } finally {
        busyDepth -= 1;
        const loaded = chrome.loaded || intent === 'refresh';
        chrome = { ...chrome, busy: busyDepth > 0, loaded, lastRefresh: Date.now() };
        emit();
      }
    }
  }

  // Auto-poll cadence guard AND the shell's invalidate seam: skip while any
  // async intent is still in flight so refreshes never stack.
  const refresh = (): void => { if (busyDepth === 0) void dispatch('refresh'); };

  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (started) return;
    started = true;
    // init → render (the React layer) → first refresh, then optional auto-poll.
    void dispatch('refresh');
    const cadence = core.manifest.refreshMs;
    if (typeof cadence === 'number' && cadence > 0) timer = setInterval(refresh, cadence);
  }

  function stop(): void {
    started = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    getState: () => state,
    getChrome: () => chrome,
    dispatch,
    refresh,
    subscribe,
    getVersion: () => version,
    start,
    stop,
    get onIntent() { return onIntentTap; },
    set onIntent(v: IntentTap | undefined) { onIntentTap = v; },
  };
}
