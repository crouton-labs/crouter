import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DashboardRow } from '../../render.js';
import type { NodeStatus } from '../../types.js';
import { buildTree, flatten } from '../model.js';
import { renderFrame, detectColorCaps, type ColorCaps, type RenderState } from '../render.js';

// ── Fixture ───────────────────────────────────────────────────────────────────

function row(node_id: string, name: string, status: NodeStatus, opts: Partial<DashboardRow> = {}): DashboardRow {
  return { node_id, name, status, kind: 'general', mode: 'base', ctx_tokens: 0, asks: 0, cwd: '/tmp/proj', created: '2026-01-01T00:00:00.000Z', ...opts };
}

const ROWS: DashboardRow[] = [
  row('root1', 'alpha', 'active'),
  row('idle1', 'bravo', 'idle'),
  row('done1', 'charlie', 'done', { ctx_tokens: 120_000 }), // ≥100k → red ctx
  row('dead1', 'delta', 'dead'),
  row('canc1', 'echo', 'canceled', { asks: 3 }),
];
const ROOT_IDS = ['root1', 'idle1', 'done1', 'dead1', 'canc1'];
const childIdsOf = (): string[] => [];

function tree() {
  return buildTree(ROWS, ROOT_IDS, childIdsOf);
}

const SIZE = { cols: 100, rows: 24 };
const ON: ColorCaps = { color: true, color256: true };
const OFF: ColorCaps = { color: false, color256: false };

function state(over: Partial<RenderState> = {}): RenderState {
  const t = tree();
  const visible = flatten(t, { collapsed: new Set(), tab: 'All', query: over.query ?? '' });
  return {
    tree: t,
    visible,
    tab: 'All',
    cursor: 0,
    scrollOffset: 0,
    query: '',
    search: false,
    totalNodes: t.nodes.size,
    cwdScope: null,
    sort: 'tree',
    preview: false,
    residentsOnly: false,
    ...over,
  };
}

const ESC = '\x1b[';
/** Any hue (color) SGR: fg 30–37/90–97, bg 40–47/100–107, or 256/truecolor sel. */
const HUE_RE = /\x1b\[(3\d|4\d|9\d|10\d|38;|48;)/;

// ── (a) color enabled → status hue present, glyph still there ──────────────────

test('color on: each status glyph carries its hue, glyph kept', () => {
  // cursor off the rows we assert so lineBase doesn't wrap the glyph code.
  const out = renderFrame(state({ cursor: -1 }), SIZE, ON);
  assert.ok(out.includes(`${ESC}32m●`), 'active → green ●');
  assert.ok(out.includes(`${ESC}33m○`), 'idle → yellow ○');
  assert.ok(out.includes(`${ESC}36m✓`), 'done → cyan ✓');
  assert.ok(out.includes(`${ESC}31m✗`), 'dead → red ✗');
  assert.ok(out.includes(`${ESC}90m⊘`), 'canceled → gray ⊘');
});

test('color on: ctx ≥100k row is red; asks are bright-yellow', () => {
  const out = renderFrame(state({ cursor: -1 }), SIZE, ON);
  // ctx is a right-aligned fixed-width column now, so the red span carries padding.
  assert.ok(out.includes(`${ESC}31m`) && out.includes('120k'), 'ctx ≥100k → red');
  assert.ok(out.includes(`${ESC}93m`), 'asks → bright-yellow');
  assert.ok(out.includes('⚑3'), 'flag glyph kept');
});

test('color on: cursor row uses a 256-color background (not full reverse)', () => {
  const out = renderFrame(state({ cursor: 0 }), SIZE, ON);
  assert.ok(out.includes(`${ESC}48;5;236m`), 'subtle dark-gray cursor bg');
  // and the status glyph hue still reads on the selected row
  assert.ok(out.includes(`${ESC}32m●`), 'glyph hue survives on cursor row');
});

// ── (b) NO_COLOR → no hue SGR, but the glyphs (the real encoding) remain ───────

test('color off: no hue SGR emitted, but every status glyph remains', () => {
  const out = renderFrame(state({ cursor: -1 }), SIZE, OFF);
  assert.ok(!HUE_RE.test(out), `expected no color SGR, got: ${JSON.stringify(out.match(HUE_RE))}`);
  for (const g of ['●', '○', '✓', '✗', '⊘']) {
    assert.ok(out.includes(g), `glyph ${g} kept without color`);
  }
  assert.ok(out.includes('⚑3'), 'flag glyph kept without color');
  // structural SGR is still allowed (dim separators/footer, reverse cursor).
  assert.ok(out.includes(`${ESC}2m`), 'dim (structural) still used');
});

test('color off: cursor row falls back to reverse (structural, no hue)', () => {
  const out = renderFrame(state({ cursor: 0 }), SIZE, OFF);
  assert.ok(out.includes(`${ESC}7m`), 'reverse cursor fallback');
  assert.ok(!HUE_RE.test(out), 'still no hue under no-color');
});

// ── (c) query → the matched substring is highlighted ───────────────────────────

test('color on: matched chars in a row name get the bright-cyan highlight', () => {
  // query 'lph' matches 'alpha' (a-LPH-a). The matched run is highlighted.
  const out = renderFrame(state({ query: 'lph', cursor: -1 }), SIZE, ON);
  assert.ok(out.includes(`${ESC}96mlph`), 'matched substring → bright-cyan');
});

test('color off: match highlight degrades to bold (no hue), name intact', () => {
  const out = renderFrame(state({ query: 'lph', cursor: -1 }), SIZE, OFF);
  assert.ok(!HUE_RE.test(out), 'no hue under no-color even with a query');
  assert.ok(out.includes(`${ESC}1mlph`), 'matched chars bold as the no-color affordance');
});

// ── detectColorCaps gate ───────────────────────────────────────────────────────

test('detectColorCaps: honors NO_COLOR, TERM=dumb, and non-TTY', () => {
  assert.deepEqual(detectColorCaps({ isTTY: true }, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }), { color: true, color256: true });
  assert.equal(detectColorCaps({ isTTY: true }, { TERM: 'xterm-256color', NO_COLOR: '1' }).color, false);
  assert.equal(detectColorCaps({ isTTY: true }, { TERM: 'dumb' }).color, false);
  assert.equal(detectColorCaps({ isTTY: false }, { TERM: 'xterm-256color' }).color, false);
  // basic color but no 256 → color on, color256 off (reverse cursor fallback).
  assert.deepEqual(detectColorCaps({ isTTY: true }, { TERM: 'xterm' }), { color: true, color256: false });
});
