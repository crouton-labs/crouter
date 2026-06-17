// @ts-check
/**
 * Prompt Studio — web presenter for the `prompt-review` builtin.
 *
 * Browser-only. Pure read of state; all data/behavior live in core.mjs.
 *
 * @module prompt-review/web
 */

import { useEffect, useMemo, useRef } from 'react';
import { Loading, NotReady, ErrorState, Empty } from '@crouton-kit/crouter/web';
import { toast } from '../../clients/web/web-client/lib/toast.js';
import { configHeadline, diffReviews, selectedLayer, compareSelectedLayer, kindLabel, layerLabel } from './core.mjs';

/** @typedef {import('./core.mjs').ReviewState} ReviewState */

const BUDGET = 200_000;

const GROUP_STYLES = {
  protocol: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  persona: 'border-amber-200 bg-amber-50 text-amber-800',
  generated: 'border-violet-200 bg-violet-50 text-violet-800',
  substrate: 'border-lime-200 bg-lime-50 text-lime-800',
};
const SCOPE_STYLES = {
  builtin: 'border-slate-200 bg-slate-50 text-slate-700',
  project: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  user: 'border-amber-200 bg-amber-50 text-amber-800',
  generated: 'border-violet-200 bg-violet-50 text-violet-800',
  runtime: 'border-lime-200 bg-lime-50 text-lime-800',
};
const DIFF_STYLES = {
  added: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  removed: 'border-rose-200 bg-rose-50 text-rose-800',
  changed: 'border-amber-200 bg-amber-50 text-amber-800',
};

/** @param {string} kind */
function kindChipCls(kind) {
  if (!kind) return 'border-slate-200 bg-slate-50 text-slate-700';
  if (kind === 'base') return 'border-cyan-200 bg-cyan-50 text-cyan-800';
  if (kind === 'orchestrator') return 'border-violet-200 bg-violet-50 text-violet-800';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

/** @param {string} scope */
function scopeCls(scope) {
  return SCOPE_STYLES[scope] || 'border-slate-200 bg-slate-50 text-slate-700';
}

/** @param {string} group */
function groupCls(group) {
  return GROUP_STYLES[group] || 'border-slate-200 bg-slate-50 text-slate-700';
}

/** @param {number} n @returns {string} */
function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0)));
}

/** @param {string} text @returns {string[]} */
function lines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

/** @param {string} text @returns {string} */
function snippet(text) {
  return lines(text)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
}

/** @param {string} text @returns {string} */
function maybeEllipsize(text) {
  const s = String(text || '');
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

/** @param {string} text */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} label @param {string} value @param {string} cls */
function Pill({ label, value, cls }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${cls}`}><span className="opacity-60">{label}</span><span className="font-semibold">{value}</span></span>;
}

/** @param {{ label: string, active?: boolean, onClick: () => void, className?: string, title?: string, children: any }} props */
function Button(props) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={`rounded-lg border px-3 py-1.5 text-left text-sm transition ${props.active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'} ${props.className || ''}`}
    >
      {props.children}
    </button>
  );
}

