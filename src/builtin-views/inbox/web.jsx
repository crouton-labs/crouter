// @ts-check
/**
 * Combined `inbox` view — the WEB presenter (React + Tailwind). Browser-only:
 * consumed solely by the web serve path (Vite owns JSX + Tailwind); NEVER
 * Node-imported. The default export is a pure function of `state`; DOM events
 * call `dispatch(intentName, payload?)`.
 *
 * Same logical model as the TUI presenter (merged `state.rows` + `state.cursor`
 * + `state.thread`) read from the SAME portable `core.mjs` — zero shared
 * rendering code with `tui.mjs`. The outer chrome (title / status / banner) is
 * rendered by `<ViewChrome>`, which wraps this component — so do NOT render it.
 *
 * @module inbox/web
 */

import { Loading, Empty, ErrorState, NotReady } from '@crouton-kit/crouter/web';
import { badgeFor, pickGuided, EMOJIS, relTimestamp, dayKey, dayLabel } from './core.mjs';

/** @typedef {import('./core.mjs').InboxState} InboxState */

// ── Source badge hues (the web analog of tui.mjs's NUMERIC-SGR badge map) ─────

const BADGE_CLS = { linkedin: 'text-cyan-600', gmail: 'text-red-600' };

/** @param {{ row: import('./core.mjs').UnifiedRow, selected: boolean, onClick: () => void }} props */
function Row({ row, selected, onClick }) {
  const cls = BADGE_CLS[row.sourceId] || 'text-slate-400';
  const snip = (row.snippet || '').replace(/\s+/g, ' ').trim();
  const ts = relTimestamp(row.ts);
  return (
    <li
      onClick={onClick}
      className={`flex items-baseline gap-1.5 rounded px-2 py-1 cursor-pointer ${selected ? 'bg-slate-200' : 'hover:bg-slate-100'}`}
    >
      <span className={`shrink-0 ${row.unread ? 'text-cyan-600' : 'text-transparent'}`}>●</span>
      <span className={`shrink-0 font-bold ${cls}`}>{badgeFor(row.sourceId).glyph}</span>
      <span className={`shrink-0 ${row.unread ? 'font-semibold' : ''}`}>{row.name || 'Unknown'}</span>
      {snip ? <span className="truncate text-slate-400">{snip}</span> : null}
      {ts ? <span className="ml-auto shrink-0 text-slate-400">{ts}</span> : null}
    </li>
  );
}

// ── Thread detail (the web analog of tui.mjs's renderDetail) ──────────────────

/** @param {{ state: InboxState, dispatch: (i:string,p?:unknown)=>void }} props */
function Detail({ state, dispatch }) {
  if (!state.openKey || !state.thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-400">
        <div>✉ No conversation open</div>
        <div className="text-slate-500">Click a conversation to open it.</div>
      </div>
    );
  }
  const thread = state.thread;
  const messages = thread.messages || [];
  let prevDay = null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 pb-1">
        <div className="font-semibold">{thread.title || 'Conversation'}</div>
        {thread.subtitle ? <div className="text-slate-400">{thread.subtitle}</div> : null}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <div className="text-slate-400">Loading messages…</div>
        ) : (
          messages.map((m, i) => {
            const day = dayKey(m.ts);
            const divider = m.ts && day !== prevDay ? dayLabel(m.ts) : null;
            if (m.ts) prevDay = day;
            return (
              <div key={i}>
                {divider ? <div className="my-1 text-center text-xs text-slate-400">── {divider} ──</div> : null}
                {m.fromMe ? (
                  <div className="border-l-2 border-green-600 pl-2">
                    <div className="font-semibold text-green-700">You</div>
                    <div className="whitespace-pre-wrap">{m.text}</div>
                  </div>
                ) : (
                  <div className="mb-2">
                    <div className="font-semibold text-cyan-700">{m.sender || 'Them'}</div>
                    <div className="whitespace-pre-wrap">{m.text}</div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {state.mode === 'reply' ? (
        <div className="border-t border-slate-200 pt-2">
          <textarea
            autoFocus
            value={state.draft}
            onChange={(e) => dispatch('setDraft', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatch('submitReply'); }
              else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancelCompose'); }
            }}
            className="w-full rounded border border-slate-300 p-2 font-mono text-sm outline-none focus:border-slate-500"
            rows={3}
            placeholder="Type a reply…"
          />
          <div className="mt-1 flex gap-2">
            <button type="button" onClick={() => dispatch('submitReply')} className="rounded bg-slate-700 px-3 py-1 text-white hover:bg-slate-800">Send</button>
            <button type="button" onClick={() => dispatch('cancelCompose')} className="rounded border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      ) : null}

      {state.mode === 'react' ? (
        <div className="border-t border-slate-200 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-600">☺ React</span>
            {EMOJIS.map((emoji, i) => (
              <button
                type="button"
                key={emoji}
                onClick={() => dispatch('submitReact', i)}
                className={`rounded px-2 py-1 text-lg ${i === state.reactCursor ? 'bg-slate-200' : 'hover:bg-slate-100'}`}
              >
                {emoji}
              </button>
            ))}
            <button type="button" onClick={() => dispatch('cancelCompose')} className="ml-auto rounded border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── The view ───────────────────────────────────────────────────────────────────

/**
 * @param {import('../../core/view/contract.js').ViewProps<InboxState>} props
 */
export default function Inbox({ state, dispatch }) {
  // ── Whole-view states (no rows). ──
  if (state.rows.length === 0) {
    if (state.lastFetch === 0) return <Loading label="Loading inbox…" />;
    const guide = pickGuided(state);
    if (guide) {
      const d = guide.d;
      const Takeover = d.level === 'error' ? ErrorState : NotReady;
      return (
        <Takeover
          headline={`${guide.label}: ${d.headline}`}
          explanation={d.explanation}
          nextStep={d.nextStep || undefined}
          onRetry={() => dispatch('refresh')}
        />
      );
    }
    return <Empty label="All caught up — no messages." />;
  }

  return (
    <div
      className="flex h-full gap-3 font-mono text-sm outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (state.mode !== 'list') return;
        if (e.key === 'j' || e.key === 'ArrowDown') { dispatch('cursorDown'); e.preventDefault(); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { dispatch('cursorUp'); e.preventDefault(); }
        else if (e.key === 'Enter') { dispatch('open', state.cursor); e.preventDefault(); }
        else if (e.key === 'g') { dispatch('refresh'); }
        else if (e.key === 'r') { dispatch('startReply'); }
        else if (e.key === 'e') { dispatch('startReact'); }
        else if (e.key === 'f') { dispatch('cycleFilter'); }
      }}
    >
      <ul className="w-2/5 shrink-0 overflow-y-auto border-r border-slate-200 pr-2">
        {state.rows.map((row, i) => (
          <Row key={row.key} row={row} selected={i === state.cursor} onClick={() => dispatch('open', i)} />
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        <Detail state={state} dispatch={dispatch} />
      </div>
    </div>
  );
}
