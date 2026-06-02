import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { livePanes } from '../../core/jobs.js';
import { joinPane, scheduleKillCurrentPane } from '../../core/spawn.js';
import { currentSessionContext, reapDeadSessions, resolveAgent, loadSessionView } from '../../core/sessions.js';
import { assertTmux, assertExactlyOneFocusMode, DEFAULT_KILL_SECS } from './shared.js';

// ---------------------------------------------------------------------------
// agent focus — pull a running agent pane into the caller's view
// ---------------------------------------------------------------------------

export const focusLeaf = defineLeaf({
  name: 'focus',
  help: {
    name: 'agent focus',
    summary: 'move a running agent pane into the caller\'s view (side-by-side or replace)',
    params: [
      { kind: 'positional', name: 'target', required: true, constraint: 'Agent to focus: job_id, name, or 1-based index in the current session.' },
      { kind: 'flag', name: 'new', type: 'bool', required: false, constraint: 'Pull the agent pane alongside the caller as a new column. Mutually exclusive with --replace.' },
      { kind: 'flag', name: 'replace', type: 'bool', required: false, constraint: 'Pull the agent pane in and schedule the caller pane for close. Mutually exclusive with --new.' },
    ],
    output: [
      { name: 'session_id', type: 'string', required: true, constraint: 'Session the agent belongs to.' },
      { name: 'job_id', type: 'string', required: true, constraint: 'Job id of the focused agent.' },
      { name: 'pane_id', type: 'string', required: true, constraint: 'tmux pane id of the agent.' },
      { name: 'placement', type: 'string', required: true, constraint: '"new" (split, both panes stay) or "replace" (caller pane closes in ~2s).' },
      { name: 'message', type: 'string', required: true, constraint: 'Human-readable confirmation.' },
    ],
    outputKind: 'object',
    effects: [
      'With --new: tmux join-pane pulls the target pane into the caller\'s window as a side-by-side column; both panes remain.',
      'With --replace: same join, then the caller\'s pane is scheduled for close after DEFAULT_KILL_SECS.',
      'Requires tmux (assertTmux). Errors no_session if the caller has no CRTR_SESSION_ID.',
    ],
  },
  run: async (input) => {
    assertTmux();

    assertExactlyOneFocusMode(input);
    const wantsNew = input['new'] === true;
    const wantsReplace = input['replace'] === true;

    const target = input['target'] as string;
    const callerPane = process.env['TMUX_PANE']!;

    const { sessionId } = currentSessionContext();
    if (sessionId === null) {
      throw new InputError({
        error: 'no_session',
        message: 'run focus from a pane that spawned agents',
        next: 'Use `crtr agent focus` from a pane where agents were spawned with `crtr agent new`.',
      });
    }

    const panes = livePanes();
    reapDeadSessions(panes);

    const agent = resolveAgent(sessionId, target);
    if (agent === null) {
      const view = loadSessionView(sessionId);
      const known = view !== null && view.agents.length > 0
        ? view.agents.map((a, i) => `${i + 1}:${a.name} (${a.job_id})`).join(', ')
        : '(none)';
      throw new InputError({
        error: 'not_found',
        message: 'target not in session; run `crtr agent session show`',
        next: `Known refs: ${known}`,
      });
    }

    if (agent.status !== 'running' || !panes.has(agent.pane_id)) {
      throw new InputError({
        error: 'no_live_pane',
        message: `target has no live pane (status: ${agent.status})`,
        next: 'The agent is no longer running. Use `crtr agent session show` to see all agents.',
      });
    }

    const joinResult = joinPane(agent.pane_id, callerPane);
    if (!joinResult.ok) {
      throw new InputError({
        error: 'tmux_error',
        message: joinResult.message,
        next: 'Check tmux is running and try again.',
      });
    }

    const placement = wantsNew ? 'new' : 'replace';
    if (wantsReplace) {
      scheduleKillCurrentPane(DEFAULT_KILL_SECS);
    }

    return {
      session_id: sessionId,
      job_id: agent.job_id,
      pane_id: agent.pane_id,
      placement,
      message: wantsNew
        ? `agent pane joined alongside (${agent.pane_id})`
        : `agent pane joined; caller pane closing in ${DEFAULT_KILL_SECS}s`,
    };
  },
});
