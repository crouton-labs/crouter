// useBroker.ts — the React state layer over BrokerClient. Owns the connection
// lifecycle (connect, hello handshake, reconnect on transient drops), folds every
// broker→client frame into a single PaneState, and exposes the drive actions
// (prompt/steer/abort, control arbitration, dialog answers) ConversationPane renders.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { BrokerClient, type CloseKind } from './broker-client.js';
import {
  applySnapshot,
  bashEnd,
  bashOutput,
  bashStart,
  initialConvState,
  reduce,
  type ConvState,
} from './transcript.js';
import type {
  AgentSessionEvent,
  BrokerToClient,
  ClientRole,
  ClientToBroker,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from './protocol.js';
import type { Command, ThinkingLevel } from '@/shared/protocol.js';

/** Coarse connection phase for the pane's overlays. `open` = welcome received. */
export type ConnPhase = 'connecting' | 'open' | 'no-broker' | 'no-node' | 'invalid' | 'closed';

export interface PaneState {
  clientId: string;
  conn: ConnPhase;
  conv: ConvState;
  role: ClientRole;
  controllerId: string | null;
  model: string | undefined;
  sessionName: string | undefined;
  contextTokens: number | undefined;
  dialog: RpcExtensionUIRequest | null;
  commands: Command[];
  /** Keyed non-blocking display state (setStatus / setWidget / setTitle). */
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }>;
  title: string | undefined;
  /** Transient notice (e.g. a not_controller error), auto-cleared by the UI. */
  notice: string | null;
}

type Action =
  | { kind: 'reset'; clientId: string }
  | { kind: 'connecting' }
  | { kind: 'frame'; frame: BrokerToClient }
  | { kind: 'closed'; closeKind: CloseKind }
  | { kind: 'notice'; text: string | null }
  | { kind: 'dismiss-dialog' };

function makeInitial(clientId: string): PaneState {
  return {
    clientId,
    conn: 'connecting',
    conv: initialConvState(),
    role: 'observer',
    controllerId: null,
    model: undefined,
    sessionName: undefined,
    contextTokens: undefined,
    dialog: null,
    commands: [],
    statuses: {},
    widgets: {},
    title: undefined,
    notice: null,
  };
}

const CLOSE_PHASE: Record<CloseKind, ConnPhase> = {
  'no-broker': 'no-broker',
  'no-node': 'no-node',
  invalid: 'invalid',
  transient: 'closed',
};

/** The set of broker CONTROL frame `type`s — everything else reaching the reducer
 *  is a pi `AgentSessionEvent` and folds into the transcript. */
function isControlFrame(t: string): boolean {
  return (
    t === 'welcome' ||
    t === 'control_changed' ||
    t === 'model_changed' ||
    t === 'error' ||
    t === 'ack' ||
    t === 'data' ||
    t === 'display_status' ||
    t === 'display_widget' ||
    t === 'display_title' ||
    t === 'bash_start' ||
    t === 'bash_output' ||
    t === 'bash_end' ||
    t === 'extension_ui_request'
  );
}

function reducer(state: PaneState, action: Action): PaneState {
  switch (action.kind) {
    case 'reset':
      return makeInitial(action.clientId);
    case 'connecting':
      return { ...state, conn: 'connecting' };
    case 'closed':
      return { ...state, conn: CLOSE_PHASE[action.closeKind] };
    case 'notice':
      return { ...state, notice: action.text };
    case 'dismiss-dialog':
      return { ...state, dialog: null };
    case 'frame':
      return applyFrame(state, action.frame);
  }
}

function parseCommandAck(detail: string | undefined): Command[] {
  if (detail === undefined || detail.trim() === '') return [];
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Command => {
      if (typeof item !== 'object' || item === null) return false;
      const rec = item as Record<string, unknown>;
      return (
        typeof rec.name === 'string' &&
        typeof rec.description === 'string' &&
        (rec.source === 'builtin' || rec.source === 'command' || rec.source === 'template')
      );
    });
  } catch {
    return [];
  }
}

