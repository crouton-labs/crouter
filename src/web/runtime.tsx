// runtime.tsx — the browser mount for a dual-target view. Vite bundles this
// together with a view's core.mjs + web.jsx; the generated entry calls mount().
//
// mount() runs the portable core CLIENT-SIDE: it seeds state from core.init,
// builds the IntentCtx (set/resolve/execute/signal/dispatch) over the HTTP
// transport (→ the local bridge), runs the dispatch loop, and renders the
// view's default React component wrapped in <ViewChrome>. The core is byte-
// identical to the TUI's; only the injected Transport differs.
//
// Mount sequence (per the contract): init → render → dispatch('refresh').

import { createRoot } from 'react-dom/client';
import { createElement, useSyncExternalStore } from 'react';
import type { JSX, FunctionComponent } from 'react';
import type { ViewCore, IntentCtx, ChromeState, HostSignals, Source, Command, Result } from '../core/view/contract.js';
import { initialChrome } from '../core/view/chrome.js';
import { createHttpTransport } from './transport-http.js';
import { ViewChrome } from './ViewChrome.js';

export interface MountOptions {
  /** Frozen options map handed to core.init (e.g. forwarded --target). */
  options?: Record<string, string>;
  /** DOM node to mount into; defaults to #root. */
  container?: HTMLElement;
  /** Bridge endpoint for the HTTP transport; defaults to /__crtr/source. */
  endpoint?: string;
}

type ViewPropsWeb = { state: unknown; dispatch: (intent: string, payload?: unknown) => void; chrome: ChromeState };
type WebComponent = FunctionComponent<ViewPropsWeb>;

/** Mount a view (its core + web component) into the page. Returns nothing —
 *  the page now owns the running view until it is closed. */
export function mount(core: ViewCore, View: WebComponent, opts: MountOptions = {}): void {
  const transport = createHttpTransport(opts.endpoint);

  let state: unknown = core.init(Object.freeze({ ...(opts.options ?? {}) }));
  let chrome: ChromeState = initialChrome();

  // External store: a version counter the React tree subscribes to. state and
  // chrome are read from closure on each render; bumping `version` re-renders.
  let version = 0;
  const listeners = new Set<() => void>();
  const emit = (): void => { version += 1; for (const l of listeners) l(); };
  const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const getVersion = (): number => version;

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
  // (below) so a bridge slower than refreshMs can never stack overlapping
  // refreshes that race on ctx.set. The first completed *refresh* marks the
  // view loaded (ready vs idle in deriveState) — a non-refresh async intent
  // before that must not flip the chip to ready.
  let busyDepth = 0;

  async function dispatch(intent: string, payload?: unknown): Promise<void> {
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

  /** Auto-poll cadence guard: skip a tick while any async intent is still in
   *  flight so refreshes never stack. */
  const pollRefresh = (): void => { if (busyDepth === 0) void dispatch('refresh'); };

  function App(): JSX.Element {
    useSyncExternalStore(subscribe, getVersion, getVersion);
    return (
      <ViewChrome chrome={chrome} title={core.manifest.title}>
        {createElement(View, { state, dispatch, chrome })}
      </ViewChrome>
    );
  }

  const container = opts.container ?? document.getElementById('root');
  if (!container) throw new Error('crtr view runtime: no #root container to mount into');
  createRoot(container).render(<App />);

  // init → render (above) → first refresh, then optional auto-poll.
  void dispatch('refresh');
  const cadence = core.manifest.refreshMs;
  if (typeof cadence === 'number' && cadence > 0) {
    setInterval(pollRefresh, cadence);
  }
}
