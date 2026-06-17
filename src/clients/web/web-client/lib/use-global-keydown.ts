/**
 * A reusable global keydown hook (design R2). Mirrors the ⌥I / ⌥D precedent:
 * one window keydown listener, suppressed while any editable element has focus
 * (typing must win), matched on a caller-supplied predicate. The matcher should
 * key on `e.code` (layout-stable) and the modifier flags. Handler + matcher are
 * held in refs so the listener registers exactly once and never re-binds, yet
 * always sees the latest closures.
 */

import { useEffect, useRef } from 'react';

export function useGlobalKeydown(
  matcher: (e: KeyboardEvent) => boolean,
  handler: (e: KeyboardEvent) => void,
): void {
  const matcherRef = useRef(matcher);
  const handlerRef = useRef(handler);
  matcherRef.current = matcher;
  handlerRef.current = handler;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Never fire while an editable element has focus — typing must win.
      const el = document.activeElement;
      if (
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      )
        return;
      if (!matcherRef.current(e)) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