function applyFrame(state: PaneState, frame: BrokerToClient): PaneState {
  if (!isControlFrame(frame.type)) {
    // A pi AgentSessionEvent — fold into the transcript.
    return { ...state, conv: reduce(state.conv, frame as AgentSessionEvent) };
  }
  switch (frame.type) {
    case 'welcome': {
      const conv = applySnapshot(frame.snapshot);
      const controllerId = frame.controller_id;
      return {
        ...state,
        conn: 'open',
        conv,
        controllerId,
        role: controllerId === state.clientId ? 'controller' : 'observer',
        model: frame.snapshot.state?.model,
        sessionName: frame.snapshot.state?.sessionName,
        contextTokens: frame.snapshot.stats?.tokens?.total,
        dialog: frame.pending_dialog ?? null,
        commands: [],
      };
    }
    case 'control_changed':
      return {
        ...state,
        controllerId: frame.controller_id,
        role: frame.controller_id === state.clientId ? 'controller' : 'observer',
      };
    case 'model_changed':
      return { ...state, model: frame.model };
    case 'error':
      return {
        ...state,
        notice:
          frame.code === 'not_controller'
            ? 'read-only — another viewer is the controller'
            : frame.message || `error: ${frame.code}`,
      };
    case 'extension_ui_request':
      // A new dialog supersedes any showing one (parity with attachDialog).
      return { ...state, dialog: frame };
    case 'display_status': {
      const statuses = { ...state.statuses };
      if (frame.text === undefined) delete statuses[frame.key];
      else statuses[frame.key] = frame.text;
      return { ...state, statuses };
    }
    case 'display_widget': {
      const widgets = { ...state.widgets };
      if (frame.lines === undefined) delete widgets[frame.key];
      else widgets[frame.key] = { lines: frame.lines, placement: frame.placement };
      return { ...state, widgets };
    }
    case 'display_title':
      return { ...state, title: frame.title };
    case 'ack':
      if (frame.for !== 'get_commands') return state;
      return frame.ok ? { ...state, commands: parseCommandAck(frame.detail) } : { ...state, commands: [] };
    case 'bash_start':
      return { ...state, conv: bashStart(state.conv, frame.command, frame.excludeFromContext) };
    case 'bash_output':
      return { ...state, conv: bashOutput(state.conv, frame.chunk) };
    case 'bash_end':
      return { ...state, conv: bashEnd(state.conv, frame) };
    case 'data':
    default:
      return state;
  }
}

export interface BrokerActions {
  /** Send the editor text as a `prompt` (idle) or `steer` (streaming). Requires
   *  controller; no-ops with a notice otherwise. */
  sendText: (text: string) => void;
  abort: () => void;
  takeControl: () => void;
  releaseControl: () => void;
  setModel: (model: string) => void;
  cycleModel: () => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  compact: (instructions?: string) => void;
  answerDialog: (resp: RpcExtensionUIResponse) => void;
  /** Cancel the current dialog (sends `cancelled:true`). */
  cancelDialog: () => void;
  /** Re-dial the broker (used after a [Wake] revive succeeds). */
  reconnect: () => void;
  clearNotice: () => void;
}

const RECONNECT_DELAY_MS = 1500;

