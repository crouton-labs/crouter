// ViewPane.tsx — the React surface for a dual-target view. <ViewPane> and its
// useViewCore hook are the composable replacement for the deleted imperative
// mount(): the shell hosts many views as ordinary React components instead of
// imperative createRoot calls.
//
// useViewCore wraps a createViewStore (runtime.tsx) — the framework-free dispatch
// loop — with the React lifecycle: it creates the store once (a ref), keeps the
// onIntent TAP fresh per render WITHOUT restarting, re-renders off the store's
// external-store surface (useSyncExternalStore), and starts/stops the auto-poll
// on mount/unmount.
//
// <ViewPane> = useViewCore + <ViewChrome> + the view's web component. When
// onIntent is undefined a ViewPane is byte-identical to the old standalone mount
// — the hosted view never knows it is in a shell.

import { createElement, useEffect, useRef, useSyncExternalStore } from 'react';
import type { JSX, FunctionComponent } from 'react';
import type { ViewCore, ChromeState } from '../core/view/contract.js';
import { ViewChrome } from './ViewChrome.js';
import { createViewStore, type IntentTap, type ViewStore } from './runtime.js';

type ViewPropsWeb = { state: unknown; dispatch: (intent: string, payload?: unknown) => void; chrome: ChromeState };
type WebComponent = FunctionComponent<ViewPropsWeb>;

export interface UseViewCoreOptions {
  /** Frozen options map handed to core.init. */
  options?: Record<string, string>;
  /** Bridge endpoint for the HTTP transport; defaults to /__crtr/source. */
  endpoint?: string;
  /** The host TAP (§5): observe/intercept dispatched intents. */
  onIntent?: IntentTap;
}

export interface ViewCoreHandle {
  state: unknown;
  chrome: ChromeState;
  dispatch: (intent: string, payload?: unknown) => void;
  /** Force an immediate refresh — the seam the shell calls on an SSE
   *  invalidation (Wave 3). */
  refresh: () => void;
}

/** Run a view core client-side and bind it to React. Returns the live state +
 *  chrome + a dispatch (and a refresh seam). The onIntent tap is read fresh on
 *  every render, so a parent can change it without tearing down the view. */
export function useViewCore(core: ViewCore, opts: UseViewCoreOptions = {}): ViewCoreHandle {
  const storeRef = useRef<ViewStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createViewStore(core, { options: opts.options, endpoint: opts.endpoint });
  }
  const store = storeRef.current;

  // Keep the TAP fresh without recreating the store (which would restart the
  // dispatch loop and lose state).
  store.onIntent = opts.onIntent;

  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  return {
    state: store.getState(),
    chrome: store.getChrome(),
    dispatch: store.dispatch,
    refresh: store.refresh,
  };
}

/** Host any dual-target view as a React component: its web component wrapped in
 *  <ViewChrome>, driven by useViewCore. Pass onIntent to tap its intents. */
export function ViewPane(
  { core, View, options, endpoint, onIntent }: {
    core: ViewCore;
    View: WebComponent;
    options?: Record<string, string>;
    endpoint?: string;
    onIntent?: IntentTap;
  },
): JSX.Element {
  const { state, chrome, dispatch } = useViewCore(core, { options, endpoint, onIntent });
  return (
    <ViewChrome chrome={chrome} title={core.manifest.title}>
      {createElement(View, { state, dispatch, chrome })}
    </ViewChrome>
  );
}
