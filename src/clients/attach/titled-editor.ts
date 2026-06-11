// titled-editor.ts — the `crtr attach` input editor with two bits of chrome pi's
// stock editor doesn't give us:
//   1. the session name painted INTO the top border as a solid-background chip,
//      so it stays pinned to the editor instead of scrolling off as a free badge;
//   2. a border color that tracks the agent's thinking level (set by attach-cmd
//      on each state update), mirroring pi's `getThinkingBorderColor`.
// Both are pure render-layer chrome; nothing here touches the socket or session.

import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** Thinking levels pi cycles through (shift+tab), lowest → highest budget. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Per-level border SGR codes — a cool→warm ramp as the budget climbs. pi paints
 *  these from dedicated `thinking*` theme colors that are NOT on its public
 *  palette surface, so we map to standard ANSI hues; `off` falls back to the
 *  caller's default border color. The point is a visible, distinct per-level cue. */
const THINKING_SGR: Record<ThinkingLevel, number | undefined> = {
  off: undefined, // default border color
  minimal: 34, // blue
  low: 36, // cyan
  medium: 32, // green
  high: 33, // yellow
  xhigh: 35, // magenta
};

/** Resolve the editor border colorizer for a thinking level. Unknown / `off` →
 *  the supplied `fallback` (the theme's default border color). */
export function thinkingBorderColor(
  level: string | undefined,
  fallback: (s: string) => string,
): (s: string) => string {
  const sgr = level === undefined ? undefined : THINKING_SGR[level as ThinkingLevel];
  if (sgr === undefined) return fallback;
  return (s: string) => `\x1b[${sgr}m${s}\x1b[39m`;
}

export class TitledEditor extends CustomEditor {
  /** Session-name chip painted into the LEFT of the top border. Empty → plain. */
  title = '';
  /** Pre-styled context string painted into the RIGHT of the top border (cwd /
   *  branch / git status). Already colorized by the caller; empty → omitted. */
  info = '';
  /** Paint the chip solid (reverse video + a space of padding each side) so the
   *  name reads as a label sitting on the border rule. Override-able for tests. */
  titleStyle: (s: string) => string = (s) => `\x1b[7m ${s} \x1b[27m`;

  render(width: number): string[] {
    const lines = super.render(width);
    if ((this.title || this.info) && lines.length > 0) {
      const chip = this.title ? this.titleStyle(truncateToWidth(this.title, Math.max(1, width - 4), '…')) : '';
      const chipW = visibleWidth(chip);
      // The info chip yields to the name chip when the rule is narrow.
      const info = this.info && chipW + 4 < width ? this.info : '';
      const infoW = visibleWidth(info);
      const fill = Math.max(0, width - chipW - infoW);
      // Replace the stock top border with: solid chip + border rule + info, all
      // dashes in the current (thinking-aware) border color.
      lines[0] = chip + this.borderColor('─'.repeat(fill)) + info;
    }
    return lines;
  }
}
