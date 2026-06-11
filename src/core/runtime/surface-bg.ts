// surface-bg.ts — the "distinct popup surface" background, theme-derived.
//
// crtr's overlays and popups must read as a SEPARATE surface from the normal one
// (CTO ruling, taste/inline-ui-placement #11): a popup whose background matches
// the surface has invisible edges, so you can't tell where the float begins. We
// paint them with the active pi theme's `selectedBg` role — theme-derived, so it
// adapts to light/dark and is ONE centralized knob, not a scattered hardcode.
//
// pi 0.79 does not re-export `selectedBg` through its public API (the `.` entry
// omits `getResolvedThemeColors` and the live `theme` singleton). It DOES publish
// the live `Theme` instance on a process-global symbol once `initTheme()` has run
// — the same hook pi's own SDK reads (see broker.ts `ctx.ui.theme`). We read it
// there and use the public `Theme.bg()` / `Theme.getBgAnsi()` methods.
//
// CRITICAL: this module must NOT statically import `@earendil-works/pi-coding-agent`
// — that package costs ~400ms to load and would land on the cold `crtr` front
// door (which never otherwise loads pi). We only READ the process-global symbol;
// any process that needs styling (the attach viewer, a node's broker) has already
// called `initTheme()` and populated it. Where the symbol is absent (the front
// door, before it execs into the themed `crtr attach`), the tmux helpers return
// no style args and the chrome stays at its default — the viewer re-themes it.

import type { Theme } from '@earendil-works/pi-coding-agent';

const THEME_SYMBOL = Symbol.for('@earendil-works/pi-coding-agent:theme');

/** The live pi Theme if a process has already run `initTheme()`, else undefined.
 *  Read-only: never initializes (that would pull pi into the front door). */
function liveTheme(): Theme | undefined {
  const t = (globalThis as Record<symbol, unknown>)[THEME_SYMBOL];
  return (t ?? undefined) as Theme | undefined;
}

/** The SGR escape that turns ON the distinct-surface background (theme
 *  `selectedBg`), e.g. `\x1b[48;2;58;58;74m`. Pair with `\x1b[49m` to reset just
 *  the background. Throws if no process has initialized the theme — callers on a
 *  render path (the attach overlay) always have, by construction. */
export function surfaceBgAnsi(): string {
  const t = liveTheme();
  if (t === undefined) throw new Error('surfaceBgAnsi: pi theme not initialized in this process');
  return t.getBgAnsi('selectedBg');
}

/** The distinct-surface background as a tmux colour token (`#rrggbb` on a
 *  truecolor theme, `colourN` on a 256-colour theme), or undefined when the theme
 *  is not yet loaded in this process OR defines no selection background. tmux
 *  cannot read pi's theme, so we translate the SGR pi resolved for us. */
function surfaceBgTmux(): string | undefined {
  const t = liveTheme();
  if (t === undefined) return undefined;
  const ansi = t.getBgAnsi('selectedBg');
  const tc = /48;2;(\d+);(\d+);(\d+)/.exec(ansi);
  if (tc !== null) {
    const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
    return `#${hex(tc[1]!)}${hex(tc[2]!)}${hex(tc[3]!)}`;
  }
  const c256 = /48;5;(\d+)/.exec(ansi);
  if (c256 !== null) return `colour${c256[1]}`;
  return undefined; // empty/default selectedBg → nothing distinct to paint
}

/** tmux flags that frame a `display-menu` / `display-popup` on the distinct
 *  surface background — a rounded border + the surface bg on the body and border.
 *  Empty when the theme is unavailable in this process (chrome stays default; the
 *  attach viewer re-installs the menu with these once it has themed). One knob:
 *  every crtr tmux float shares this single definition. */
export function surfaceTmuxStyleArgs(): string[] {
  const bg = surfaceBgTmux();
  if (bg === undefined) return [];
  return ['-b', 'rounded', '-s', `bg=${bg}`, '-S', `bg=${bg}`];
}
