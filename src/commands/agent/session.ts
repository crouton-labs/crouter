import { defineLeaf, defineBranch } from '../../core/command.js';
import { InputError, emitLine } from '../../core/io.js';
import { livePanes } from '../../core/jobs.js';
import {
  currentSessionContext,
  reapDeadSessions,
  loadSessionView,
  listSessionViews,
} from '../../core/sessions.js';
import type { AgentView, SessionView } from '../../core/sessions.js';

// ---------------------------------------------------------------------------
// agent session — read model (show/list) + live feed (watch)
// ---------------------------------------------------------------------------

/** Resolve and validate sessionId for show/watch: explicit arg or env fallback. */
function resolveSessionId(input: Record<string, unknown>): string {
  const arg = typeof input['session_id'] === 'string' && input['session_id'] !== ''
    ? (input['session_id'] as string)
    : undefined;
  if (arg !== undefined) return arg;
  const { sessionId: envSession } = currentSessionContext();
  if (envSession === null) {
    throw new InputError({
      error: 'no_session',
      message: 'no session_id argument and CRTR_SESSION_ID is not set',
      next: 'Pass a session_id, or run `crtr agent session list` to find one.',
    });
  }
  return envSession;
}

const sessionShow = defineLeaf({
  name: 'show',
  help: {
    name: 'agent session show',
    summary: 'show the current session\'s agent tree — status, age, telemetry',
    params: [
      { kind: 'positional', name: 'session_id', required: false, constraint: 'Session id. Defaults to CRTR_SESSION_ID (the current session).' },
    ],
    output: [
      { name: 'session_id', type: 'string', required: true, constraint: 'Session identifier.' },
      { name: 'created', type: 'string', required: true, constraint: 'ISO 8601 creation timestamp.' },
      { name: 'root_pane', type: 'string', required: true, constraint: 'tmux pane id of the session\'s origin.' },
      { name: 'tmux_session', type: 'string', required: true, constraint: 'Name of the dedicated subagent tmux session.' },
      { name: 'nodes', type: 'object[]', required: true, constraint: 'Graph nodes: {node_id, kind: agent|external, created, job_id?, pane_id?, host_session_id?, cwd?, label?}. root_node_id identifies the root job node (agent kind); legacy/claude origin panes are external nodes; spawned workers are agent nodes.' },
      { name: 'edges', type: 'object[]', required: true, constraint: 'Graph edges: {edge_id, type: spawned_by|reports_to|subscribes_to|handoff_to, from, to, created}. Topology lives here — not in agents[].parent.' },
      { name: 'agents', type: 'object[]', required: true, constraint: 'Each AgentView: {job_id, node_id, parent, report_to, subscribes_to, name, agent, pane_id, cwd, created, title, host_session_id, status, age_s, telemetry}.' },
    ],
    outputKind: 'object',
    effects: ['Read-only. Reaps dead sessions before reading.'],
  },
  run: async (input) => {
    const sessionId = resolveSessionId(input);
    reapDeadSessions(livePanes());
    const view = loadSessionView(sessionId);
    if (view === null) {
      throw new InputError({
        error: 'not_found',
        message: `session not found: ${sessionId}`,
        next: 'Run `crtr agent session list` to see available sessions.',
      });
    }
    return view as unknown as Record<string, unknown>;
  },
});

const sessionList = defineLeaf({
  name: 'list',
  help: {
    name: 'agent session list',
    summary: 'list all sessions for the current project',
    params: [],
    output: [
      { name: 'sessions', type: 'object[]', required: true, constraint: 'Each: {session_id, created, root_pane, tmux_session, agent_count, live}.' },
      { name: 'total', type: 'integer', required: true, constraint: 'Number of sessions returned.' },
    ],
    outputKind: 'object',
    effects: ['Read-only. Reaps dead sessions before reading.'],
  },
  run: async () => {
    const panes = livePanes();
    reapDeadSessions(panes);
    const views = listSessionViews();
    const sessions = views.map((v) => ({
      session_id: v.session_id,
      created: v.created,
      root_pane: v.root_pane,
      tmux_session: v.tmux_session,
      agent_count: v.agents.length,
      live: panes.has(v.root_pane) || v.agents.some((a) => panes.has(a.pane_id)),
    }));
    return { sessions, total: sessions.length };
  },
});