/** @param {{ state: ReviewState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function ConfigPanel({ state, dispatch }) {
  const kinds = state.list?.kinds || [{ kind: state.config.kind, whenToUse: '' }];
  const modeSet = state.list?.modes || ['base', 'orchestrator'];
  const lifecycleSet = state.list?.lifecycles || ['terminal', 'resident'];
  const kindSub = state.list?.subPersonas?.[state.config.kind] || [];
  const currentNodeLabel = state.config.node ? (state.liveNodes.find((n) => n.node_id === state.config.node)?.name || state.config.node) : 'none';

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Config</div>
        <div className="mt-1 text-sm text-slate-600">{configHeadline(state.config)}</div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Kind</div>
          <select
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
            value={state.config.kind}
            onChange={(e) => dispatch('setKind', e.target.value)}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>{k.kind}</option>
            ))}
          </select>
          {kindSub.length ? <div className="mt-2 text-xs text-slate-500">Sub-personas: {kindSub.map((k) => k.kind).join(', ')}</div> : <div className="mt-2 text-xs text-slate-400">No sub-personas listed.</div>}
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Mode</div>
          <div className="grid grid-cols-2 gap-2">
            {modeSet.map((mode) => <Button key={mode} label={mode} active={state.config.mode === mode} onClick={() => dispatch('setMode', mode)}><span className="capitalize">{mode}</span></Button>)}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Lifecycle</div>
          <div className="grid grid-cols-2 gap-2">
            {lifecycleSet.map((value) => <Button key={value} label={value} active={state.config.lifecycle === value} onClick={() => dispatch('setLifecycle', value)}><span className="capitalize">{value}</span></Button>)}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Has manager</div>
          <button
            type="button"
            onClick={() => dispatch('toggleHasManager')}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm ${state.config.hasManager ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
          >
            <span>{state.config.hasManager ? 'yes' : 'no'}</span>
            <span className="text-xs opacity-60">re-fetches prompt</span>
          </button>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Node</div>
          <select
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
            value={state.config.node || ''}
            onChange={(e) => dispatch('setNode', e.target.value || null)}
          >
            <option value="">none</option>
            {state.liveNodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} · {node.kind} · {node.status}</option>)}
          </select>
          <div className="mt-2 text-xs text-slate-500">{currentNodeLabel}</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Sub-personas</div>
          {kindSub.length ? (
            <div className="mt-2 space-y-2">
              {kindSub.map((item) => (
                <div key={item.kind} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <div className="font-medium text-slate-900">{item.kind}</div>
                  <div className="text-xs text-slate-500">{item.whenToUse}</div>
                </div>
              ))}
            </div>
          ) : <div className="mt-2 text-xs text-slate-500">No sub-persona entries for this kind.</div>}
        </div>
      </div>
    </section>
  );
}

/** @param {{ layer: import('./core.mjs').PromptLayer, state: ReviewState, selected: boolean, dispatch: (intent:string, payload?:unknown)=>void }} props */
function LayerBlock({ layer, state, selected, dispatch }) {
  const expanded = !!state.expanded[layer.id];
  const included = layer.included;
  const opacity = included ? 'opacity-100' : 'opacity-55';
  const cond = !included && layer.condition ? `✕ ${layer.condition}` : null;
  const source = layer.sourcePath || layer.source;

  return (
    <div className={`rounded-xl border ${selected ? 'border-slate-900 ring-1 ring-slate-900/10' : 'border-slate-200'} bg-white ${opacity}`}>
      <button
        type="button"
        onClick={() => { dispatch('selectLayer', layer.id); dispatch('toggleLayerExpanded', layer.id); }}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <div className="mt-0.5 text-slate-400">{expanded ? '▾' : '▸'}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate font-semibold text-slate-900">{layer.label}</div>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${groupCls(layer.group)}`}>{layer.group}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${scopeCls(layer.scope)}`}>{layer.scope}</span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">≈{fmt(layer.tokens)} tok</span>
            {!included ? <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">excluded</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="truncate">{layer.source}</span>
            {cond ? <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700">{cond}</span> : null}
          </div>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-slate-200 px-3 py-3">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 px-3 py-2 font-mono text-[12px] leading-5 text-slate-100">{layer.text}</pre>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{included ? 'included' : 'excluded'}</span>
            <span>·</span>
            <span>{fmt(layer.chars)} chars</span>
            <span>·</span>
            <span>{source}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** @param {{ state: ReviewState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function AssembledPanel({ state, dispatch }) {
  const review = state.review || [];
  const selected = selectedLayer(state) || review[0] || null;
  const raw = state.assembled || '';
  const budgetPct = Math.min(100, (state.totalTokens / BUDGET) * 100);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Assembled</div>
          <div className="ml-auto flex items-center gap-2">
            <Button label="layered" active={state.viewMode === 'layered'} onClick={() => dispatch('setViewMode', 'layered')} className="px-2 py-1 text-xs"><span>Layered</span></Button>
            <Button label="raw" active={state.viewMode === 'raw'} onClick={() => dispatch('setViewMode', 'raw')} className="px-2 py-1 text-xs"><span>Raw</span></Button>
          </div>
        </div>
        <div className="mt-1 text-sm text-slate-600">{configHeadline(state.config)}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {state.viewMode === 'raw' ? (
          <pre
            className="select-text whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-950 p-4 font-mono text-[12px] leading-5 text-slate-100"
            onMouseUp={(e) => {
              const sel = window.getSelection?.()?.toString() || '';
              dispatch('captureRawSelection', sel);
            }}
          >{raw}</pre>
        ) : (
          <div className="space-y-3">
            {review.map((layer) => <LayerBlock key={layer.id} layer={layer} state={state} selected={selected?.id === layer.id} dispatch={dispatch} />)}
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 p-4">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div>≈{fmt(state.totalTokens)} tokens · {fmt(state.totalChars)} chars</div>
          <div>{Math.round(budgetPct)}% of {fmt(BUDGET)} budget</div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full ${budgetPct > 90 ? 'bg-rose-500' : budgetPct > 75 ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${Math.min(100, budgetPct)}%` }} />
        </div>
      </div>
    </section>
  );
}

/** @param {{ state: ReviewState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function CommentDraft({ state, dispatch }) {
  const draft = state.draftComment;
  if (!draft) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-semibold text-slate-700">Commenting on</span>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-700">{draft.label}</span>
        <span className={`rounded-full border px-2 py-0.5 ${scopeCls(draft.scope)}`}>{draft.scope}</span>
      </div>
      {draft.anchor ? <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-600"><div className="mb-1 font-semibold text-slate-500">Anchor</div><pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{draft.anchor}</pre></div> : null}
      <textarea
        autoFocus
        value={draft.body}
        onChange={(e) => dispatch('setCommentBody', e.target.value)}
        rows={4}
        placeholder="Write the review comment here…"
        className="mt-2 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-sm outline-none focus:border-slate-400"
      />
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => dispatch('saveComment')} className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800">Save comment</button>
        <button type="button" onClick={() => dispatch('cancelComment')} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  );
}

/** @param {{ comment: ReviewState['comments'][number], index: number, onDelete: () => void }} props */
function CommentRow({ comment, index, onDelete }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-semibold text-slate-900">{comment.label}</span>
        <span className={`rounded-full border px-2 py-0.5 ${scopeCls(comment.scope)}`}>{comment.scope}</span>
        <span className="ml-auto text-slate-400">#{index + 1}</span>
      </div>
      {comment.anchor ? <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-5 text-slate-600">{comment.anchor}</pre> : null}
      <div className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{comment.body}</div>
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
        {comment.sourcePath ? <span className="truncate">{comment.sourcePath}</span> : <span className="text-slate-400">generated layer</span>}
        <button type="button" onClick={onDelete} className="ml-auto rounded-full border border-slate-200 px-2 py-0.5 hover:bg-slate-50">Remove</button>
      </div>
    </div>
  );
}

/** @param {{ state: ReviewState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function InspectorPanel({ state, dispatch }) {
  const layer = selectedLayer(state) || state.review?.[0] || null;
  const compareLayer = compareSelectedLayer(state) || state.compareReview?.[0] || null;
  const diffs = useMemo(() => diffReviews(state.review || [], state.compareReview || []), [state.review, state.compareReview]);
  const compareCfg = state.compareConfig || state.config;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Inspector</div>
          <button type="button" onClick={() => dispatch('beginComment')} disabled={!layer} className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Add comment</button>
        </div>
        <div className="mt-1 text-sm text-slate-600">{layer ? layer.label : 'No layer selected'}</div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {layer ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-900">{layer.label}</div>
                <div className="mt-1 text-xs text-slate-500">{layer.source}</div>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${groupCls(layer.group)}`}>{layer.group}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <Pill label="scope" value={layer.scope} cls={scopeCls(layer.scope)} />
              <Pill label="status" value={layer.included ? 'included' : 'excluded'} cls={layer.included ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'} />
              <Pill label="tokens" value={`≈${fmt(layer.tokens)}`} cls="border-slate-200 bg-white text-slate-700" />
              <Pill label="chars" value={fmt(layer.chars)} cls="border-slate-200 bg-white text-slate-700" />
            </div>
            {layer.condition ? <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">Condition: {layer.condition}</div> : null}
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <div className="min-w-0 flex-1 truncate font-mono">{layer.sourcePath || 'no source path (generated or runtime-spliced)'}</div>
              {layer.sourcePath ? <button type="button" onClick={async () => { const ok = await copyText(layer.sourcePath || ''); toast(ok ? 'Source path copied' : 'Could not copy source path', ok ? 'success' : 'info'); }} className="rounded-full border border-slate-200 px-2 py-0.5 hover:bg-white">Copy path</button> : null}
            </div>
            <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 px-3 py-2 font-mono text-[12px] leading-5 text-slate-100">{layer.text}</pre>
          </div>
        ) : <Empty label="No layer selected." />}

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Compare</div>
            <button type="button" onClick={() => dispatch('toggleCompareOpen')} className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50">{state.compareOpen ? 'Hide' : 'Show'}</button>
          </div>
          {state.compareOpen ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400" value={compareCfg.kind} onChange={(e) => dispatch('setCompareKind', e.target.value)}>
                  {(state.list?.kinds || [{ kind: compareCfg.kind }]).map((k) => <option key={k.kind} value={k.kind}>{k.kind}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => dispatch('setCompareMode', 'base')} className={`rounded-lg border px-2 py-1 text-sm ${compareCfg.mode === 'base' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>base</button>
                  <button type="button" onClick={() => dispatch('setCompareMode', 'orchestrator')} className={`rounded-lg border px-2 py-1 text-sm ${compareCfg.mode === 'orchestrator' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>orchestrator</button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => dispatch('setCompareLifecycle', 'terminal')} className={`rounded-lg border px-2 py-1 text-sm ${compareCfg.lifecycle === 'terminal' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>terminal</button>
                  <button type="button" onClick={() => dispatch('setCompareLifecycle', 'resident')} className={`rounded-lg border px-2 py-1 text-sm ${compareCfg.lifecycle === 'resident' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>resident</button>
                </div>
                <button type="button" onClick={() => dispatch('toggleCompareHasManager')} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${compareCfg.hasManager ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-slate-200 bg-white text-slate-700'}`}>
                  <span>manager {compareCfg.hasManager ? 'yes' : 'no'}</span>
                  <span className="text-xs opacity-60">compare</span>
                </button>
              </div>
              <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400" value={compareCfg.node || ''} onChange={(e) => dispatch('setCompareNode', e.target.value || null)}>
                <option value="">no node</option>
                {state.liveNodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} · {node.kind} · {node.status}</option>)}
              </select>
              {state.compareReview ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center gap-2 text-xs text-slate-500"><span className="font-semibold text-slate-900">Compared selection</span><span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{compareLayer?.label || 'none'}</span></div>
                  {compareLayer ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 px-3 py-2 font-mono text-[12px] leading-5 text-slate-100">{compareLayer.text}</pre> : null}
                </div>
              ) : <div className="text-xs text-slate-500">Pick a second config to render the diff.</div>}
              <div className="space-y-2">
                {diffs.length ? diffs.map((diff) => (
                  <button key={diff.id} type="button" onClick={() => dispatch('selectCompareLayer', diff.id)} className={`w-full rounded-xl border px-3 py-3 text-left ${DIFF_STYLES[diff.kind] || 'border-slate-200 bg-white text-slate-700'}`}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded-full border border-current/20 bg-white/70 px-2 py-0.5 font-semibold uppercase">{diff.kind}</span>
                      <span className="font-semibold text-slate-900">{diff.label}</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-5">{diff.diffText || diff.summary}</div>
                  </button>
                )) : <div className="text-xs text-slate-500">No differences for the current pair.</div>}
              </div>
            </div>
          ) : <div className="mt-2 text-xs text-slate-500">Compare panel hidden.</div>}
        </div>

        {state.draftComment ? <CommentDraft state={state} dispatch={dispatch} /> : null}

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Comments</div>
          {state.comments.length ? state.comments.map((comment, i) => <CommentRow key={`${comment.layerId}-${i}`} comment={comment} index={i} onDelete={() => dispatch('removeComment', i)} />) : <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No comments yet.</div>}
        </div>
      </div>
    </section>
  );
}

/** @param {{ state: ReviewState, dispatch: (intent:string, payload?:unknown)=>void }} props */
function FooterBar({ state, dispatch }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
      <button type="button" onClick={async () => { const ok = await copyText(state.assembled || ''); toast(ok ? 'Copied assembled prompt' : 'Could not copy assembled prompt', ok ? 'success' : 'info'); }} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 hover:bg-slate-100" disabled={!state.assembled}>Copy raw</button>
      <button type="button" onClick={() => dispatch('toggleCompareOpen')} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 hover:bg-slate-100">Compare configs</button>
      <button type="button" onClick={() => dispatch('exportComments')} className="rounded-full border border-slate-900 bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-800" disabled={!state.review}>Export comments</button>
      <div className="ml-auto text-xs text-slate-500">{state.lastExportPath ? <span className="font-mono">{state.lastExportPath}</span> : <span>Export writes a markdown file and copies its path.</span>}</div>
    </div>
  );
}

/** @param {import('../../core/view/contract.js').ViewProps<ReviewState>} props */
export default function PromptReview({ state, dispatch }) {
  const copiedPathRef = useRef('');
  useEffect(() => {
    if (!state.lastExportPath || state.lastExportPath === copiedPathRef.current) return;
    copiedPathRef.current = state.lastExportPath;
    void (async () => {
      const ok = await copyText(state.lastExportPath || '');
      toast(ok ? `Review copied: ${state.lastExportPath}` : `Export written: ${state.lastExportPath}`, ok ? 'success' : 'info');
    })();
  }, [state.lastExportPath]);

  if (state.sourceError && !state.review) {
    const d = state.sourceError.display;
    const Takeover = d.level === 'error' ? ErrorState : NotReady;
    return <Takeover headline={d.headline} explanation={d.explanation} nextStep={d.nextStep || undefined} onRetry={() => dispatch('refresh')} />;
  }
  if (!state.review) return <Loading label="Loading Prompt Studio…" />;
  if (state.review.length === 0) return <Empty label="No prompt layers were returned." />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-900">
      {state.auxiliaryError ? <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">{state.auxiliaryError.display.explanation || state.auxiliaryError.display.headline}</div> : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 lg:grid-cols-[18rem_minmax(0,1fr)_24rem]">
        <ConfigPanel state={state} dispatch={dispatch} />
        <AssembledPanel state={state} dispatch={dispatch} />
        <InspectorPanel state={state} dispatch={dispatch} />
      </div>
      <FooterBar state={state} dispatch={dispatch} />
    </div>
  );
}
