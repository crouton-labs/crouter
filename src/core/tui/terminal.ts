// terminal.ts — raw-mode helpers shared by every crtr raw-ANSI TUI.
//
// Moved verbatim from src/core/canvas/browse/terminal.ts (it was already
// generic). Hand-rolled (no deps), mirroring humanloop's src/tui/terminal.ts.
// Extends its key parsing beyond up/down/return/escape/tab/backspace/ctrl +
// printable input: adds leftArrow/rightArrow (cursor keys) and shiftTab
// (`\x1b[Z`) so callers can drive tree expand/collapse and tab cycling.

export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  tab: boolean;
  shiftTab: boolean;
  backspace: boolean;
}

function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    tab: false,
    shiftTab: false,
    backspace: false,
  };
}

export function parseKeypress(data: Buffer): { input: string; key: Key } {
  const str = data.toString('utf8');
  const key = emptyKey();

  if (str === '\x1b[A') { key.upArrow = true; return { input: '', key }; }
  if (str === '\x1b[B') { key.downArrow = true; return { input: '', key }; }
  if (str === '\x1b[C') { key.rightArrow = true; return { input: '', key }; }
  if (str === '\x1b[D') { key.leftArrow = true; return { input: '', key }; }
  if (str === '\x1b[Z') { key.shiftTab = true; return { input: '', key }; }
  if (str === '\r' || str === '\n') { key.return = true; return { input: '', key }; }
  // Alt+Backspace: terminals send ESC followed by DEL/BS. Must precede the
  // bare-ESC check so the two-byte sequence isn't swallowed as plain escape.
  if (str === '\x1b\x7f' || str === '\x1b\b') {
    key.meta = true;
    key.backspace = true;
    return { input: '', key };
  }
  if (str === '\x1b') { key.escape = true; return { input: '', key }; }
  if (str === '\t') { key.tab = true; return { input: '', key }; }
  if (str === '\x7f' || str === '\b') { key.backspace = true; return { input: '', key }; }

  if (str.length === 1 && str.charCodeAt(0) < 32) {
    key.ctrl = true;
    const ch = String.fromCharCode(str.charCodeAt(0) + 64).toLowerCase();
    return { input: ch, key };
  }

  // Multi-byte chunks (paste, multi-byte UTF-8, unknown escape sequences) are
  // returned as-is in `input`; the input-mode handler sanitises them before
  // appending to its buffer. Top-level handlers ignore strings of length > 1.
  return { input: str, key };
}

export function setupTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new Error('this TUI requires an interactive terminal (TTY)');
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l'); // hide cursor
  process.stdout.write('\x1b[?1049h'); // alt screen
  process.stdout.write('\x1b[2J\x1b[H'); // clear
}

export function restoreTerminal(): void {
  process.stdout.write('\x1b[?25h'); // show cursor
  process.stdout.write('\x1b[?1049l'); // restore screen
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

export function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}