const sessionWatch = defineLeaf({
  name: 'watch',
  help: {
    name: 'agent session watch',
    summary: 'live JSONL event stream for a session — one event per line; stops when the session dies',
    params: [
      { kind: 'positional', name: 'session_id', required: false, constraint: 'Session id. Defaults to CRTR_SESSION_ID.' },
      { kind: 'flag', name: 'interval', type: 'int', required: false, default: 2, constraint: 'Poll interval in seconds. Default 2.' },
    ],
    output: [
      {
        name: '<event line>',
        type: 'object',
        required: true,
        constraint:
          'Each JSONL line is one of:\n' +
          '  {event:\'snapshot\', session: SessionView}\n' +
          '  {ts, event:\'agent_added\', agent: AgentView}\n' +
          '  {ts, event:\'status_changed\', job_id, from, to, agent: AgentView}\n' +
          '  {ts, event:\'telemetry\', job_id, telemetry: TelemetryRec}\n' +
          '  {ts, event:\'session_dead\', session_id}',
      },
    ],
    outputKind: 'jsonl',
    effects: ['Read-only. Reaps dead sessions on each tick. Exits 0 when session_dead is emitted.'],
  },
  run: async (input): Promise<void> => {
    const sessionId = resolveSessionId(input);
    const interval = typeof input['interval'] === 'number' ? input['interval'] : 2;

    // Declare prevAgentMap outside the loop so diffs work across ticks.
    let prevAgentMap = new Map<string, AgentView>();
    let isFirst = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const panes = livePanes();
      reapDeadSessions(panes);
      const view: SessionView | null = loadSessionView(sessionId);
      const ts = new Date().toISOString();

      if (view === null) {
        emitLine({ ts, event: 'session_dead', session_id: sessionId } as unknown as Record<string, unknown>);
        return;
      }

      if (isFirst) {
        // Full snapshot so a late subscriber gets initial state immediately.
        emitLine({ event: 'snapshot', session: view } as unknown as Record<string, unknown>);
        isFirst = false;
      } else {
        // Diff: agent_added, status_changed, telemetry.
        for (const agent of view.agents) {
          const prev = prevAgentMap.get(agent.job_id);
          if (prev === undefined) {
            emitLine({ ts, event: 'agent_added', agent } as unknown as Record<string, unknown>);
          } else {
            if (prev.status !== agent.status) {
              emitLine({
                ts,
                event: 'status_changed',
                job_id: agent.job_id,
                from: prev.status,
                to: agent.status,
                agent,
              } as unknown as Record<string, unknown>);
            }
            const newTel = agent.telemetry;
            const prevTel = prev.telemetry;
            if (
              newTel !== null &&
              (prevTel === null || prevTel.updated_at !== newTel.updated_at)
            ) {
              emitLine({
                ts,
                event: 'telemetry',
                job_id: agent.job_id,
                telemetry: newTel,
              } as unknown as Record<string, unknown>);
            }
          }
        }
      }

      // Update previous state for the next diff.
      prevAgentMap = new Map(view.agents.map((a) => [a.job_id, a]));

      await new Promise<void>((resolve) => setTimeout(resolve, interval * 1000));
    }
  },
});

export const sessionBranch = defineBranch({
  name: 'session',
  help: {
    name: 'agent session',
    summary: 'read model and live feed for spawned-agent sessions',
    model:
      'A session is a graph namespace — a set of nodes (root job + spawned workers) and edges ' +
      '(spawned_by, reports_to, subscribes_to, handoff_to) for one effort. root_node_id identifies ' +
      'the current root job (an agent node); legacy/claude origin panes are external nodes. ' +
      '`show` returns root_node_id, nodes, edges + an AgentView per agent ' +
      '(name · title · age_s · telemetry.tokens_*); render the graph from edges (agents[].parent is a ' +
      'legacy spawned_by shorthand). ' +
      '`list` enumerates sessions with a live/dead signal. ' +
      '`watch` emits a JSONL event stream (snapshot → diffs) that a thin frontend ' +
      '(e.g. pi ctx.ui.custom()) can subscribe to and re-render on each event — ' +
      'crtr is Model+Controller; the frontend is the dumb View.',
    children: [
      { name: 'show', desc: 'full render model for one session', useWhen: 'inspecting the agent tree, checking status and telemetry' },
      { name: 'list', desc: 'list sessions with live/dead signal', useWhen: 'finding sessions or checking how many are active' },
      { name: 'watch', desc: 'live JSONL event stream (snapshot + diffs)', useWhen: 'powering a live agent-picker UI or monitoring a session in real time' },
    ],
  },
  children: [sessionShow, sessionList, sessionWatch],
});
