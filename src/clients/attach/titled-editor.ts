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

/** Per-level border/chip color as a 24-bit RGB triple — ONE blue-violet hue at
 *  CONSTANT perceived lightness (luma ≈ 120) whose SATURATION alone climbs with
 *  the budget: a near-gray blue at `minimal` deepening to a vivid violet at
 *  `xhigh`, never getting lighter or darker — only more colorful. (pi paints its
 *  own `thinking*` theme colors off its public palette surface, so we own this
 *  ramp directly — truecolor, not the 16-color ANSI hues, so the saturation
 *  climb actually reads.) `off` falls back to the caller's default border color. */
const THINKING_RGB: Record<ThinkingLevel, [number, number, number] | undefined> = {
  off: undefined, // default border color
  minimal: [125, 115, 135], // near-gray blue-violet
  low: [129, 109, 151], // muted blue-violet
  medium: [134, 103, 168], // violet
  high: [139, 98, 184], // deeper violet
  xhigh: [144, 92, 200], // vivid violet
};

/** The default (thinking `off`) title chip: reverse video + a space of padding
 *  each side, so the name reads as a label sitting on the border rule. Used as
 *  the fallback when no thinking color applies. */
export const defaultTitleStyle = (s: string): string => `\x1b[7m ${s} \x1b[27m`;

/** Resolve the editor border colorizer for a thinking level. Unknown / `off` →
 *  the supplied `fallback` (the theme's default border color). */
export function thinkingBorderColor(
  level: string | undefined,
  fallback: (s: string) => string,
): (s: string) => string {
  const rgb = level === undefined ? undefined : THINKING_RGB[level as ThinkingLevel];
  if (rgb === undefined) return fallback;
  const [r, g, b] = rgb;
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/** Resolve the title-chip styler for a thinking level: the level's color as the
 *  chip BACKGROUND with bold white text (a space of padding each side), so the
 *  session name reads as a solid label in the same hue as the border. Unknown /
 *  `off` → the supplied `fallback` (the reverse-video default chip). */
export function thinkingTitleStyle(
  level: string | undefined,
  fallback: (s: string) => string,
): (s: string) => string {
  const rgb = level === undefined ? undefined : THINKING_RGB[level as ThinkingLevel];
  if (rgb === undefined) return fallback;
  const [r, g, b] = rgb;
  return (s: string) => `\x1b[48;2;${r};${g};${b}m\x1b[97m\x1b[1m ${s} \x1b[0m`;
}

/** Compose the replacement top-border line: solid title chip + border rule +
 *  info chip, never wider than `width` (pi-tui hard-crashes on an over-wide
 *  line). The info chip yields entirely when the chip leaves it almost no room,
 *  and truncates when it only partially fits. Exported pure for the overflow
 *  regression test. */
export function composeTopBorder(
  width: number,
  title: string,
  info: string,
  titleStyle: (s: string) => string,
  borderColor: (s: string) => string,
): string {
  const chip = title ? titleStyle(truncateToWidth(title, Math.max(1, width - 4), '…')) : '';
  const chipW = visibleWidth(chip);
  const avail = width - chipW;
  let infoChip = '';
  if (info && avail > 4) {
    infoChip = visibleWidth(info) <= avail ? info : truncateToWidth(info, avail, '…');
  }
  const fill = Math.max(0, width - chipW - visibleWidth(infoChip));
  return chip + borderColor('─'.repeat(fill)) + infoChip;
}

export class TitledEditor extends CustomEditor {
  /** Session-name chip painted into the LEFT of the top border. Empty → plain. */
  title = '';
  /** Pre-styled context string painted into the RIGHT of the top border (cwd /
   *  branch / git status). Already colorized by the caller; empty → omitted. */
  info = '';
  /** Paint the chip solid so the name reads as a label sitting on the border
   *  rule. Defaults to the reverse-video chip; attach-cmd swaps in a
   *  thinking-colored background (bold white text) on each state update. */
  titleStyle: (s: string) => string = defaultTitleStyle;

  render(width: number): string[] {
    const lines = super.render(width);
    if ((this.title || this.info) && lines.length > 0) {
      // Replace the stock top border; dashes in the current (thinking-aware)
      // border color.
      lines[0] = composeTopBorder(width, this.title, this.info, this.titleStyle, (s) =>
        this.borderColor(s),
      );
    }
    return lines;
  }
}
