// ConversationPane.tsx — the broker-protocol browser client (design §4.2): a
// self-contained `<ConversationPane nodeId />` that connects to a node's
// already-running broker over the `crtr web` WS relay, renders the conversation
// snapshot + live stream, and drives the agent (request-control, prompt/steer/
// abort, answer extension_ui dialogs). It is the React parallel of `crtr attach`.
//
// Component contract: NO shell assumptions. WS is same-origin (`/node/<id>` on the
// page's own host — the relay in the shipped shell, the Vite proxy in dev). The
// only outward seam is `onWake`: waking a dormant node goes through the bridge
// COMMAND path (`crtr canvas revive`, design §6), which the shell owns — the pane
// calls the injected `onWake` then re-dials. Drive (prompt/steer/abort, control)
// is NOT a command; it rides broker frames over this socket (design §6 split).
//
// Deferred per design (NOT built): slash-commands, model/thinking cycling,
// clipboard-image paste, follow_up, tree rewind.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Dialog } from './Dialog.js';
import { Transcript } from './TranscriptView.js';
import { useBroker, type ConnPhase, type PaneState } from './useBroker.js';

export interface ConversationPaneProps {
  nodeId: string;
  /** Wake a dormant node. The shell wires this to the bridge command path
   *  (`crtr canvas revive <id>`); when omitted, the [Wake] affordance explains
   *  that waking is unavailable in this host. */
  onWake?: (nodeId: string) => Promise<void> | void;
}

export function ConversationPane({ nodeId, onWake }: ConversationPaneProps): JSX.Element {
  const { state, actions } = useBroker(nodeId);

  // Auto-clear a transient notice after 3s (parity with attach's footer notice).
  useEffect(() => {
    if (state.notice === null) return;
    const t = setTimeout(() => actions.clearNotice(), 3000);
    return () => clearTimeout(t);
  }, [state.notice, actions]);

  return (
    <div className="relative flex h-full flex-col bg-neutral-950 text-neutral-100">
      <Header nodeId={nodeId} state={state} actions={actions} />
      <ScrollBody state={state} />
      <Displays state={state} placement="aboveEditor" />
      <Composer state={state} actions={actions} />
      <Displays state={state} placement="belowEditor" />
      {state.notice && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded bg-amber-600/90 px-3 py-1 text-sm text-white shadow">
          ⚠ {state.notice}
        </div>
      )}
      {state.dialog && (
        <Dialog request={state.dialog} onAnswer={actions.answerDialog} onCancel={actions.cancelDialog} />
      )}
      <ConnOverlay conn={state.conn} nodeId={nodeId} onWake={onWake} reconnect={actions.reconnect} />
    </div>
  );
}

const PHASE_DOT: Record<ConnPhase, string> = {
  open: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  closed: 'bg-amber-500 animate-pulse',
  'no-broker': 'bg-neutral-500',
  'no-node': 'bg-red-500',
  invalid: 'bg-red-500',
};

