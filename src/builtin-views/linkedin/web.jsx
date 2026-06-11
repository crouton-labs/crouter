// @ts-check
/**
 * LinkedIn Messages — the WEB presenter for the `linkedin` view (React +
 * Tailwind). Browser-only: consumed solely by the web serve path (Vite owns JSX
 * + Tailwind); NEVER Node-imported. The default export is a pure function of
 * `state`; DOM events call `dispatch(intentName, payload?)`.
 *
 * Same logical model as the TUI presenter (the two-pane inbox: conversation list
 * 1 : thread 2, compose/react modes, the discover→auth→settle recovery panel)
 * read from the SAME portable `core.mjs` — zero shared rendering code with
 * `tui.mjs`. The recovery / degraded panels render the typed `SourceError.
 * display` VERBATIM (the contract display/kind split): the presenter maps only
 * `display.level` → a four-state component, never branching on `kind`. Outer
 * chrome (title / status / banner / chip) is rendered by `<ViewChrome>`.
 *
 * @module linkedin/web
 */

import { relTimestamp, EMOJIS } from './core.mjs';
import { Loading, Empty, ErrorState, NotReady } from '@crouton-kit/crouter/web';

/** @typedef {import('./core.mjs').LiState} LiState */

// ── Recovery takeover (renders display.* VERBATIM; level → component) ──────────

/** @param {{ rec: import('./core.mjs').Recovery, dispatch: (i:string, p?:unknown)=>void }} props */
function Recovery({ rec, dispatch }) {
  const d = rec.display;
  if (rec.spinner) return <Loading label={d.headline} />;
  const Comp = d.level === 'error' ? ErrorState : NotReady;
  return (
    <Comp
      headline={d.headline}
      explanation={d.explanation}
      nextStep={d.nextStep || undefined}
      onRetry={() => dispatch('refresh')}
    />
  );
}

// ── Conversation list (left pane) ──────────────────────────────────────────────

