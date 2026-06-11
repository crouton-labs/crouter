// Regression: TitledEditor's top border dropped the git-info chip only when the
// title chip left fewer than 4 free columns — when BOTH chips fit individually
// but their sum exceeded the terminal width, the fill clamped to 0 and the line
// came out chipW+infoW wide. pi-tui hard-crashes on any over-wide line:
//   "Error: Rendered line 3192 exceeds terminal width (75 > 70)"
// (title chip " ⬢ general (base) continue-crouter-development 0 " = 50 cols,
// info "crouter · ⎇ main · ●⇡5⇣1" = 25 cols, terminal 70). The fix truncates
// the info chip to the space the title leaves instead of all-or-nothing.
// See composeTopBorder in src/clients/attach/titled-editor.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { composeTopBorder } from '../titled-editor.js';

const titleStyle = (s: string): string => `\x1b[7m ${s} \x1b[27m`;
const borderColor = (s: string): string => `\x1b[38;2;128;128;128m${s}\x1b[39m`;

const compose = (width: number, title: string, info: string): string =>
  composeTopBorder(width, title, info, titleStyle, borderColor);

test('crash scenario: chip + info that each fit but overflow together stays at width', () => {
  const title = '⬢ general (base) continue-crouter-development 0'; // chip = 50 cols
  const info = `\x1b[38;2;128;128;128mcrouter · \x1b[39m\x1b[38;2;129;162;190m⎇ main\x1b[39m\x1b[38;2;128;128;128m · \x1b[39m\x1b[33m●\x1b[39m⇡5⇣1`; // 25 cols
  const line = compose(70, title, info);
  assert.equal(visibleWidth(line), 70, 'line must be exactly terminal width, not 75');
});

test('top border never exceeds width across title/info length combinations', () => {
  const longInfo = `\x1b[33m${'status-info-'.repeat(8)}\x1b[39m`;
  for (const width of [20, 40, 70, 120]) {
    for (const title of ['', 'a', 'session', 'x'.repeat(200)]) {
      for (const info of ['', 'crouter · main', longInfo]) {
        const line = compose(width, title, info);
        assert.ok(
          visibleWidth(line) <= width,
          `overflow at width=${width} titleLen=${title.length} infoW=${visibleWidth(info)}: got ${visibleWidth(line)}`,
        );
      }
    }
  }
});

test('info chip survives intact when there is room for it', () => {
  const info = 'crouter · main';
  const line = compose(80, 'sess', info);
  assert.ok(line.includes(info), 'fitting info must not be truncated or dropped');
  assert.equal(visibleWidth(line), 80);
});