function Header({ nodeId, state, actions }: { nodeId: string; state: PaneState; actions: ReturnType<typeof useBroker>['actions'] }): JSX.Element {
  const isController = state.role === 'controller';
  const someoneElseDriving = !isController && state.controllerId !== null;
  return (
    <div className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-sm">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${PHASE_DOT[state.conn]}`} />
      <span className="font-mono text-xs text-neutral-400">{state.title ?? state.sessionName ?? nodeId}</span>
      <span className="flex-1" />
      {state.model && <span className="text-xs text-neutral-500">{state.model}</span>}
      {state.contextTokens !== undefined && (
        <span className="text-xs text-neutral-500">{fmtTokens(state.contextTokens)} tok</span>
      )}
      <span className={isController ? 'text-xs text-emerald-400' : 'text-xs text-neutral-500'}>
        {isController ? '● drive' : someoneElseDriving ? '○ read-only' : '○ observer'}
      </span>
      {state.conn === 'open' &&
        (isController ? (
          <button
            onClick={actions.releaseControl}
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Release
          </button>
        ) : (
          <button
            onClick={actions.takeControl}
            className="rounded bg-sky-600 px-2 py-0.5 text-xs text-white hover:bg-sky-500"
          >
            Take control
          </button>
        ))}
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ScrollBody({ state }: { state: PaneState }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Track whether the user is pinned to the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <Transcript conv={state.conv} />
    </div>
  );
}

function Displays({ state, placement }: { state: PaneState; placement: 'aboveEditor' | 'belowEditor' }): JSX.Element | null {
  const widgets = Object.entries(state.widgets).filter(([, w]) => w.placement === placement);
  const showStatuses = placement === 'belowEditor' && Object.keys(state.statuses).length > 0;
  if (widgets.length === 0 && !showStatuses) return null;
  return (
    <div className="border-t border-neutral-800 bg-neutral-900/70 px-3 py-1 text-xs text-neutral-400">
      {widgets.map(([key, w]) => (
        <div key={key} className="whitespace-pre-wrap font-mono">
          {w.lines.join('\n')}
        </div>
      ))}
      {showStatuses &&
        Object.entries(state.statuses).map(([key, text]) => (
          <span key={key} className="mr-3 inline-block">
            {text}
          </span>
        ))}
    </div>
  );
}

function Composer({ state, actions }: { state: PaneState; actions: ReturnType<typeof useBroker>['actions'] }): JSX.Element {
  const [text, setText] = useState('');
  const isController = state.role === 'controller';
  const streaming = state.conv.isStreaming;
  const disabled = state.conn !== 'open' || !isController;

  const submit = () => {
    if (text.trim() === '') return;
    actions.sendText(text);
    setText('');
  };

  return (
    <div className="border-t border-neutral-800 bg-neutral-900 p-2">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={
            disabled
              ? isController
                ? 'connecting…'
                : 'take control to drive this agent'
              : streaming
                ? 'steer the running turn… (Enter to send)'
                : 'message the agent… (Enter to send, Shift+Enter for newline)'
          }
          disabled={disabled}
          className="flex-1 resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-sky-600 disabled:opacity-50"
        />
        {streaming && isController && (
          <button
            onClick={actions.abort}
            className="rounded bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-500"
            title="abort the running turn"
          >
            Stop
          </button>
        )}
        <button
          onClick={submit}
          disabled={disabled || text.trim() === ''}
          className="rounded bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {streaming ? 'Steer' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ConnOverlay({
  conn,
  nodeId,
  onWake,
  reconnect,
}: {
  conn: ConnPhase;
  nodeId: string;
  onWake?: (nodeId: string) => Promise<void> | void;
  reconnect: () => void;
}): JSX.Element | null {
  const [waking, setWaking] = useState(false);
  if (conn === 'open' || conn === 'connecting') return null;

  const doWake = async () => {
    if (!onWake) return;
    setWaking(true);
    try {
      await onWake(nodeId);
      reconnect();
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/85 p-6">
      <div className="max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-5 text-center">
        {conn === 'no-broker' && (
          <>
            <div className="mb-1 text-sm font-semibold text-neutral-100">Node is dormant</div>
            <p className="mb-4 text-sm text-neutral-400">Its broker isn't running. Wake it to connect.</p>
            {onWake ? (
              <button
                onClick={doWake}
                disabled={waking}
                className="rounded bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {waking ? 'Waking…' : 'Wake'}
              </button>
            ) : (
              <p className="text-xs text-neutral-500">Waking is wired by the shell (crtr canvas revive).</p>
            )}
          </>
        )}
        {conn === 'no-node' && (
          <>
            <div className="mb-1 text-sm font-semibold text-neutral-100">Node not found</div>
            <p className="text-sm text-neutral-400">This node no longer exists on the canvas.</p>
          </>
        )}
        {conn === 'invalid' && (
          <>
            <div className="mb-1 text-sm font-semibold text-red-300">Invalid node</div>
            <p className="text-sm text-neutral-400">The relay rejected this node id.</p>
          </>
        )}
        {conn === 'closed' && (
          <>
            <div className="mb-1 text-sm font-semibold text-neutral-100">Reconnecting…</div>
            <p className="mb-4 text-sm text-neutral-400">The broker connection dropped.</p>
            <button onClick={reconnect} className="rounded border border-neutral-700 px-4 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800">
              Retry now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
