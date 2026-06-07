// Bug-regression test for the crtr TUI Draw style encoding.
//
// Observed bug (canvas + linkedin views, 2026-06-07): view code set Style.fg to a
// color NAME ('green'/'cyan'/'red') instead of an SGR parameter ('32'/'36'/'31').
// With color ON, styleSpan emitted `\x1b[greenm` — an invalid CSI the terminal
// eats as a control op, printing the tail ('reenm') as literal garbage. The
// monitor's status glyphs/flags rendered as garbage on any color terminal (the
// non-TTY/NO_COLOR path was unaffected because fg is gated behind `color`).
//
// Root-cause fix: styleSpan now only emits fg/bg when the value is a valid SGR
// parameter string (digits + semicolons); a bad value degrades to no-color
// instead of emitting a broken escape. These tests lock that guarantee.
//
// Run: node --import tsx/esm --test src/core/__tests__/draw-style.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { styleSpan, isSgrParams, createDraw, type ColorCaps, type Size, type ListItemRow } from '../tui/draw.js';
import { drawChrome, type Chrome } from '../tui/host.js';
import type { ViewManifest } from '../tui/contract.js';

const ESC = '\x1b[';

const ON: ColorCaps = { color: true, color256: true };
const OFF: ColorCaps = { color: false, color256: false };
const SIZE: Size = { cols: 80, rows: 24 };

/** Strip the harmless framing CSIs the serializer emits (cursor home / clear),
 *  so any REMAINING `\x1b[` not followed by an SGR param digit/semicolon is a
 *  broken SGR escape — the exact bug class (`\x1b[greenm`). */
