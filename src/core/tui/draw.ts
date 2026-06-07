// draw.ts — the generic immediate-mode drawing surface shared by every crtr
// raw-ANSI TUI (the `crtr view` host and `canvas browse`).
//
// The span/color primitives (Span, styleSpan, assemble, clip, ColorCaps,
// detectColorCaps) are extracted verbatim-in-behavior from
// canvas/browse/render.ts so there is ONE copy; browse imports them back.
//
// On top of those primitives this module adds the `Draw` factory: a line/cell
// buffer covering the screen that a view fills via absolute-cell helpers
// (spans/text/hline/box/columns/list). The host allocates one Draw per frame,
// draws its chrome into it, hands the view a content Rect, then serializes the
// buffer to a single repaint frame (`\x1b[H` + per-line `\x1b[K` + `\x1b[J`) —
// exactly like browse's renderFrame does today.
//
// COLOR: hue (fg/bg) is gated on `caps.color`; structural SGR (bold/dim/reverse)
// is always allowed. 256-color bg (the cursor-row highlight) additionally needs
// `caps.color256`, falling back to reverse.

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const REVERSE = `${ESC}7m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;

// ── Geometry ──────────────────────────────────────────────────────────────────

export interface Size { cols: number; rows: number; }
export interface Rect { row: number; col: number; width: number; height: number; }

// ── Styled spans ──────────────────────────────────────────────────────────────
//
// A row is built from styled spans, then assembled to a width-clipped line. This
// lets each cell carry its own hue (status glyph, ctx tier, match highlight)
// while clipping by VISIBLE width — ANSI bytes don't count toward the column
// budget. `fg`/`bg` are hue (gated on `color`); `bold`/`dim`/`reverse` are
// structural (always allowed).

export interface Style {
  fg?: string;        // basic-16 fg code, e.g. '32'; emitted only when color is on
  bg?: string;        // 256-color bg index, e.g. '236'; emitted only when color is on
  bold?: boolean;
  dim?: boolean;
  reverse?: boolean;
}

export interface Span { text: string; style?: Style; }

/** An SGR fg/bg parameter is digits and semicolons only (e.g. '32', '1;36', '236').
 *  Guards styleSpan against a non-numeric value (a color name) producing a broken
 *  escape sequence. */
export function isSgrParams(v: string): boolean {
  return v.length > 0 && /^[0-9;]+$/.test(v);
}

/** Style one chunk of text. Hue (fg/bg) is gated on `color`; bold/dim/reverse
 *  are not. After the styled text we return to `lineBase` (not a bare reset) so a
 *  row-level background/dim persists across spans instead of bleeding or being
 *  cleared. */
export function styleSpan(text: string, style: Style | undefined, color: boolean, lineBase: string): string {
  if (text === '') return '';
  let pre = '';
  if (style?.dim) pre += DIM;
  if (style?.bold) pre += BOLD;
  if (style?.reverse) pre += REVERSE;
  // fg is an SGR parameter string (e.g. '32' or '1;36'); bg is a 256-color index.
  // Reject anything else so a bad value (e.g. a color NAME like 'green') degrades
  // to no-color instead of emitting an invalid CSI that prints as literal garbage.
  if (color && style?.fg && isSgrParams(style.fg)) pre += `${ESC}${style.fg}m`;
  if (color && style?.bg && isSgrParams(style.bg)) pre += `${ESC}48;5;${style.bg}m`;
  if (pre === '') return text; // inherits lineBase / default
  return `${pre}${text}${RESET}${lineBase}`;
}

/** Assemble styled spans into one line clipped to `width` visible cols. When
 *  `fill`, pad the remainder with spaces (under `lineBase`) so a cursor-row
 *  background spans the full width. Always RESET-terminated so no color bleeds
 *  into the next line. */
export function assemble(spans: Span[], width: number, color: boolean, lineBase: string, fill: boolean): string {
  let used = 0;
  let body = '';
  for (const span of spans) {
    if (used >= width) break;
    if (span.text === '') continue;
    let t = span.text;
    const remaining = width - used;
    let cut = false;
    if (t.length > remaining) {
      t = t.slice(0, Math.max(0, remaining - 1)) + '…';
      cut = true;
    }
    body += styleSpan(t, span.style, color, lineBase);
    used += t.length;
    if (cut) break;
  }
  if (fill && used < width) body += ' '.repeat(width - used);
  return lineBase === '' ? body : `${lineBase}${body}${RESET}`;
}

/** Truncate to `max` visible cols (plain text, no ANSI). */
export function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

// ── Color capability ──────────────────────────────────────────────────────────

export interface ColorCaps {
  /** Any hue (fg/bg color) allowed. */
  color: boolean;
  /** 256-color bg allowed — drives the subtle cursor-row background. */
  color256: boolean;
}

/** Detect color capability. Honors `NO_COLOR` and `TERM=dumb`, and only emits
 *  hue when stdout is a TTY. `color256` additionally requires a 256/truecolor
 *  terminal (for the cursor-row background; otherwise we fall back to reverse). */
export function detectColorCaps(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ColorCaps {
  const term = env['TERM'] ?? '';
  const color = stream.isTTY === true && !env['NO_COLOR'] && term !== 'dumb';
  const colorTerm = env['COLORTERM'] ?? '';
  const color256 = color && (/256|direct/i.test(term) || /truecolor|24bit/i.test(colorTerm));
  return { color, color256 };
}

// ── Draw surface (cell buffer) ─────────────────────────────────────────────────

/** One pre-styled list row (the view styles its own spans; `list` windows + the
 *  cursor highlight are the host's job). */
export interface ListItemRow { spans: Span[]; }
/** Adjusted scroll the view stores back so the cursor stays visible. */
export interface ListResult { scroll: number; }

export interface Draw {
  readonly size: Size;
  readonly caps: ColorCaps;
  /** Styled spans at an absolute cell, clipped to maxWidth (default → edge). */
  spans(row: number, col: number, spans: Span[], maxWidth?: number): void;
  /** Convenience single span. */
  text(row: number, col: number, text: string, style?: Style): void;
  /** Dim horizontal rule across [fromCol,toCol) (default full width). */
  hline(row: number, fromCol?: number, toCol?: number, ch?: string): void;
  /** Single-line box border around rect (optional title in the top edge). */
  box(rect: Rect, title?: string): void;
  /** Split a rect into N columns by weights. */
  columns(rect: Rect, weights: number[]): Rect[];
  /** Scrollable list within rect: windows `items` to fit height, highlights the
   *  cursor row (256-bg or reverse fallback, like browse). Returns adjusted
   *  scroll so the cursor stays visible — the view stores it in state. */
  list(rect: Rect, items: ListItemRow[], cursor: number, scroll: number): ListResult;
}

/** A live Draw plus the host-side serializer. */
export interface DrawHandle {
  draw: Draw;
  /** Serialize the buffer to a full repaint frame (home + per-line clear + clear
   *  below) — identical framing to browse's renderFrame. */
  frame(): string;
}

interface Cell { ch: string; style: Style | undefined; }

function mergeStyle(base: Style, top?: Style): Style {
  if (!top) return base;
  return {
    fg: top.fg ?? base.fg,
    bg: top.bg ?? base.bg,
    bold: top.bold || base.bold,
    dim: top.dim || base.dim,
    reverse: top.reverse || base.reverse,
  };
}

function sameStyle(a: Style | undefined, b: Style | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.fg === b.fg && a.bg === b.bg
    && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.reverse === !!b.reverse;
}

/** Create a screen-sized cell buffer + the absolute-cell Draw API over it. */
export function createDraw(size: Size, caps: ColorCaps): DrawHandle {
  const cols = Math.max(1, size.cols);
  const rows = Math.max(1, size.rows);
  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Cell[] = new Array(cols);
    for (let c = 0; c < cols; c++) line[c] = { ch: ' ', style: undefined };
    grid.push(line);
  }

  /** Place spans starting at (row, col), clipped to `limit` visible cells; each
   *  span's style optionally merged under `base` (the cursor-row highlight). */
  const place = (row: number, col: number, spans: Span[], maxWidth: number | undefined, base?: Style): void => {
    if (row < 0 || row >= rows) return;
    const edge = cols - col;
    const limit = Math.min(maxWidth ?? edge, edge);
    if (limit <= 0) return;
    let x = col;
    let drawn = 0;
    for (const span of spans) {
      if (drawn >= limit) break;
      const style = base ? mergeStyle(base, span.style) : span.style;
      for (const ch of Array.from(span.text)) {
        if (drawn >= limit) break;
        if (x >= 0 && x < cols) grid[row]![x] = { ch, style };
        x++;
        drawn++;
      }
    }
  };

  const fillStyle = (row: number, col: number, width: number, style: Style): void => {
    if (row < 0 || row >= rows) return;
    const end = Math.min(cols, col + width);
    for (let x = Math.max(0, col); x < end; x++) grid[row]![x] = { ch: ' ', style };
  };

  const draw: Draw = {
    size: { cols, rows },
    caps,

    spans(row, col, spans, maxWidth) {
      place(row, col, spans, maxWidth);
    },

    text(row, col, text, style) {
      place(row, col, [{ text, style }], undefined);
    },

    hline(row, fromCol = 0, toCol = cols, ch = '─') {
      if (row < 0 || row >= rows) return;
      const a = Math.max(0, Math.min(cols, fromCol));
      const b = Math.max(0, Math.min(cols, toCol));
      for (let x = a; x < b; x++) grid[row]![x] = { ch, style: { dim: true } };
    },

    box(rect, title) {
      const { row, col, width, height } = rect;
      if (width < 2 || height < 2) return;
      const bs: Style = { dim: true };
      const right = col + width - 1;
      const bottom = row + height - 1;
      const horiz = '─'.repeat(Math.max(0, width - 2));
      place(row, col, [{ text: `┌${horiz}┐`, style: bs }], width);
      place(bottom, col, [{ text: `└${horiz}┘`, style: bs }], width);
      for (let r = row + 1; r < bottom; r++) {
        place(r, col, [{ text: '│', style: bs }], 1);
        place(r, right, [{ text: '│', style: bs }], 1);
      }
      if (title !== undefined && title !== '' && width > 4) {
        place(row, col + 2, [{ text: ` ${title} ` }], width - 4);
      }
    },

    columns(rect, weights) {
      const n = weights.length;
      if (n === 0) return [];
      const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
      const out: Rect[] = [];
      let x = rect.col;
      let used = 0;
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1;
        const w = isLast
          ? Math.max(0, rect.width - used)
          : Math.max(0, Math.floor((rect.width * Math.max(0, weights[i]!)) / total));
        out.push({ row: rect.row, col: x, width: w, height: rect.height });
        x += w;
        used += w;
      }
      return out;
    },

    list(rect, items, cursor, scroll) {
      const height = Math.max(0, rect.height);
      let sc = scroll;
      if (height > 0) {
        if (cursor < sc) sc = cursor;
        if (cursor >= sc + height) sc = cursor - height + 1;
      }
      if (sc < 0) sc = 0;
      if (sc > Math.max(0, items.length - 1)) sc = Math.max(0, items.length - 1);
      const end = Math.min(items.length, sc + height);
      for (let i = sc; i < end; i++) {
        const rowIdx = rect.row + (i - sc);
        if (i === cursor) {
          const base: Style = caps.color256 ? { bg: '236' } : { reverse: true };
          fillStyle(rowIdx, rect.col, rect.width, base);
          place(rowIdx, rect.col, items[i]!.spans, rect.width, base);
        } else {
          place(rowIdx, rect.col, items[i]!.spans, rect.width);
        }
      }
      return { scroll: sc };
    },
  };

  const serializeRow = (cells: Cell[]): string => {
    // Trim trailing plain blanks (clear-to-EOL covers them); keep styled tails
    // (e.g. a cursor-row background fill) intact.
    let last = -1;
    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i]!;
      if (c.ch !== ' ' || c.style !== undefined) { last = i; break; }
    }
    if (last < 0) return '';
    let out = '';
    let i = 0;
    while (i <= last) {
      const style = cells[i]!.style;
      let text = '';
      while (i <= last && sameStyle(cells[i]!.style, style)) { text += cells[i]!.ch; i++; }
      out += styleSpan(text, style, caps.color, '');
    }
    return out;
  };

  const frame = (): string => {
    const body = grid.map((cells) => `${serializeRow(cells)}${ESC}K`).join('\r\n');
    return `${ESC}H${body}${ESC}J`;
  };

  return { draw, frame };
}
