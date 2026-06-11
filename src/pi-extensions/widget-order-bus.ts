// widget-order-bus.ts — a tiny in-process bus that lets canvas-recap keep its
// recap widget pinned ABOVE canvas-nav's manager line.
//
// Why this exists: pi's interactive widget store (and the broker's relay) is
// insertion-ordered, and re-setting an existing widget key moves it to the END
// (bottom) — see interactive-mode.js `setExtensionWidget` (delete+set). So the
// LAST extension to call setWidget for an aboveEditor key renders closest to the
// editor. canvas-recap only paints during idle, when canvas-nav has not re-set
// `crtr-managers` for a long time, so a naive recap setWidget lands BELOW the
// manager line. The fix: after canvas-recap changes its widget, it asks
// canvas-nav to re-assert `crtr-managers`, which re-inserts that key after
// `crtr-recap` and so drops it below the recap — making the recap the topmost
// chrome.
//
// Both extensions load in the SAME pi process, so this module is a shared
// singleton via Node's module cache. No @earendil-works/* imports — compiles in
// crouter's own tsc build.

/** canvas-nav registers its re-render here on session_start; canvas-recap calls
 *  requestNavRerender() after it shows/clears the recap so the manager line
 *  re-inserts (and thus orders) below the recap widget. */
let navRerender: (() => void) | undefined;

/** Called by canvas-nav (once per session_start) to expose its scheduleRender. */
export function onNavRerender(cb: () => void): void {
  navRerender = cb;
}

/** Called by canvas-recap after it sets/clears `crtr-recap` to nudge canvas-nav
 *  to re-assert `crtr-managers` below it. No-op if nav has not registered (e.g.
 *  nav inert, or recap-only test harness). */
export function requestNavRerender(): void {
  try { navRerender?.(); } catch { /* best-effort */ }
}
