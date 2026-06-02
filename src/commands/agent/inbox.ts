import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import {
  currentSessionContext,
  appendNodeEvent,
  readNodeInbox,
  findNode,
  findSessionByRootPane,
  findSessionByPiSession,
  hostNodeIdFor,
  loadSessionView,
} from '../../core/sessions.js';

// ---------------------------------------------------------------------------
// agent notify — deliver an event into a node's inbox (graph edge delivery)
// ---------------------------------------------------------------------------

export const notifyLeaf = defineLeaf({
  name: 'notify',
  help: {
    name: 'agent notify',
    summary: 'deliver an event into a node\'s inbox (e.g. a completion notice to a node that subscribes to or is reported to by another)',
    params: [
      { kind: 'positional', name: 'target', required: true, constraint: 'Node to notify: node_id, job_id, agent name, or 1-based index. Searched in the current session first, then all sessions for the cwd.' },
      { kind: 'flag', name: 'event', type: 'string', required: false, default: 'completed', constraint: 'Event name. Default: completed.' },
      { kind: 'flag', name: 'from-job', type: 'string', required: false, constraint: 'job_id of the source node (recorded as the event\'s `from`).' },
      { kind: 'flag', name: 'from-node', type: 'string', required: false, constraint: 'Explicit source node id; overrides --from-job for the `from` field.' },
      { kind: 'flag', name: 'message', type: 'string', required: false, constraint: 'Optional human-readable message stored under data.message.' },
      { kind: 'flag', name: 'session', type: 'string', required: false, constraint: 'Session id to search/deliver within. Defaults to CRTR_SESSION_ID.' },
    ],
    output: [
      { name: 'delivered', type: 'boolean', required: true, constraint: 'True when the event was written to a node inbox.' },
      { name: 'session_id', type: 'string', required: true, constraint: 'Session the target node was found in.' },
      { name: 'node_id', type: 'string', required: true, constraint: 'Resolved node id the event was delivered to.' },
      { name: 'event', type: 'string', required: true, constraint: 'Event name delivered.' },
    ],
    outputKind: 'object',
    effects: ['Appends one JSONL line to sessions/<session_id>/inboxes/<node>.jsonl. Read-only otherwise.'],
  },
  run: async (input) => {
    const target = input['target'] as string;
    const event = typeof input['event'] === 'string' && input['event'] !== '' ? (input['event'] as string) : 'completed';
    const fromJob = typeof input['fromJob'] === 'string' && input['fromJob'] !== '' ? (input['fromJob'] as string) : undefined;
    const fromNode = typeof input['fromNode'] === 'string' && input['fromNode'] !== '' ? (input['fromNode'] as string) : undefined;
    const message = typeof input['message'] === 'string' && input['message'] !== '' ? (input['message'] as string) : undefined;
    const sessionArg = typeof input['session'] === 'string' && input['session'] !== '' ? (input['session'] as string) : undefined;
    const { sessionId: envSession } = currentSessionContext();
    const sessionHint = sessionArg ?? envSession ?? undefined;

    const found = findNode(target, sessionHint !== undefined ? { sessionId: sessionHint } : {});
    if (found === null) {
      throw new InputError({
        error: 'not_found',
        message: `no node matches "${target}"`,
        next: 'Pass a node_id, job_id, agent name, or index. List with `crtr agent session show`.',
      });
    }

    const from = fromNode ?? fromJob ?? null;
    const data = message !== undefined ? { message } : undefined;
    const rec = appendNodeEvent(
      found.sessionId,
      found.nodeId,
      data !== undefined ? { from, event, data } : { from, event },
    );

    return { delivered: true, session_id: found.sessionId, node_id: found.nodeId, event: rec.event };
  },
});

// ---------------------------------------------------------------------------
// agent inbox — read events delivered to a node
// ---------------------------------------------------------------------------

export const inboxLeaf = defineLeaf({
  name: 'inbox',
  help: {
    name: 'agent inbox',
    summary: 'read events delivered to a node (completions from subscribed/reported-to agents)',
    params: [
      { kind: 'positional', name: 'target', required: false, constraint: 'Node whose inbox to read: node_id, job_id, agent name, or index. Defaults to the root node (root_node_id) for the current session.' },
      { kind: 'flag', name: 'since', type: 'string', required: false, constraint: 'ISO 8601 timestamp; only events strictly after it are returned.' },
      { kind: 'flag', name: 'session', type: 'string', required: false, constraint: 'Session id to read within. Defaults to CRTR_SESSION_ID.' },
    ],
    output: [
      { name: 'session_id', type: 'string', required: true, constraint: 'Session the node belongs to.' },
      { name: 'node_id', type: 'string', required: true, constraint: 'Resolved node id.' },
      { name: 'events', type: 'object[]', required: true, constraint: 'Each NodeEvent: {ts, to, from, event, data?}. Oldest first.' },
    ],
    outputKind: 'object',
    effects: ['Read-only.'],
  },
  run: async (input) => {
    const sessionArg = typeof input['session'] === 'string' && input['session'] !== '' ? (input['session'] as string) : undefined;
    const { sessionId: envSession } = currentSessionContext();
    // Resolution order (mirrors the watcher extension's): explicit --session,
    // then CRTR_SESSION_ID (spawned agents), then the top-level session bound to
    // this pi conversation (CRTR_PI_SESSION_ID, injected by the watcher), then a
    // legacy pane-keyed lookup.
    const pane = process.env['TMUX_PANE'];
    const piSessionId = process.env['CRTR_PI_SESSION_ID'] && process.env['CRTR_PI_SESSION_ID'] !== ''
      ? process.env['CRTR_PI_SESSION_ID']
      : null;
    const byPi = piSessionId !== null ? findSessionByPiSession(piSessionId) : null;
    const byPane = pane !== undefined && pane !== '' ? findSessionByRootPane(pane) : null;
    const sessionId = sessionArg ?? envSession ?? byPi ?? byPane ?? undefined;
    const since = typeof input['since'] === 'string' && input['since'] !== '' ? (input['since'] as string) : undefined;

    const targetArg = typeof input['target'] === 'string' && input['target'] !== '' ? (input['target'] as string) : undefined;
    let resolvedSession = sessionId;
    let nodeId: string;
    if (targetArg !== undefined) {
      const found = findNode(targetArg, sessionId !== undefined ? { sessionId } : {});
      if (found === null) {
        throw new InputError({
          error: 'not_found',
          message: `no node matches "${targetArg}"`,
          next: 'Pass a node_id, job_id, agent name, or index. List with `crtr agent session show`.',
        });
      }
      resolvedSession = found.sessionId;
      nodeId = found.nodeId;
    } else {
      if (sessionId === undefined) {
        throw new InputError({
          error: 'no_session',
          message: 'no target and CRTR_SESSION_ID is not set',
          next: 'Pass a node target or --session, or run from a pane that spawned agents.',
        });
      }
      const view = loadSessionView(sessionId);
      if (view === null) {
        throw new InputError({
          error: 'not_found',
          message: `session not found: ${sessionId}`,
          next: 'Run `crtr agent session list` to see available sessions.',
        });
      }
      // Phase 4.3: use root_node_id as the default inbox node.
      nodeId = view.root_node_id ?? hostNodeIdFor(view);
      resolvedSession = sessionId;
    }

    const events = readNodeInbox(resolvedSession!, nodeId, since !== undefined ? { sinceTs: since } : {});
    return { session_id: resolvedSession, node_id: nodeId, events };
  },
});