function hasInvalidCsi(frame: string): boolean {
  const stripped = frame.replace(/\x1b\[[HJK]/g, '').replace(/[\r\n]/g, '');
  return /\x1b\[[^0-9;]/.test(stripped);
}

/** Any 8-bit color SGR (fg 30-37/90-97, or 256-color bg) present in the frame. */
function hasColorSgr(frame: string): boolean {
  return /\x1b\[(3[0-9]|9[0-7])m/.test(frame) || /\x1b\[48;5;/.test(frame);
}

function baseChrome(over: Partial<Chrome> = {}): Chrome {
  return { status: null, banner: null, busy: false, loaded: true, lastRefresh: Date.now(), tick: 0, ...over };
}

const MANIFEST: ViewManifest = {
  id: 't', title: 'Test View', subtitle: '3 unread', description: 'd',
  keymap: [
    { keys: 'j/k', label: 'move' }, { keys: 'enter', label: 'open' },
    { keys: 'r', label: 'reply' }, { keys: 'g', label: 'refresh' }, { keys: 'q', label: 'quit' },
  ],
};

describe('styleSpan: SGR encoding (bug-regression)', () => {
  test('a valid numeric fg emits a well-formed CSI', () => {
    const out = styleSpan('●', { fg: '32', bold: true }, true, '');
    assert.ok(out.includes(`${ESC}32m`), 'should contain \\x1b[32m');
    assert.ok(out.includes(`${ESC}1m`), 'bold still emitted');
  });

  test('a color NAME fg degrades to no-color — never emits a broken escape', () => {
    const out = styleSpan('●', { fg: 'green' }, true, '');
    // The bug: \x1b[greenm. Assert no CSI is followed by a non-digit/semicolon.
    assert.ok(!/\x1b\[[^0-9;]/.test(out), 'no invalid CSI introducer');
    assert.ok(!out.includes('green'), 'the bad token never leaks into output');
  });

  test('a color NAME bg degrades to no-color', () => {
    const out = styleSpan('x', { bg: 'red' }, true, '');
    assert.ok(!/\x1b\[[^0-9;]/.test(out), 'no invalid CSI introducer');
    assert.ok(!out.includes('red'), 'the bad token never leaks into output');
  });

  test('a valid 256-color bg index emits 48;5;N', () => {
    const out = styleSpan('x', { bg: '236' }, true, '');
    assert.ok(out.includes(`${ESC}48;5;236m`), 'should contain \\x1b[48;5;236m');
  });

  test('compound SGR params (e.g. "1;36") are valid', () => {
    assert.equal(isSgrParams('1;36'), true);
    assert.equal(isSgrParams('236'), true);
    assert.equal(isSgrParams('green'), false);
    assert.equal(isSgrParams(''), false);
  });

  test('structural styles (bold/dim/reverse) are unaffected by color gating', () => {
    const out = styleSpan('x', { fg: 'green', dim: true }, true, '');
    assert.ok(out.includes(`${ESC}2m`), 'dim still emitted even when fg is rejected');
  });
});

// ── New Draw primitives — same bug class (no invalid CSI; bad value degrades) ──

describe('spansRight: SGR encoding (bug-regression)', () => {
  test('valid numeric fg → well-formed CSI, no broken escape', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    draw.spansRight(0, 80, [{ text: 'ready', style: { fg: '32', bold: true } }]);
    const f = frame();
    assert.ok(f.includes(`${ESC}32m`), 'emits \\x1b[32m');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });

  test('a color NAME fg degrades — no broken escape, name not leaked', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    draw.spansRight(0, 80, [{ text: 'x', style: { fg: 'green' } }]);
    const f = frame();
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI introducer');
    assert.ok(!f.includes('green'), 'the bad token never leaks');
  });

  test('over-maxWidth groups left-clip with a leading … (no overflow, no garbage)', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    draw.spansRight(0, 80, [{ text: 'abcdefghij', style: { dim: true } }], 4);
    const f = frame();
    assert.ok(f.includes('…'), 'leading ellipsis present');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });
});

describe('vline: SGR encoding + mono fallback (bug-regression)', () => {
  test('renders a dim rule with no invalid CSI (color on)', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    draw.vline(40, 0, 10);
    const f = frame();
    assert.ok(f.includes('│'), 'default │ glyph present');
    assert.ok(f.includes(`${ESC}2m`), 'dim emitted');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });

  test('ASCII fallback ch and mono caps both stay well-formed', () => {
    const { draw, frame } = createDraw(SIZE, OFF);
    draw.vline(40, 0, 10, '|');
    const f = frame();
    assert.ok(f.includes('|'), 'ASCII fallback | present');
    assert.ok(!hasColorSgr(f), 'no color SGR when caps.color is off');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });
});

describe('ListItemRow.right: SGR encoding (bug-regression)', () => {
  test('right group + cursor-row base merge → no invalid CSI', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    /** @type {ListItemRow[]} */
    const items: ListItemRow[] = [
      { spans: [{ text: 'Ada Lovelace', style: { bold: true } }], right: [{ text: '2h', style: { fg: '90' } }] },
      { spans: [{ text: 'Grace Hopper' }], right: [{ text: '4h', style: { fg: '90' } }] },
    ];
    const res = draw.list({ row: 2, col: 0, width: 80, height: 5 }, items, 0, 0);
    const f = frame();
    assert.equal(res.scroll, 0);
    assert.ok(f.includes('2h') && f.includes('4h'), 'right-flushed timestamps drawn');
    assert.ok(f.includes(`${ESC}48;5;236m`), 'cursor-row 236-bg highlight present');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });

  test('a color NAME fg in the right group degrades, not leaks', () => {
    const { draw, frame } = createDraw(SIZE, ON);
    const items: ListItemRow[] = [{ spans: [{ text: 'x' }], right: [{ text: 'y', style: { fg: 'cyan' } }] }];
    draw.list({ row: 0, col: 0, width: 80, height: 2 }, items, 0, 0);
    const f = frame();
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
    assert.ok(!f.includes('cyan'), 'the bad token never leaks');
  });
});

// ── Chrome — every new element survives the bug class + has a mono fallback ──

describe('drawChrome: SGR encoding + mono fallback (bug-regression)', () => {
  const states: Array<[string, Chrome]> = [
    ['working', baseChrome({ busy: true, status: 'Loading…' })],
    ['blocked', baseChrome({ banner: { msg: 'Send rejected', level: 'error' } })],
    ['attention', baseChrome({ banner: { msg: 'Log in, then press r', level: 'action' } })],
    ['ready', baseChrome({ status: '5 conversations' })],
    ['idle', baseChrome({ loaded: false, lastRefresh: 0 })],
    ['info-banner', baseChrome({ banner: { msg: 'Throttling — waiting', level: 'info' } })],
  ];

  for (const [name, chrome] of states) {
    test(`state "${name}" never emits a broken escape (color on)`, () => {
      const { draw, frame } = createDraw(SIZE, ON);
      drawChrome(draw, SIZE, MANIFEST, chrome);
      assert.ok(!hasInvalidCsi(frame()), 'no invalid CSI');
    });
  }

  test('mono fallback: no color SGR when caps.color is off, glyphs/words still render', () => {
    const { draw, frame } = createDraw(SIZE, OFF);
    drawChrome(draw, SIZE, MANIFEST, baseChrome({ busy: true, status: 'Loading…' }));
    const f = frame();
    assert.ok(!hasColorSgr(f), 'no color SGR emitted in mono');
    assert.ok(f.includes('▎'), 'state rail glyph always drawn');
    assert.ok(f.includes('working'), 'state WORD carries meaning in mono');
    assert.ok(f.includes(`${ESC}1m`), 'structural bold still emitted');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI');
  });

  test('every banner level renders its glyph with no broken escape', () => {
    for (const [level, glyph] of [['info', 'ℹ'], ['action', '▸'], ['error', '✗']] as const) {
      const { draw, frame } = createDraw(SIZE, ON);
      drawChrome(draw, SIZE, MANIFEST, baseChrome({ banner: { msg: 'm', level } }));
      const f = frame();
      assert.ok(f.includes(glyph), `${level} banner glyph ${glyph} present`);
      assert.ok(!hasInvalidCsi(f), `${level} banner: no invalid CSI`);
    }
  });

  test('keymap overflow degrades to keys-only on a narrow screen, still well-formed', () => {
    const narrow: Size = { cols: 28, rows: 24 };
    const { draw, frame } = createDraw(narrow, ON);
    drawChrome(draw, narrow, MANIFEST, baseChrome({ status: 'a very long status line here' }));
    const f = frame();
    assert.ok(f.includes('q'), 'q quit hint survives overflow');
    assert.ok(!hasInvalidCsi(f), 'no invalid CSI under overflow');
  });
});
