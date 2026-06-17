import { create } from "zustand";

/** Server-bridge (SPA↔server WS) connectivity, surfaced to the global
 * ReconnectingBanner (spec §7 server-restart). The stores push into it via
 * `useServerStatus.getState().setReachable(...)`; the banner reads the hook. */
interface ServerStatusState {
  reachable: boolean;
  setReachable: (reachable: boolean) => void;
}

export const useServerStatus = create<ServerStatusState>((set) => ({
  reachable: true,
  setReachable: (reachable) => set({ reachable }),
}));