export function useBroker(nodeId: string): { state: PaneState; actions: BrokerActions } {
  const clientIdRef = useRef<string>('');
  if (clientIdRef.current === '') clientIdRef.current = crypto.randomUUID();
  const [state, dispatch] = useReducer(reducer, clientIdRef.current, makeInitial);

  const clientRef = useRef<BrokerClient | null>(null);
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror role into a ref so action callbacks read the live value without
  // re-binding every render.
  const roleRef = useRef<ClientRole>(state.role);
  roleRef.current = state.role;
  const streamingRef = useRef<boolean>(state.conv.isStreaming);
  streamingRef.current = state.conv.isStreaming;

  const send = useCallback((frame: ClientToBroker) => {
    clientRef.current?.send(frame);
  }, []);

  const connect = useCallback(() => {
    const gen = genRef.current;
    const client = new BrokerClient(nodeId, {
      onOpen: () => {
        if (gen !== genRef.current) return;
        // Browsers attach as observers — never claim control unprompted.
        client.send({ type: 'hello', role: 'observer', client_id: clientIdRef.current });
      },
      onFrame: (frame) => {
        if (gen !== genRef.current) return;
        dispatch({ kind: 'frame', frame });
        if (frame.type === 'welcome') client.send({ type: 'get_commands' });
      },
      onClose: (closeKind) => {
        if (gen !== genRef.current) return;
        dispatch({ kind: 'closed', closeKind });
        // Only a transient drop auto-reconnects; no-broker/no-node/invalid wait
        // for a user action (Wake / navigate away).
        if (closeKind === 'transient') {
          timerRef.current = setTimeout(() => {
            if (gen !== genRef.current) return;
            dispatch({ kind: 'connecting' });
            connect();
          }, RECONNECT_DELAY_MS);
        }
      },
    });
    clientRef.current = client;
    client.connect();
  }, [nodeId]);

  // (Re)connect whenever the node changes; tear down cleanly on unmount.
  useEffect(() => {
    genRef.current += 1;
    dispatch({ kind: 'reset', clientId: clientIdRef.current });
    dispatch({ kind: 'connecting' });
    connect();
    return () => {
      genRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [nodeId, connect]);

  const actions: BrokerActions = {
    sendText: useCallback(
      (text: string) => {
        const body = text.trim();
        if (body === '') return;
        if (roleRef.current !== 'controller') {
          dispatch({ kind: 'notice', text: 'take control before sending' });
          return;
        }
        // `!cmd`/`!!cmd` → run bash in the engine, no agent turn (pi `!` parity).
        if (body.startsWith('!')) {
          const excludeFromContext = body.startsWith('!!');
          const command = body.slice(excludeFromContext ? 2 : 1).trim();
          if (command === '') return;
          send({ type: 'bash', command, excludeFromContext });
          return;
        }
        send(streamingRef.current ? { type: 'steer', text: body } : { type: 'prompt', text: body });
      },
      [send],
    ),
    abort: useCallback(() => {
      if (roleRef.current !== 'controller') return;
      send({ type: 'abort' });
    }, [send]),
    takeControl: useCallback(() => send({ type: 'request_control' }), [send]),
    releaseControl: useCallback(() => send({ type: 'release_control' }), [send]),
    setModel: useCallback((model: string) => send({ type: 'set_model', model }), [send]),
    cycleModel: useCallback(() => send({ type: 'cycle_model' }), [send]),
    setThinkingLevel: useCallback((level: ThinkingLevel) => send({ type: 'set_thinking_level', level }), [send]),
    compact: useCallback((instructions?: string) => send({ type: 'compact', ...(instructions ? { instructions } : {}) }), [send]),
    answerDialog: useCallback(
      (resp: RpcExtensionUIResponse) => {
        send(resp);
        dispatch({ kind: 'dismiss-dialog' });
      },
      [send],
    ),
    cancelDialog: useCallback(() => {
      const id = state.dialog?.id;
      if (id !== undefined) send({ type: 'extension_ui_response', id, cancelled: true });
      dispatch({ kind: 'dismiss-dialog' });
    }, [send, state.dialog]),
    reconnect: useCallback(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      genRef.current += 1;
      clientRef.current?.close();
      dispatch({ kind: 'connecting' });
      connect();
    }, [connect]),
    clearNotice: useCallback(() => dispatch({ kind: 'notice', text: null }), []),
  };

  return { state, actions };
}
