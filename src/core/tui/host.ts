// host.ts — the alt-screen loop that hosts a dual-target ViewCore + TuiPresenter
// (src/core/view/contract.ts).
//
// Models browse/app.ts's loop, generalized: the host owns the screen, input,
// chrome, and the single-flight async lane. State is immutable (the core's
// intents update it via `ctx.set`); presenters are pure reads. A keystroke maps
// through the TuiPresenter's keymap to a named intent the host dispatches.
//
//   • TTY gate: !process.stdin.isTTY → text.dump(state) (or a synthesized
//     one-line dump) to stdout, exit 0.
//   • setup/restore terminal (alt-screen, raw); restore exactly once, however we
//     leave (quit / Ctrl-C / crash / process exit).
//   • single-flight async lane: at most ONE async intent in flight; a busy
//     indicator shows in the chrome; keystrokes that arrive mid-flight are
//     DROPPED (this paces fetches/sends).
//   • chrome: title row + separator on top; an error banner + a footer (status
//     left, keymap hints right) on the bottom; the presenter gets the content Rect.
//   • loop: parseKeypress → keymap → dispatch(intent) → render; refreshMs polling;
//     resize → render (NOT refresh) so a resize mid-fetch repaints from current
//     state without re-entering the in-flight intent.

import {
  setupTerminal,
  restoreTerminal,
  getTerminalSize,
  parseKeypress,
  type Key,
} from './terminal.js';
import { createDraw, detectColorCaps, type ColorCaps, type Draw, type Span, type Style, type Rect, type Size } from './draw.js';
import type {
  ViewCore,
  TuiPresenter,
  TextPresenter,
  KeyBinding,
  KeyHint,
  BannerLevel,
  ChromeState,
  HostSignals,
  IntentCtx,
  Source,
  Command,
} from '../view/contract.js';
import { initialChrome, deriveState, type ChipState } from '../view/chrome.js';
import { createLocalTransport } from '../view/transport-local.js';

export interface RunViewOptions {
  /** CLI flags forwarded verbatim to the view via host.options. */
  options?: Record<string, string>;
}

// Numeric SGR codes only (a color NAME emits a broken CSI — see draw.ts guard).
const FG = { cyan: '36', green: '32', yellow: '33', red: '31', grey: '90' } as const;

/** The host-tracked chrome state. `banner` + `busy` + `loaded` derive the title
 *  state chip; `tick` advances the spinner under the busy-tick repaint. */
export interface Chrome {
  status: string | null;
  banner: { msg: string; level: BannerLevel } | null;
  busy: boolean;
  loaded: boolean;        // a refresh has completed at least once ⇒ ready vs idle
  lastRefresh: number;    // epoch ms of the last refresh (the "updated <rel>" cue)
  tick: number;           // spinner frame, advanced by the busy-tick repaint
  subtitle: string | null; // dynamic title subtitle (overrides manifest.subtitle); null ⇒ manifest default
  mode: string | null;     // explicit interaction-mode chip override (compose/react); null ⇒ derived chip
}

/** The slice of a view's manifest that drawChrome reads (title + subtitle), plus
 *  the footer hints lifted from the TuiPresenter's keymap bindings. */
export interface ChromeManifest {
  title: string;
  subtitle?: string;
  keymap?: KeyHint[];
}

/** The persistent state signal: word + glyph + hue, derived from host signals so
 *  every view gets it for free. Each pairs hue with a glyph/word — mono-safe. */
const CHIP: Record<ChipState, { word: string; glyph: string; fg: string }> = {
  working:   { word: 'working',   glyph: '⟳', fg: FG.cyan },
  blocked:   { word: 'blocked',   glyph: '⚠', fg: FG.red },
  attention: { word: 'attention', glyph: '⚠', fg: FG.yellow },
  ready:     { word: 'ready',     glyph: '●', fg: FG.green },
  idle:      { word: 'idle',      glyph: '◌', fg: FG.grey },
};

/** Spinner frames for the working chip (animated only while busy). */
const SPINNER = ['⟳', '⟲'];

/** Explicit interaction modes flip the chip to the compose accent (yellow `33`)
 *  so entering an input mode is unmistakable. Known modes get a tailored glyph;
 *  any other mode word falls back to `✎`. Color is yellow; the glyph + bold are
 *  the mono carrier (survive NO_COLOR). */
