// context-message.ts — the viewer's foldable renderer for the `<crtr-context>`
// bearings block (a `crtr-context` custom message). The broker runs the
// canvas-context-intro extension, so the VIEWER has no message renderer for it
// and would otherwise show the full block always. This reimplements the
// extension's `renderContextMessage` natively (src/pi-extensions/
// canvas-context-intro.ts): collapsed → one dim line; expanded (Ctrl+O) →
// label + full wrapped body. It implements `setExpanded`, so the Ctrl+O
// tool-output toggle (ChatView.toggleToolsExpanded → isExpandable) folds it
// alongside tool output.

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

/** The label shown in both states. Mirrors the extension's customType stamp. */
const LABEL = 'crtr context';

/** Char-based wrap that never emits an over-width line (pi-tui hard-crashes on
 *  one). Visible-width aware so wide glyphs in the bearings tree count right. */
function wrapLine(line: string, width: number): string[] {
  if (line === '') return [''];
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (cur !== '' && visibleWidth(cur + ch) > width) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

export class ContextMessageComponent implements Component {
  private expanded: boolean;

  constructor(
    private readonly body: string,
    expanded: boolean,
    private readonly dim: (s: string) => string,
    private readonly label: (s: string) => string,
  ) {
    this.expanded = expanded;
  }

  /** Ctrl+O global tool-output toggle (ChatView.isExpandable duck-type). */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const w = width > 0 ? width : 80;
    if (!this.expanded) {
      // Truncate BEFORE painting so the ANSI wrapper never inflates the measured
      // width (an over-wide line aborts the whole TUI render).
      return [this.dim(truncateToWidth(`[${LABEL}] orienting bearings — ctrl+o to expand`, w, '…'))];
    }
    const lines = [this.label(truncateToWidth(`[${LABEL}]`, w, '…')), ''];
    for (const raw of this.body.split('\n')) {
      for (const seg of wrapLine(raw, w)) lines.push(seg);
    }
    return lines;
  }

  invalidate(): void {
    /* stateless — nothing to clear */
  }
}