/** @param {{ state: LiState, dispatch: (i:string, p?:unknown)=>void }} props */
function ConvoList({ state, dispatch }) {
  return (
    <ul className="divide-y divide-slate-100 overflow-y-auto">
      {state.convos.map((c, i) => {
        const selected = i === state.convCursor;
        const open = c.urn === state.openUrn;
        const ts = relTimestamp(c.ts);
        return (
          <li
            key={c.urn || i}
            onClick={() => dispatch('openThread', i)}
            className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 ${selected ? 'bg-slate-100' : ''} ${open ? 'border-l-2 border-cyan-500' : 'border-l-2 border-transparent'}`}
          >
            <span className={`shrink-0 ${c.unread ? 'text-cyan-600' : 'text-transparent'}`}>●</span>
            <span className="min-w-0 flex-1">
              <span className={c.unread ? 'font-semibold' : ''}>{c.name || 'Unknown'}</span>
              {c.lastMessage ? (
                <span className="ml-2 truncate text-slate-400">{c.lastMessage.replace(/\s+/g, ' ').trim()}</span>
              ) : null}
            </span>
            {ts ? <span className="shrink-0 text-xs text-slate-400">{ts}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

// ── Thread (right pane) ────────────────────────────────────────────────────────

/** @param {{ m: import('./core.mjs').Message }} props */
function MessageGroup({ m }) {
  const ts = relTimestamp(m.ts);
  if (m.fromMe) {
    return (
      <div className="border-l-2 border-green-500 pl-2">
        <div className="flex items-baseline justify-between">
          <span className="font-semibold text-green-600">You</span>
          {ts ? <span className="text-xs text-slate-400">{ts}</span> : null}
        </div>
        <div className="whitespace-pre-wrap text-slate-700">{m.text}</div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-semibold text-cyan-700">{m.sender || 'Them'}</span>
        {ts ? <span className="text-xs text-slate-400">{ts}</span> : null}
      </div>
      <div className="whitespace-pre-wrap text-slate-700">{m.text}</div>
    </div>
  );
}

/** @param {{ state: LiState, dispatch: (i:string, p?:unknown)=>void }} props */
function Thread({ state, dispatch }) {
  const openConvo = state.openUrn ? state.convos.find((c) => c.urn === state.openUrn) : null;
  if (!state.openUrn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-slate-400">
        <div>✉ No conversation open</div>
        <div className="text-sm">Select a conversation to open it.</div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between border-b border-slate-200 px-3 py-2">
        <span className="font-semibold">{openConvo ? openConvo.name : 'Conversation'}</span>
        {openConvo && relTimestamp(openConvo.ts) ? (
          <span className="text-xs text-slate-400">{relTimestamp(openConvo.ts)}</span>
        ) : null}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {state.thread.length === 0 ? (
          <div className="text-slate-400">Loading messages…</div>
        ) : (
          state.thread.map((m, i) => <MessageGroup key={m.urn || i} m={m} />)
        )}
      </div>
      {state.mode === 'reply' ? <Composer state={state} dispatch={dispatch} /> : null}
      {state.mode === 'react' ? <ReactBar state={state} dispatch={dispatch} /> : null}
    </div>
  );
}

/** @param {{ state: LiState, dispatch: (i:string, p?:unknown)=>void }} props */
function Composer({ state, dispatch }) {
  return (
    <div className="border-t border-slate-200 p-2">
      <textarea
        autoFocus
        rows={2}
        value={state.draft}
        placeholder="Reply…  (Enter to send · Esc to cancel)"
        onChange={(e) => dispatch('setDraft', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatch('submitReply'); }
          else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancelCompose'); }
        }}
        className="w-full resize-none rounded border border-slate-300 p-2 font-mono text-sm outline-none focus:border-amber-500"
      />
    </div>
  );
}

/** @param {{ state: LiState, dispatch: (i:string, p?:unknown)=>void }} props */
function ReactBar({ state, dispatch }) {
  return (
    <div className="flex items-center gap-2 border-t border-slate-200 p-2">
      <span className="text-amber-600">☺ React</span>
      {EMOJIS.map((e, i) => (
        <button
          key={e}
          type="button"
          onClick={() => { dispatch('reactPick', i); dispatch('submitReact'); }}
          className={`rounded px-2 py-1 text-lg ${i === state.reactCursor ? 'bg-slate-200' : ''} hover:bg-slate-100`}
        >
          {e}
        </button>
      ))}
      <button type="button" onClick={() => dispatch('cancelCompose')} className="ml-auto text-sm text-slate-500 hover:text-slate-700">
        Esc cancel
      </button>
    </div>
  );
}

// ── The view ───────────────────────────────────────────────────────────────────

/** @param {import('../../core/view/contract.js').ViewProps<LiState>} props */
export default function LinkedIn({ state, dispatch }) {
  if (state.recovery) return <Recovery rec={state.recovery} dispatch={dispatch} />;

  if (state.convos.length === 0) {
    if (state.lastFetch === 0) return <Loading label="Loading conversations…" />;
    return <Empty label="All caught up — no conversations in your inbox." />;
  }

  return (
    <div
      className="grid h-full grid-cols-3 font-mono text-sm outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (state.mode !== 'list') return;
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); dispatch('cursorDown'); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); dispatch('cursorUp'); }
        else if (e.key === 'Enter') { e.preventDefault(); dispatch('openThread', state.convCursor); }
        else if (e.key === 'r') { e.preventDefault(); dispatch('startReply'); }
        else if (e.key === 'e') { e.preventDefault(); dispatch('startReact'); }
        else if (e.key === 'g') { dispatch('refresh'); }
      }}
    >
      <div className="col-span-1 border-r border-slate-200">
        <ConvoList state={state} dispatch={dispatch} />
      </div>
      <div className="col-span-2">
        <Thread state={state} dispatch={dispatch} />
      </div>
    </div>
  );
}
