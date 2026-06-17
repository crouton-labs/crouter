import { useEffect, useMemo, useState } from 'react';
import { useBroker } from '../useBroker.js';
import { useServerStatus } from '../lib/server-status.js';
import { applySnapshot } from '../transcript.js';
import { getNodeSnapshot, type NodeSnapshotResponse } from '../command-client.js';
import type {
  BrokerStatus,
  Command,
  ContextUsage,
  DialogResponseValue,
  FoldedMessage,
  GitStatus,
  ImageContent,
  Presence,
  RpcExtensionUIRequest,
  SessionState,
  SessionStatsSummary,
  ThinkingLevel,
  TokenBurn,
  WebRole,
  RpcExtensionUIResponse,
} from '@/shared/protocol.js';

/** Web-shaped chrome the SPA renders (mirrors `NodeDetail`'s chrome subset). */
export interface NodeChrome {
  branch: string | null;
  model: string | null;
  tokens: TokenBurn | null;
  context: ContextUsage | null;
  tool_calls: number | null;
  stats: SessionStatsSummary | null;
  git_status?: GitStatus | null;
}

const EMPTY_CHROME: NodeChrome = {
  branch: null,
  model: null,
  tokens: null,
  context: null,
  tool_calls: null,
  stats: null,
  git_status: null,
};

export interface SessionStore {
  messages: FoldedMessage[];
  state: SessionState | null;
  role: WebRole;
  chrome: NodeChrome;
  dialog: RpcExtensionUIRequest | null;
  commands: Command[];
  presence: Presence;
  brokerStatus: BrokerStatus;
  source: 'broker' | 'static';
  serverConnected: boolean;
  socketReady: boolean;
  error: { code: string; message: string } | null;
  reconnect: () => void;
  prompt: (text: string, images?: ImageContent[]) => void;
  steer: (text: string, images?: ImageContent[]) => void;
  abort: () => void;
  setModel: (model: string) => void;
  cycleModel: () => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  compact: (instructions?: string) => void;
  requestControl: () => void;
  releaseControl: () => void;
  dialogResponse: (requestId: string, response: DialogResponseValue) => void;
}

function toSessionState(nodeId: string, snapshot: NodeSnapshotResponse['snapshot']): SessionState {
  return {
    sessionId: snapshot.state?.sessionId ?? nodeId,
    sessionFile: snapshot.state?.sessionFile ?? null,
    model: snapshot.state?.model ?? null,
    isStreaming: false,
    thinkingLevel: snapshot.state?.thinkingLevel ?? 'off',
    steeringMode: snapshot.state?.steeringMode ?? 'all',
    followUpMode: snapshot.state?.followUpMode ?? 'all',
    sessionName: snapshot.state?.sessionName ?? null,
    autoCompactionEnabled: snapshot.state?.autoCompactionEnabled ?? false,
    pendingMessageCount: snapshot.state?.pendingMessageCount ?? 0,
  };
}

export function useSessionStore(nodeId: string): SessionStore {
  const { state, actions } = useBroker(nodeId);
  const serverConnected = useServerStatus((s) => s.reachable);
  const [dormantSnapshot, setDormantSnapshot] = useState<NodeSnapshotResponse | null>(null);

  useEffect(() => {
    let disposed = false;
    if (state.conn !== 'no-broker') {
      setDormantSnapshot(null);
      return;
    }

    getNodeSnapshot(nodeId)
      .then((snap) => {
        if (!disposed) setDormantSnapshot(snap);
      })
      .catch(() => {
        if (!disposed) setDormantSnapshot(null);
      });

    return () => {
      disposed = true;
    };
  }, [nodeId, state.conn]);

  // Only trust a dormant snapshot while the broker is actually absent:
  // switching from `no-broker` to a live broker leaves the prior snapshot in
  // state until the reconnect path clears it, so gate on conn first and then on
  // the response's node_id to avoid briefly rendering stale node A data under B.
  const snapshot = state.conn === 'no-broker' && dormantSnapshot?.node_id === nodeId ? dormantSnapshot : null;

  const staticConv = useMemo(() => {
    if (snapshot === null) return null;
    return applySnapshot(snapshot.snapshot);
  }, [snapshot]);

  const liveSession = useMemo<SessionState | null>(() => {
    if (state.session === null) return null;
    return { ...state.session, isStreaming: state.conv.isStreaming };
  }, [state.session, state.conv.isStreaming]);

  const sessionState = useMemo<SessionState | null>(() => {
    if (state.conn === 'connecting' || state.conn === 'closed') return null;
    if (snapshot !== null) return toSessionState(nodeId, snapshot.snapshot);
    return liveSession;
  }, [nodeId, snapshot, state.conn, liveSession]);

  const chrome = useMemo<NodeChrome>(() => {
    if (snapshot !== null) {
      return { ...EMPTY_CHROME, model: snapshot.snapshot.state?.model ?? null };
    }
    return { ...EMPTY_CHROME, model: state.model ?? null };
  }, [snapshot, state.model]);

  const messages = (staticConv?.messages ?? state.conv.messages) as FoldedMessage[];
  const commands = snapshot?.commands ?? state.commands;

  return {
    messages,
    state: sessionState,
    role: state.role,
    chrome,
    dialog: state.dialog,
    commands,
    presence: { viewers: 0, controller: state.controllerId },
    brokerStatus:
      state.conn === 'open'
        ? 'connected'
        : state.conn === 'closed' || state.conn === 'connecting'
          ? 'reconnecting'
          : 'down',
    source: state.conn === 'no-broker' ? 'static' : 'broker',
    serverConnected,
    socketReady: state.conn === 'open',
    error: state.notice ? { code: 'broker_unavailable', message: state.notice } : null,
    reconnect: actions.reconnect,
    prompt: (text: string) => actions.sendText(text),
    steer: (text: string) => actions.sendText(text),
    abort: actions.abort,
    setModel: actions.setModel,
    cycleModel: actions.cycleModel,
    setThinkingLevel: actions.setThinkingLevel,
    compact: actions.compact,
    requestControl: actions.takeControl,
    releaseControl: actions.releaseControl,
    dialogResponse: (requestId: string, response: DialogResponseValue) =>
      actions.answerDialog({ type: 'extension_ui_response', id: requestId, ...response } as RpcExtensionUIResponse),
  };
}