const MODE_GLYPH: Record<string, string> = { compose: '✎', react: '☺' };
const MODE_GLYPH_FALLBACK = '✎';

/** Banner glyph + hue by severity (color never carries meaning alone: the glyph
 *  + bold survive NO_COLOR). */
const BANNER: Record<BannerLevel, { glyph: string; fg: string }> = {
  info:   { glyph: 'ℹ', fg: FG.cyan },
  action: { glyph: '▸', fg: FG.yellow },
  error:  { glyph: '✗', fg: FG.red },
};

/** Color-code the transient footer status by kind (not dim, so it leads): a
 *  trailing … or an in-progress verb → cyan; a completed verb → green; else plain.
 *  The words carry meaning; the hue is decorative (mono-safe). */
function statusStyle(s: string): Style {
  if (/…$/.test(s) || /^(loading|sending|reacting|opening|working|refreshing)\b/i.test(s)) return { fg: FG.cyan };
  if (/^(sent|reacted|done|saved|caught up)\b/i.test(s) || /\bsent\b/i.test(s)) return { fg: FG.green };
  return {};
}

/** Visible width of a span group. */
function spanWidth(spans: Span[]): number {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/** Compact relative-time cue for "updated <rel>": now/Ns/Nm/Nh/Nd. */
function relTime(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Build the right-flushed keymap span group, applying the overflow ladder: full
 *  (key bold + label dim) → keys only → drop trailing hints (keep the last, q quit)
 *  → the last hint alone. Returns spans ≤ `avail` where possible. */
function keymapSpans(hints: KeyHint[], avail: number): Span[] {
  if (hints.length === 0 || avail <= 0) return [];
  const sep = (): Span => ({ text: ' · ', style: { dim: true } });
  const build = (hs: KeyHint[], labels: boolean): Span[] => {
    const out: Span[] = [];
    hs.forEach((h, i) => {
      if (i > 0) out.push(sep());
      out.push({ text: h.keys, style: { bold: true } });
      if (labels) out.push({ text: ` ${h.label}`, style: { dim: true } });
    });
    return out;
  };
  let spans = build(hints, true);
  if (spanWidth(spans) <= avail) return spans;
  spans = build(hints, false);
  if (spanWidth(spans) <= avail) return spans;
  const last = hints[hints.length - 1]!;
  for (let keep = hints.length - 1; keep > 0; keep--) {
    spans = build([...hints.slice(0, keep), last], false);
    if (spanWidth(spans) <= avail) return spans;
  }
  return build([last], false); // may still overflow — spansRight left-clips with …
}

/** Draw the host chrome into `draw` and return the content Rect for the view.
 *  Three zones: title row (state rail + title/subtitle + state chip + liveness),
 *  a hairline, and a footer (status left, keymap right) with a severity banner
 *  on the row above it when set. */
function drawChrome(draw: Draw, size: Size, manifest: ChromeManifest, c: Chrome, now: number = Date.now()): Rect {
  const { cols, rows } = size;
  const st = deriveState(c);

  // Chip selection. An explicit interaction mode (compose/react) WINS the chip
  // over the derived state — even while busy — so entering input is unmistakable
  // (precedence: setMode > derived). The mode chip is the yellow compose accent;
  // only the derived `working` chip animates its spinner.
  let chipWord: string;
  let chipGlyph: string;
  let chipFg: string;
  let animate = false;
  if (c.mode) {
    chipWord = c.mode;
    chipGlyph = MODE_GLYPH[c.mode] ?? MODE_GLYPH_FALLBACK;
    chipFg = FG.yellow;
  } else {
    const chip = CHIP[st];
    chipWord = chip.word;
    chipGlyph = chip.glyph;
    chipFg = chip.fg;
    animate = st === 'working';
  }
  const chipStyle: Style = { fg: chipFg, bold: true };

  // ── Title row: right cluster first (measure), then title clipped to fit. ──
  const glyph = animate ? (SPINNER[c.tick % SPINNER.length] ?? chipGlyph) : chipGlyph;
  const rightCluster: Span[] = [{ text: `${glyph} ${chipWord}`, style: chipStyle }];
  if (c.loaded && c.lastRefresh > 0) {
    rightCluster.push({ text: ` · updated ${relTime(now - c.lastRefresh)}`, style: { dim: true } });
  }
  const rightW = spanWidth(rightCluster);

  draw.text(0, 0, '▎', chipStyle); // state rail (always drawn; word carries meaning in mono)
  // Dynamic subtitle overrides the static manifest default; null ⇒ manifest.
  const subtitle = c.subtitle ?? manifest.subtitle;
  const titleSpans: Span[] = [{ text: manifest.title, style: { bold: true } }];
  if (subtitle) titleSpans.push({ text: ` · ${subtitle}`, style: { dim: true } });
  draw.spans(0, 2, titleSpans, Math.max(0, cols - 2 - rightW - 1));
  draw.spansRight(0, cols, rightCluster, rightW);

  draw.hline(1, 0, cols); // hairline separator (dim)

  // ── Footer: status left (color-coded, not dim), keymap right. ──
  const footerRow = rows - 1;
  const status = c.status ?? '';
  const statusW = Math.min(spanWidth([{ text: status }]), Math.max(0, Math.floor(cols / 2)));
  if (status) draw.spans(footerRow, 0, [{ text: status, style: statusStyle(status) }], statusW);
  const avail = Math.max(0, cols - statusW - 1);
  draw.spansRight(footerRow, cols, keymapSpans(manifest.keymap ?? [], avail), avail);

  // ── Banner (bottom-1, only when set): severity-coded, full-width. ──
  let bottomRows = 1;
  if (c.banner) {
    const b = BANNER[c.banner.level];
    draw.spans(footerRow - 1, 0, [
      { text: `${b.glyph} `, style: { fg: b.fg, bold: true } },
      { text: c.banner.msg, style: { bold: true } },
    ], cols);
    bottomRows = 2;
  }

  const top = 2; // title + separator
  const height = Math.max(1, rows - top - bottomRows);
  return { row: top, col: 0, width: cols, height };
}

export { drawChrome };

// ── Dual-target core host (runCoreView) ─────────────────────────────────────
//
// Hosts a ViewCore + TuiPresenter under the dual-target contract
// (src/core/view/contract.ts). The model is the immutable-state + intents thunk
// runtime: the core owns all state + behavior, presenters are pure reads, and a
// keystroke maps through the keymap to a named intent the host dispatches.

/** Tokens a keystroke can match a keymap binding's `keys` against. Arrows →
 *  up/down/left/right, return → return|enter, escape → escape|esc, a printable
 *  char → the char itself (+ 'space' for ' '), ctrl+x → ctrl+x|c-x. */
function keyTokens(input: string, key: Key): string[] {
  const t: string[] = [];
  if (key.upArrow) t.push('up');
  if (key.downArrow) t.push('down');
  if (key.leftArrow) t.push('left');
  if (key.rightArrow) t.push('right');
  if (key.return) t.push('return', 'enter');
  if (key.escape) t.push('escape', 'esc');
  if (key.tab) t.push('tab');
  if (key.shiftTab) t.push('shifttab');
  if (key.backspace) t.push('backspace');
  if (key.ctrl && input) t.push(`ctrl+${input}`, `c-${input}`);
  if (!key.ctrl && !key.escape && input.length === 1) t.push(input);
  if (input === ' ') t.push('space');
  return t;
}

/** A printable text edit (for the capture line-editor): a non-empty input with
 *  no special-key flag set. */
function isPrintable(input: string, key: Key): boolean {
  if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.backspace
    || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.shiftTab) return false;
  return input.length >= 1;
}

/** Strip control chars so a paste can't smuggle ANSI into the draft buffer. */
function sanitizePrintable(s: string): string {
  return Array.from(s).filter((ch) => ch.charCodeAt(0) >= 32).join('');
}

/** The first non-capture binding whose key matches and whose `when` (if any)
 *  passes — returns the intent name + resolved payload. */
function matchBinding<S>(keymap: KeyBinding<S>[], input: string, key: Key, state: S): { intent: string; payload: unknown } | null {
  const tokens = keyTokens(input, key);
  for (const b of keymap) {
    if ('capture' in b) continue;
    if (b.when && !b.when(state)) continue;
    if (b.keys.some((k) => tokens.includes(k))) {
      return { intent: b.intent, payload: b.payload ? b.payload(state) : undefined };
    }
  }
  return null;
}

/** The active text-capture binding for this state, if any (compose-mode entry). */
function activeCapture<S>(keymap: KeyBinding<S>[], state: S): Extract<KeyBinding<S>, { capture: string }> | null {
  for (const b of keymap) {
    if ('capture' in b && b.when(state)) return b as Extract<KeyBinding<S>, { capture: string }>;
  }
  return null;
}

/** Synthesize a one-line dump for a view that ships no text.mjs: `<title>` plus
 *  ` — <n> items` if state has an obvious top-level list. */
function synthDump(title: string, state: unknown): string {
  if (state && typeof state === 'object') {
    for (const v of Object.values(state as Record<string, unknown>)) {
      if (Array.isArray(v)) return `${title} — ${v.length} items`;
    }
  }
  return title;
}

/** Run a READ source / WRITE command through a transport → typed Result. */
async function runRequest<T, A>(
  transport: ReturnType<typeof createLocalTransport>,
  src: Source<T, A> | Command<T, A>,
  args: A,
): Promise<ReturnType<typeof src.parse>> {
  const raw = await transport.send(src.request(args));
  return src.parse(raw);
}

/** Host a dual-target ViewCore + TuiPresenter in the alt screen until it quits
 *  (or Ctrl-C). `text` is the optional text presenter for the piped path. */
export async function runCoreView<S>(
  core: ViewCore<S>,
  tui: TuiPresenter<S>,
  text: TextPresenter<S> | null,
  opts: RunViewOptions = {},
): Promise<void> {
  const options = Object.freeze({ ...(opts.options ?? {}) });
  const transport = createLocalTransport({ cwd: process.cwd() });

  // ── Non-TTY / piped path: init, best-effort refresh, dump, exit 0. ──
  if (!process.stdin.isTTY) {
    let dstate = core.init(options);
    const dchrome = initialChrome();
    const dsignal: HostSignals = {
      setStatus() {}, setBanner(m, l) { dchrome.banner = { msg: m, level: l }; }, clearBanner() { dchrome.banner = null; },
      setSubtitle() {}, setMode() {}, quit() {},
    };
    const dctx: IntentCtx<S> = {
      get state() { return dstate; },
      set(next) { dstate = typeof next === 'function' ? (next as (p: S) => S)(dstate) : next; },
      resolve: (s, a) => runRequest(transport, s, a as never),
      execute: (c, a) => runRequest(transport, c, a as never),
      signal: dsignal,
      dispatch: async (name, payload) => { const it = core.intents[name]; if (it) await it(dctx, payload); },
    };
    const refresh = core.intents['refresh'];
    if (refresh) { try { await refresh(dctx, undefined); } catch { /* dump current state regardless */ } }
    let out = text ? text.dump(dstate, { banner: dchrome.banner }) : synthDump(core.manifest.title, dstate);
    if (!out.endsWith('\n')) out += '\n';
    process.stdout.write(out);
    return;
  }

  const caps: ColorCaps = detectColorCaps();
  let state: S = core.init(options);
  const chrome: ChromeState = initialChrome();
  let tick = 0;

  // Footer hints come from the keymap bindings' `hint` field (single source of
  // truth) — projected into the (ChromeManifest, Chrome) shape drawChrome reads.
  const hints: KeyHint[] = [];
  for (const b of tui.keymap) { if (b.hint) hints.push(b.hint); }

  // Restore the terminal exactly once, however we leave.
  let restored = false;
  const cleanup = (): void => {
    if (restored) return;
    restored = true;
    try { restoreTerminal(); } catch { /* best-effort */ }
  };
  process.once('exit', cleanup);

  const render = (): void => {
    const size = getTerminalSize();
    const { draw, frame } = createDraw(size, caps);
    const chromeManifest: ChromeManifest = { ...core.manifest, keymap: hints };
    const tickChrome: Chrome = { ...chrome, tick };
    const content = drawChrome(draw, size, chromeManifest, tickChrome);
    try {
      tui.render(state, draw, content);
    } catch (e) {
      chrome.banner = { msg: `render error: ${errText(e)}`, level: 'error' };
    }
    process.stdout.write(frame());
  };

  // Busy-tick repaint: advance the spinner + repaint while an async intent runs
  // so live setStatus narration shows. Render-only — never re-enters an intent.
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  const startBusyTick = (): void => {
    if (tickTimer) return;
    tickTimer = setInterval(() => { tick++; render(); }, 120);
  };
  const stopBusyTick = (): void => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = undefined; }
  };

  // Loop control hoisted so signal.quit() can finish from inside an intent.
  let done = false;
  let resolveLoop: () => void = () => {};
  const loopDone = new Promise<void>((res) => { resolveLoop = res; });
  let loopTimer: ReturnType<typeof setInterval> | undefined;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (loopTimer) clearInterval(loopTimer);
    stopBusyTick();
    cleanup();
    resolveLoop();
  };

  const signal: HostSignals = {
    setStatus(msg) { chrome.status = msg; },
    setBanner(msg, level) { chrome.banner = msg == null ? null : { msg, level }; },
    clearBanner() { chrome.banner = null; },
    setSubtitle(s) { chrome.subtitle = s; },
    setMode(mode) { chrome.mode = mode; },
    quit() { finish(); },
  };

  // The single-flight busy lane lives in dispatch. The INPUT layer drops
  // keystrokes while busy (paces fetches); a chained ctx.dispatch from inside an
  // intent runs inline without re-toggling the lane.
  let busy = false;
  const markRefreshed = (name: string): void => {
    if (name === 'refresh') { chrome.loaded = true; chrome.lastRefresh = Date.now(); }
  };
  const makeCtx = (): IntentCtx<S> => ({
    get state() { return state; },
    set(next) { state = typeof next === 'function' ? (next as (p: S) => S)(state) : next; render(); },
    resolve: (s, a) => runRequest(transport, s, a as never),
    execute: (c, a) => runRequest(transport, c, a as never),
    signal,
    dispatch: (name, payload) => dispatch(name, payload),
  });
  const dispatch = async (intentName: string, payload?: unknown): Promise<void> => {
    if (done) return;
    const intent = core.intents[intentName];
    if (!intent) {
      chrome.banner = { msg: `unknown intent: ${intentName}`, level: 'error' };
      render();
      return;
    }
    const ctx = makeCtx();
    let res: void | Promise<void>;
    try {
      res = intent(ctx, payload);
    } catch (e) {
      chrome.banner = { msg: errText(e), level: 'error' };
      markRefreshed(intentName);
      render();
      return;
    }
    if (res instanceof Promise) {
      const wasBusy = busy;
      if (!wasBusy) { busy = true; chrome.busy = true; render(); startBusyTick(); }
      try {
        await res;
      } catch (e) {
        chrome.banner = { msg: errText(e), level: 'error' };
      } finally {
        if (!wasBusy) { busy = false; chrome.busy = false; stopBusyTick(); }
        markRefreshed(intentName);
        render();
      }
    } else {
      markRefreshed(intentName);
      render();
    }
  };

  // ── Mount: init → loading frame → first refresh (if the view has one). ──
  setupTerminal();
  render();
  if (core.intents['refresh']) await dispatch('refresh');

  // Capture-mode buffer: the host's line-editor draft while a `capture` binding's
  // when(state) is true; reset to '' whenever no capture binding is active.
  let captureBuf = '';

  if (typeof core.manifest.refreshMs === 'number' && core.manifest.refreshMs > 0) {
    loopTimer = setInterval(() => { if (!busy) void dispatch('refresh'); }, core.manifest.refreshMs);
  }

  const onData = async (data: Buffer): Promise<void> => {
    if (done) return;
    let parsed: { input: string; key: Key };
    try { parsed = parseKeypress(data); } catch { return; }
    const { input, key } = parsed;

    // Ctrl-C is the universal escape hatch — works even mid-flight.
    if (key.ctrl && input === 'c') { finish(); return; }

    // Drop keystrokes while an async intent is in flight (paces fetch/send).
    if (busy) return;

    // Text-capture: while a capture binding is active, printable/backspace edit
    // the host buffer and dispatch capture(nextDraft); other keys (return/escape)
    // fall through to the keymap so submit/cancel can be bound.
    const cap = activeCapture(tui.keymap, state);
    if (cap) {
      if (isPrintable(input, key)) { captureBuf += sanitizePrintable(input); await dispatch(cap.capture, captureBuf); return; }
      if (key.backspace) { captureBuf = captureBuf.slice(0, -1); await dispatch(cap.capture, captureBuf); return; }
    } else {
      captureBuf = '';
    }

    const m = matchBinding(tui.keymap, input, key, state);
    if (m) await dispatch(m.intent, m.payload);
  };

  process.stdin.on('data', (d: Buffer) => { void onData(d); });
  // Resize → repaint from current state (never re-enter an in-flight intent).
  process.stdout.on('resize', () => { if (!done) render(); });

  await loopDone;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
