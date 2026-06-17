/**
 * Shared composer key handling (design R1). Both the node-page steer composer
 * and the conversations new-chat composer want identical Enter semantics:
 *   - plain Enter        → send
 *   - Shift+Enter        → newline (native; we don't intercept it)
 *   - Alt/Option+Enter   → newline (NOT native — we splice '\n' at the caret of
 *                          the controlled value and restore the cursor)
 * Cmd/Ctrl+Enter is left untouched (never sends here).
 */

import type { KeyboardEvent } from 'react';

export function handleComposerKeyDown(
  e: KeyboardEvent<HTMLTextAreaElement>,
  setValue: (next: string) => void,
  onSend: () => void,
): void {
  if (e.key !== 'Enter') return;

  // Shift+Enter → native newline; let the browser insert it.
  if (e.shiftKey) return;

  // Alt/Option+Enter → newline, but the browser does NOT insert one, so splice
  // it into the controlled value at the caret and restore the cursor after it.
  if (e.altKey) {
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const next = `${ta.value.slice(0, start)}\n${ta.value.slice(end)}`;
    const caret = start + 1;
    setValue(next);
    // Restore the caret after React re-renders the controlled textarea.
    requestAnimationFrame(() => {
      ta.selectionStart = caret;
      ta.selectionEnd = caret;
    });
    return;
  }

  // Cmd/Ctrl+Enter — not our concern; never send on a modifier here.
  if (e.metaKey || e.ctrlKey) return;

  // Plain Enter → send.
  e.preventDefault();
  onSend();
}
