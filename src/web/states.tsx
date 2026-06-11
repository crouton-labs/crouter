// states.tsx — the web four-state vocabulary (loading / empty / error /
// not-ready). The portable SEMANTICS live in the core (state flags or a
// SourceError.display with blocking:true); this is the web PAINT of them, the
// React analog of the TUI's _lib/states.mjs draw helpers. A view's web.jsx
// imports these so the four states look consistent across views; there is no
// shared rendering code with the TUI, only the shared vocabulary.

import type { JSX, ReactNode } from 'react';

function Center({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 p-8 text-center font-mono text-sm text-slate-600">
      {children}
    </div>
  );
}

/** Initial load, before the first source resolves. */
export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <Center>
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      <span>{label}</span>
    </Center>
  );
}

/** Resolved, but nothing to show. */
export function Empty({ label = 'Nothing here yet.' }: { label?: string }): JSX.Element {
  return (
    <Center>
      <span className="text-slate-400">{label}</span>
    </Center>
  );
}

/** A non-blocking-or-blocking failure — renders a SourceError.display verbatim. */
export function ErrorState(
  { headline, explanation, nextStep, onRetry }:
  { headline: string; explanation?: string; nextStep?: string; onRetry?: () => void },
): JSX.Element {
  return (
    <Center>
      <div className="font-semibold text-red-700">{headline}</div>
      {explanation ? <div className="text-slate-600">{explanation}</div> : null}
      {nextStep ? <div className="text-slate-500">{nextStep}</div> : null}
      {onRetry ? <RetryButton onRetry={onRetry} /> : null}
    </Center>
  );
}

/** A precondition isn't met (e.g. not a repo / unauthed) — same shape as
 *  ErrorState but named for the "not ready to run here" case. */
export function NotReady(
  { headline = 'Not ready', explanation, nextStep, onRetry }:
  { headline?: string; explanation?: string; nextStep?: string; onRetry?: () => void },
): JSX.Element {
  return (
    <Center>
      <div className="font-semibold text-amber-700">{headline}</div>
      {explanation ? <div className="text-slate-600">{explanation}</div> : null}
      {nextStep ? <div className="text-slate-500">{nextStep}</div> : null}
      {onRetry ? <RetryButton onRetry={onRetry} /> : null}
    </Center>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="mt-2 rounded border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-100"
    >
      Retry
    </button>
  );
}
