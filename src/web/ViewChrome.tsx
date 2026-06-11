// ViewChrome.tsx — the web rendering of ChromeState (the host signals a core
// raises via ctx.signal). It is the web analog of the TUI host's drawChrome:
// a header with the title, the derived state chip, mode pill, subtitle, busy
// spinner, status line, and a banner alert bar — then the view's component as
// its children. Both targets derive the one state chip from the SAME
// deriveState (src/core/view/chrome.ts) so they never drift.

import type { JSX, ReactNode } from 'react';
import type { ChromeState } from '../core/view/contract.js';
import { deriveState, type ChipState } from '../core/view/chrome.js';

const CHIP_LABEL: Record<ChipState, string> = {
  working: 'working',
  blocked: 'blocked',
  attention: 'attention',
  ready: 'ready',
  idle: 'idle',
};

const CHIP_DOT: Record<ChipState, string> = {
  working: 'bg-blue-500',
  blocked: 'bg-red-500',
  attention: 'bg-amber-500',
  ready: 'bg-green-500',
  idle: 'bg-slate-400',
};

const BANNER_BAR: Record<'info' | 'action' | 'error', string> = {
  info: 'bg-slate-100 text-slate-800 border-slate-300',
  action: 'bg-amber-100 text-amber-900 border-amber-300',
  error: 'bg-red-100 text-red-900 border-red-300',
};

export function ViewChrome(
  { chrome, title, children }:
  { chrome: ChromeState; title: string; children: ReactNode },
): JSX.Element {
  // deriveState's contract: an explicit interaction mode overrides the derived
  // chip, and each target's renderer applies that precedence. Web keeps the mode
  // as its own header pill (the §4.1 web idiom) AND lets it win the chip.
  const chip = chrome.mode ? 'attention' : deriveState(chrome);
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-2">
        <h1 className="font-mono text-sm font-semibold">{title}</h1>
        {chrome.subtitle ? (
          <span className="font-mono text-xs text-slate-400">· {chrome.subtitle}</span>
        ) : null}
        {chrome.mode ? (
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-white">{chrome.mode}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {chrome.busy ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          ) : null}
          <span className={`inline-block h-2 w-2 rounded-full ${CHIP_DOT[chip]}`} />
          <span>{CHIP_LABEL[chip]}</span>
        </span>
      </header>

      {chrome.banner ? (
        <div className={`border-b px-4 py-1.5 font-mono text-xs ${BANNER_BAR[chrome.banner.level]}`}>
          {chrome.banner.msg}
        </div>
      ) : null}

      <main className="px-4 py-3">{children}</main>

      {chrome.status ? (
        <footer className="border-t border-slate-200 px-4 py-1.5 font-mono text-xs text-slate-500">
          {chrome.status}
        </footer>
      ) : null}
    </div>
  );
}
