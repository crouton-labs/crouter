/**
 * Meta strip (2b) — one quiet mono line of node context for the `chrome` slot.
 * Quiet Instrument `.meta-strip`: mono, dim, with `·` separators and git
 * add/mod hues. Format: ⎇ main +3 ~2 · ~/Code/project · claude-fable-5 · ctx 31k / 1M
 */

import { Fragment, type ReactNode } from 'react';
import { GitBranch } from 'lucide-react';
import type { NodeDetail } from '@/shared/protocol.js';
import type { NodeChrome } from '../store/session-store.js';

interface Props {
  store: { chrome: NodeChrome };
  detail: NodeDetail | null;
}

export function MetaStrip({ store, detail }: Props): ReactNode {
  const chrome = store.chrome;
  const parts: ReactNode[] = [];

  // Branch + git status
  const branch = chrome.branch ?? detail?.branch ?? null;
  if (branch !== null) {
    const gs = chrome.git_status ?? detail?.git_status ?? null;
    const added = gs?.added ?? 0;
    const modified = gs?.modified ?? 0;

    parts.push(
      <span key="branch" className="inline-flex items-center gap-1.5">
        <GitBranch className="size-3.5 shrink-0 opacity-70" />
        <b style={B}>{branch}</b>
        {added > 0 && (
          <span style={{ color: 'var(--act)', opacity: 0.8 }}> +{added}</span>
        )}
        {modified > 0 && (
          <span style={{ color: 'var(--idle)', opacity: 0.8 }}> ~{modified}</span>
        )}
      </span>,
    );
  }

  // cwd
  const cwd = detail?.cwd ?? null;
  if (cwd !== null) {
    parts.push(<span key="cwd">{abbreviateCwd(cwd)}</span>);
  }

  // model
  const model = chrome.model ?? detail?.model ?? null;
  if (model !== null) {
    parts.push(
      <span key="model">
        <b style={B}>{model}</b>
      </span>,
    );
  }

  // ctx
  const ctx = chrome.context ?? null;
  if (ctx !== null) {
    parts.push(
      <span key="ctx">
        ctx <b style={B}>{fmtK(ctx.tokens)}</b> / {fmtK(ctx.window)}
      </span>,
    );
  }

  if (parts.length === 0) return null;

  return (
    <div
      className="flex min-w-0 items-center gap-5 whitespace-nowrap border-b px-6 py-2 text-xs"
      style={{
        borderColor: 'var(--line)',
        background: 'rgba(0,0,0,.18)',
        fontFamily: 'var(--font-code)',
        color: 'var(--mut)',
      }}
    >
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span style={{ color: 'var(--dim)', opacity: 0.5 }} className="select-none">
              ·
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

const B = { color: 'var(--ink2)', fontWeight: 400 } as const;

/** Abbreviate home directory prefix with ~; fall back to last 2 path segments. */
function abbreviateCwd(cwd: string): string {
  // Heuristic: /Users/<name>/... or /home/<name>/... → ~/...
  const homeMatch = cwd.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/);
  if (homeMatch) return `~${homeMatch[1]}`;
  // Fallback: last 2 segments
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Round a token count to nearest 1k or 1M, formatted compactly. */
function fmtK(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
