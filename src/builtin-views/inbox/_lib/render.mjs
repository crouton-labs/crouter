// @ts-check
/**
 * Shared render helpers for the combined `inbox` view.
 *
 * Self-contained ESM, Node-builtins only, imports NOTHING from crtr — the
 * `inbox` view + its source adapters import these RELATIVELY.
 *
 * Discipline (design §2): all hue is NUMERIC SGR codes; color never carries
 * meaning alone — every colored element pairs hue with a glyph or weight so it
 * survives NO_COLOR / dumb terminals.
 *
 * @module inbox/_lib/render
 */

/** @typedef {import('../../../core/tui/draw.js').Draw} Draw */
/** @typedef {import('../../../core/tui/draw.js').Rect} Rect */
/** @typedef {import('../../../core/tui/draw.js').Span} Span */

/** Month abbreviations for the timestamp / day-divider ladder. */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {string} s @param {number} n @returns {string} */
export function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

/** @param {string} s @param {number} n @returns {string} */
export function padEnd(s, n) {
  const str = String(s == null ? '' : s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

/** @param {string|string[]|null|undefined} v @returns {string[]} */
export function toLinesArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s));
  return [String(v)];
}

/** Visible (column) width of a span group. @param {Span[]} spans @returns {number} */
export function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/**
 * Place a vertically + horizontally centered stack of span-lines in `rect`.
 * @param {Draw} draw @param {Rect} rect @param {Span[][]} lines
 */
export function centeredStack(draw, rect, lines) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || lines.length === 0) return;
  const start = rect.row + Math.max(0, Math.floor((rect.height - lines.length) / 2));
  lines.forEach((spans, i) => {
    const row = start + i;
    if (row < rect.row || row >= rect.row + rect.height) return;
    const w = spanWidth(spans);
    const col = rect.col + Math.max(0, Math.floor((rect.width - w) / 2));
    draw.spans(row, col, spans, rect.col + rect.width - col);
  });
}

/**
 * Split the content rect into the 1:2 two-pane layout, drawing the `vline` rule
 * between the panes. Returns the inner list/thread rects.
 * @param {Draw} draw @param {Rect} content
 * @returns {{left: Rect, right: Rect}}
 */
export function splitPanes(draw, content) {
  const cols = draw.columns(content, [1, 2]);
  const l = cols[0];
  const r = cols[1];
  const vcol = r.col; // the boundary column carries the rule
  draw.vline(vcol, content.row, content.row + content.height);
  const left = { row: content.row, col: l.col, width: Math.max(0, vcol - l.col - 1), height: content.height };
  const right = { row: content.row, col: vcol + 2, width: Math.max(0, r.col + r.width - (vcol + 2)), height: content.height };
  return { left, right };
}

/**
 * Relative-timestamp ladder, max ~5 cols: now / {m}m / {h}h / {d}d /
 * `Mon D` (this year) / `Mon ʼYY` (prior year).
 * @param {number} ts epoch ms (0 ⇒ '') @param {number} [now] @returns {string}
 */
export function relTimestamp(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.floor((now - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const dt = new Date(ts);
  const mon = MONTHS[dt.getMonth()] || '';
  const cur = new Date(now);
  if (dt.getFullYear() === cur.getFullYear()) return `${mon} ${dt.getDate()}`;
  return `${mon} ʼ${String(dt.getFullYear()).slice(-2)}`;
}

/** Calendar-day key for day-divider grouping. @param {number} ts @returns {string} */
export function dayKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Human day label for the divider: Today / Yesterday / Mon D / Mon D, YYYY. */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return 'Today';
  if (same(d, new Date(now - 86400000))) return 'Yesterday';
  const mon = MONTHS[d.getMonth()] || '';
  if (d.getFullYear() === n.getFullYear()) return `${mon} ${d.getDate()}`;
  return `${mon} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Word-wrap text to a width (also hard-splits over-long words). Preserves
 * explicit newlines as paragraph breaks.
 * @param {string} text @param {number} width @returns {string[]}
 */
export function wrapText(text, width) {
  const w = Math.max(1, width | 0);
  /** @type {string[]} */
  const out = [];
  const paragraphs = String(text == null ? '' : text).split('\n');
  for (const para of paragraphs) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let wd = word;
      while (wd.length > w) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(wd.slice(0, w));
        wd = wd.slice(w);
      }
      if (line === '') line = wd;
      else if (line.length + 1 + wd.length <= w) line += ' ' + wd;
      else {
        out.push(line);
        line = wd;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

/**
 * Decide whether a keystroke is a printable character to append to the draft.
 * @param {{input:string, key:any}} k @returns {boolean}
 */
export function isPrintable(k) {
  const key = k.key || {};
  if (key.ctrl || key.meta) return false;
  if (key.return || key.escape || key.backspace || key.tab || key.shiftTab) return false;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false;
  const ch = k.input;
  if (!ch || ch.length === 0) return false;
  const code = ch.codePointAt(0);
  if (code == null) return false;
  if (code < 0x20 || code === 0x7f) return false; // C0 controls + DEL
  return true;
}
