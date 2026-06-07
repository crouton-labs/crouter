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
import { styleSpan, isSgrParams } from '../tui/draw.js';

const ESC = '\x1b[';

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
