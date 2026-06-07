// host.ts — the alt-screen loop that hosts a ViewModule.
//
// Models browse/app.ts's loop, generalized: the host owns the screen, input,
// chrome, and the single-flight async lane; the view paints into the `Draw` it's
// handed and returns a `ViewAction` per keystroke.
//
//   • TTY gate: !process.stdin.isTTY → view.dump(state) to stdout, exit 0.
//   • setup/restore terminal (alt-screen, raw); restore exactly once, however we
//     leave (quit / Ctrl-C / crash / process exit).
//   • single-flight async lane: at most ONE async hook (refresh or an async
//     onKey) in flight; a busy indicator shows in the chrome; keystrokes that
//     arrive mid-flight are DROPPED (this paces fetches/sends).
//   • chrome: title row + separator on top; an error banner + a footer (status
//     left, keymap hints right) on the bottom; the view gets the content Rect.
//   • loop: parseKeypress → view.onKey → ViewAction → render; refreshMs polling;
//     resize → render (NOT refresh) so a resize mid-fetch repaints from current
//     state without re-entering the in-flight hook.

import {
  setupTerminal,
  restoreTerminal,
  getTerminalSize,
  parseKeypress,
} from './terminal.js';
import { createDraw, detectColorCaps, type ColorCaps, type Draw, type Rect, type Size } from './draw.js';
import type { ViewModule, ViewHost, ViewAction, ViewManifest } from './contract.js';

export interface RunViewOptions {
  /** CLI flags forwarded verbatim to the view via host.options. */
  options?: Record<string, string>;
}

const FG_RED = '31';

interface Chrome {
  status: string | null;
  error: string | null;
  busy: boolean;
}

/** Draw the host chrome into `draw` and return the content Rect for the view. */
function drawChrome(draw: Draw, size: Size, manifest: ViewManifest, c: Chrome): Rect {
  const { cols, rows } = size;

  // Top: title + (busy indicator) + separator.
  draw.text(0, 0, manifest.title, { bold: true });
  if (c.busy) {
    const tag = '⟳ working…';
    draw.text(0, Math.max(0, cols - tag.length), tag, { dim: true });
  }
  draw.hline(1, 0, cols);

  // Bottom: footer (status left, keymap hints after it), error banner above it.
  const footerRow = rows - 1;
  const hints = (manifest.keymap ?? []).map((h) => `${h.keys} ${h.label}`).join('   ');
  const footer = c.status ? (hints ? `${c.status}   ${hints}` : c.status) : hints;
  draw.text(footerRow, 0, footer, { dim: true });

  let bottomRows = 1;
  if (c.error) {
    draw.text(footerRow - 1, 0, c.error, { fg: FG_RED, bold: true });
    bottomRows = 2;
  }

  const top = 2; // title + separator
  const height = Math.max(1, rows - top - bottomRows);
  return { row: top, col: 0, width: cols, height };
}

/** Host a view in the alt screen until it quits (or Ctrl-C). */
export async function runView<S>(view: ViewModule<S>, opts: RunViewOptions = {}): Promise<void> {
  const options = Object.freeze({ ...(opts.options ?? {}) });

  const chrome: Chrome = { status: null, error: null, busy: false };
  const host: ViewHost = {
    options,
    setStatus(msg) { chrome.status = msg; },
    setError(msg) { chrome.error = msg; },
  };

  // ── Non-TTY / piped path: build state, best-effort load, dump, exit 0. ──
  if (!process.stdin.isTTY) {
    const state = await view.init(host);
    if (view.refresh) {
      try { await view.refresh(state, host); } catch { /* dump current state regardless */ }
    }
    let text = view.dump(state);
    if (!text.endsWith('\n')) text += '\n';
    process.stdout.write(text);
    return;
  }

  const caps: ColorCaps = detectColorCaps();
  const state = await view.init(host);

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
    const content = drawChrome(draw, size, view.manifest, chrome);
    try {
      view.render(state, draw, content);
    } catch (e) {
      chrome.error = `render error: ${errText(e)}`;
    }
    process.stdout.write(frame());
  };

  // The single-flight lane. Returns true if the op ran (false if one was already
  // in flight). Always repaints around the op so the busy indicator shows.
  let busy = false;
  const runRefresh = async (): Promise<void> => {
    if (!view.refresh || busy) return;
    busy = true;
    chrome.busy = true;
    render();
    try {
      await view.refresh(state, host);
    } catch (e) {
      chrome.error = errText(e);
    } finally {
      busy = false;
      chrome.busy = false;
      render();
    }
  };

  setupTerminal();
  render();          // initial loading paint (before any fetch)
  await runRefresh(); // first data load

  await new Promise<void>((resolveLoop) => {
    let done = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      cleanup();
      resolveLoop();
    };

    if (typeof view.manifest.refreshMs === 'number' && view.manifest.refreshMs > 0) {
      timer = setInterval(() => { void runRefresh(); }, view.manifest.refreshMs);
    }

    const apply = async (action: ViewAction): Promise<void> => {
      switch (action.type) {
        case 'render': render(); break;
        case 'refresh': await runRefresh(); break;
        case 'quit': finish(); break;
        case 'none': break;
      }
    };

    const onData = async (data: Buffer): Promise<void> => {
      if (done) return;
      let parsed: { input: string; key: ReturnType<typeof parseKeypress>['key'] };
      try { parsed = parseKeypress(data); } catch { return; }
      const { input, key } = parsed;

      // Ctrl-C is the universal escape hatch — works even mid-flight.
      if (key.ctrl && input === 'c') { finish(); return; }

      // Drop keystrokes while an async op is in flight (paces fetch/send).
      if (busy) return;

      if (!view.onKey) {
        if (input === 'q') finish(); // minimal default so a no-onKey view escapes
        return;
      }

      try {
        const r = view.onKey({ input, key }, state, host);
        let action: ViewAction;
        if (r instanceof Promise) {
          busy = true;
          chrome.busy = true;
          render();
          try {
            action = await r;
          } finally {
            busy = false;
            chrome.busy = false;
          }
        } else {
          action = r;
        }
        await apply(action);
      } catch (e) {
        chrome.error = errText(e);
        render();
      }
    };

    process.stdin.on('data', (d: Buffer) => { void onData(d); });
    // Resize → repaint from current state (never re-enter the in-flight hook).
    process.stdout.on('resize', () => { if (!done) render(); });
  });
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
