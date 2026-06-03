import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { resolveScopeArg } from '../../core/scope.js';
import { createJob, appendEvent, recordJobPane, recordJobReportTo, livePanes } from '../../core/jobs.js';
import { spawnAgent, detectAgentKind, subagentSessionName } from '../../core/spawn.js';
import { agentNewPrompt } from '../../prompts/agent.js';
import { resolveSubagent, subagentId } from '../../core/subagents.js';
import {
  currentSessionContext,
  mintSessionId,
  ensureSession,
  appendAgent,
  loadSessionView,
  reapSupersededSessions,
  hostPaneNodeId,
  hostNodeIdFor,
  findSessionByRootPane,
  ensureRootJob,
  rootNodeId as getSessionRootNodeId,
  insertCoordinator,
} from '../../core/sessions.js';
import type { Scope, Subagent } from '../../types.js';
import {
  GENERAL_AGENT,
  PROMPT_GUIDE,
  followUpResult,
  deriveTitle,
  parseNodeRefList,
  resolveMaxPanes,
  assertTmux,
} from './shared.js';

// ---------------------------------------------------------------------------
// agent new — the single spawn command. General-purpose by default;
// `--agent <id>` overlays a defined subagent persona.
// ---------------------------------------------------------------------------

export const newPrompt = defineLeaf({
  name: 'new',
  help: {
    name: 'agent new',
    summary: 'spawn a worker (non-blocking, tmux-only) — general-purpose by default, or a defined subagent via --agent; returns a job handle immediately',
    guide: PROMPT_GUIDE,
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'Task/prompt sent to the spawned agent as the first user message. Piped on stdin, or passed as a single positional argument.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory for the spawned agent. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker. Defaults to the --agent id (or "general").' },
      { kind: 'flag', name: 'agent', type: 'string', required: false, default: 'general', constraint: 'Which agent runs the task. Omit or "general" for the general-purpose agent; any other id (<name> or <plugin>/<name>) overlays that defined subagent\'s persona/model/tools. List with `crtr agent subagent list`.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'With --agent, narrows resolution when the subagent name is ambiguous across scopes.' },
      { kind: 'flag', name: 'model', type: 'string', required: false, constraint: 'Model pattern/id passed via `--model`. Overrides a subagent\'s declared model.' },
      { kind: 'flag', name: 'report-to', type: 'string', required: false, constraint: 'Comma-separated node refs this agent reports to on completion. Defaults to its spawning node, or the root job node (root_node_id) for top-level spawns.' },
      { kind: 'flag', name: 'subscribe-to', type: 'string', required: false, constraint: 'Comma-separated node refs this agent should be considered subscribed to. Stored as graph edges for watchers/dispatchers.' },
      { kind: 'flag', name: 'steer-on-complete', type: 'bool', required: false, constraint: 'Deliver this worker\'s completion as a steer (interrupts the parent\'s current turn) rather than the default follow-up. Only affects a pi parent; claude parents pull regardless.' },
      { kind: 'flag', name: 'persistent', type: 'bool', required: false, constraint: 'Spawn a persistent agent that stays live across turns (never auto-finalizes). Persistent agents can spawn more persistent peers (swarm). A persistent spawn still has a report_to but never delivers a completed event.' },
      { kind: 'flag', name: 'parent', type: 'bool', required: false, constraint: 'Hand off coordination to a freshly-spawned persistent agent B by interposing it between you (A) and your current reportees: every agent that reports to A re-points to report to B, and B itself reports to A (net topology: children → B → A). The session root never moves (no root_node_id change) and you are NOT superseded — you remain the session\'s live anchor. Requires CRTR_JOB_ID (job-backed caller). No auto-focus; use `crtr agent focus <B> --new` to bring B alongside. --report-to / --persistent are ignored (B is always a persistent coordinator reporting to A).' },
    ],
    // NOTE: --parent ignores --report-to and --persistent — B is always a
    // persistent coordinator that reports to the caller (A). Not enforced by
    // the parser; the run() handler branches early and sets B's routing itself.
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read status|logs|result` and `crtr job cancel`.' },
      { name: 'session_id', type: 'string', required: true, constraint: 'Graph session this agent was registered into (new if caller had none, inherited if present).' },
      { name: 'agent', type: 'string', required: true, constraint: 'The agent that ran the task: "general" or a resolved subagent id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Display name used for the spawned agent.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — collect result or focus the pane; do not relay to the user.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a non-blocking interactive agent in a pane of the dedicated subagent session (crtr-agents-<pane>). No focus change — press Alt-o to reach it.',
      'Creates a job entry at $XDG_STATE_HOME/crtr/jobs/<job_id>/ and records the result there.',
      'Registers the agent in a session graph (~/.crouter/<mangled-cwd>/sessions/<session_id>/session.json) for focus and listing.',
      'Requires tmux (TMUX env var must be set); errors not_in_tmux outside tmux.',
      'With --persistent: agent stays live across turns and never auto-finalizes. Persistent peers form a swarm. No completed event is ever delivered to report_to parents.',
      'With --parent: spawns B as a persistent coordinator interposed between the caller (A) and A\'s reportees (children → B → A). Re-points every reports_to *→A to *→B; root_node_id is unchanged and A is not superseded. Requires CRTR_JOB_ID (job-backed caller). Not supported from a top-level pi session without root-init, or from claude without a crtr session.',
    ],
  },
  run: async (input) => {
    assertTmux();

    // --parent: ASSERT job-backed caller before any other work (fast fail).
    const parentFlag = input['parent'] === true;
    if (parentFlag) {
      const aJobId = process.env['CRTR_JOB_ID'];
      if (!aJobId || aJobId.trim() === '') {
        throw new InputError({
          error: 'not_rootable',
          message:
            '--parent requires a job-backed caller: CRTR_JOB_ID is not set in this ' +
            'process. Run this from within a spawned agent (not a bare top-level ' +
            'pi/claude session without root-init). Note: if running from the top-level ' +
            'pi, install pi-personal-extensions and run `crtr agent root-init` first ' +
            'to bootstrap a persistent root job, then use --parent from within that ' +
            'session.',
          next:
            'Use `crtr agent new --persistent` to spawn a persistent peer instead, ' +
            'or bootstrap a root job first with `crtr agent root-init`.',
        });
      }
    }

    const prompt = input['prompt'] as string;
    // workCwd: the child's working directory (its pane -c and meta.cwd).
    const workCwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    // sessionCwd: the cwd NAMESPACE the session graph + inboxes live under. It
    // must stay the spawner's namespace so the parent's watcher (reading that
    // same namespace) sees completion notices even when the child runs with a
    // differing --cwd. Inherited from CRTR_SESSION_CWD when joining an existing
    // session; otherwise this pi process's cwd (a freshly-minted session lives
    // where it was minted). Spec R1 cwd-identity / acceptance #10.
    const sessionCwd = process.env['CRTR_SESSION_CWD'] && process.env['CRTR_SESSION_CWD'] !== ''
      ? process.env['CRTR_SESSION_CWD']
      : process.cwd();

    // Optional subagent overlay: --agent loads a persona (markdown + frontmatter)
    // that supplies the appended system prompt, model, and (pi) tools. Without
    // it, this is a plain general-purpose spawn.
    const agentArg = typeof input['agent'] === 'string' && input['agent'] !== '' ? (input['agent'] as string) : undefined;
    const scopeStr = input['scope'] as string | undefined;
    // `general` (or no --agent) is the built-in general-purpose worker: no
    // persona overlay. Any other id resolves a defined subagent.
    let sub: Subagent | undefined;
    if (agentArg !== undefined && agentArg !== GENERAL_AGENT) {
      const resolveOpts: { scope?: Scope } = {};  
      if (scopeStr !== undefined) {
        const resolved = resolveScopeArg(scopeStr);
        if (resolved !== 'all') resolveOpts.scope = resolved;
      }
      sub = resolveSubagent(agentArg, resolveOpts);
    }

    const agentId = sub !== undefined ? subagentId(sub) : GENERAL_AGENT;
    const nameArg = typeof input['name'] === 'string' && input['name'] !== '' ? (input['name'] as string) : undefined;
    const name = nameArg ?? agentId;
    const systemPrompt = sub?.systemPrompt;
    const tools = sub?.frontmatter.tools;
    const model = (typeof input['model'] === 'string' && input['model'] !== '' ? (input['model'] as string) : undefined)
      ?? sub?.frontmatter.model;

    // Session wiring: join the caller's session or mint a new one if none.
    // A session is a graph namespace, not a tree root; the spawning context is
    // just another node. `parent` is the spawning NODE (the `spawned_by` edge
    // target), defaulting to the host pane node for a top-level spawn.
    const { sessionId: envSession, parentJobId } = currentSessionContext();
    const rootPane = process.env['TMUX_PANE']!; // assertTmux guarantees TMUX is set
    // The pi conversation that owns this top-level pane, injected into the env
    // by the inbox-watcher extension at session_start. Identity follows the
    // conversation, not the recycled tmux pane number.
    const piSessionId = process.env['CRTR_PI_SESSION_ID'] && process.env['CRTR_PI_SESSION_ID'] !== ''
      ? process.env['CRTR_PI_SESSION_ID']
      : null;
    let sessionId = envSession;
    let selfHealRootJobId: string | null = null;
    const parent = parentJobId; // null ⇒ spawned_by the host node
    // Top-level spawn (no inherited CRTR_SESSION_ID): self-heal by bootstrapping
    // the persistent root job so correctness is independent of whether the
    // extension ran first (3.5). Falls back to pane-keyed resolution when no pi
    // id is available (older pi / watcher not installed).
    const topLevel = envSession === null;
    if (sessionId === null) {
      if (piSessionId !== null) {
        // Self-heal: ensure/resolve the persistent root job for this pi conversation.
        const rootResult = ensureRootJob({
          piSessionId,
          rootPane,
          tmuxSession: subagentSessionName(rootPane),
          cwd: sessionCwd,
        });
        sessionId = rootResult.sessionId;
        selfHealRootJobId = rootResult.jobId;
      } else {
        sessionId = findSessionByRootPane(rootPane, sessionCwd) ?? mintSessionId();
      }
    }
    // Idempotent either way — creates session.json (with the host node) if
    // absent. Stamp pi_session_id only when binding a fresh top-level session;
    // an inherited (CRTR_SESSION_ID) session keeps its own.
    ensureSession({
      sessionId,
      rootPane,
      tmuxSession: subagentSessionName(rootPane),
      cwd: sessionCwd,
      ...(topLevel ? { piSessionId } : {}),
    });

    // Clear stale/legacy sibling sessions left by prior conversations on this
    // still-live pane (best-effort; the pane-death reaper can never collect
    // them because the pane stays alive).
    if (topLevel && piSessionId !== null) {
      try { reapSupersededSessions(rootPane, piSessionId, livePanes(), sessionCwd); } catch { /* best-effort */ }
    }

    // --parent: spawn B as a persistent coordinator and interpose it between A
    // (the caller, whose CRTR_JOB_ID we asserted above) and A's reportees.
    // The session root is NOT moved and A is NOT superseded.
    if (parentFlag) {
      const aJobId = process.env['CRTR_JOB_ID']!; // asserted at the top of run()
      const steerOnComplete = input['steerOnComplete'] === true;

      // Create B as a persistent coordinator (NOT root) that reports to A.
      const { jobId: bJobId } = createJob(
        sub !== undefined ? 'subagent' : 'general',
        { cwd: workCwd, lifecycle: 'persistent', root: false, forward: true },
      );

      // Wire up B's meta routing: B reports to A (children → B → A).
      recordJobReportTo(bJobId, {
        reportTo: [aJobId],
        sessionId,
        sessionCwd,
        name,
        title: deriveTitle(prompt),
        delivery: steerOnComplete ? 'steer' : 'followUp',
      });

      const bResult = spawnAgent({
        prompt: agentNewPrompt(prompt, bJobId),
        cwd: workCwd,
        jobId: bJobId,
        maxPanesPerWindow: resolveMaxPanes(),
        name,
        systemPrompt,
        model,
        tools,
        lifecycle: 'persistent',
        env: {
          CRTR_SESSION_ID: sessionId,
          CRTR_SESSION_CWD: sessionCwd,
          // B's own job id becomes the parent for B's children (they report to B).
          CRTR_PARENT_JOB_ID: bJobId,
          // B reports up to A.
          CRTR_REPORT_TO: aJobId,
          CRTR_JOB_LIFECYCLE: 'persistent',
        },
      });

      if (bResult.status === 'not-in-tmux') {
        throw new InputError({ error: 'not_in_tmux', message: bResult.message, next: 'Run inside a tmux session.' });
      }
      if (bResult.status === 'spawn-failed') {
        throw new InputError({ error: 'spawn_failed', message: bResult.message, next: 'Check tmux is running and try again.' });
      }

      const bPaneId = bResult.paneId ?? 'unknown';
      if (bResult.paneId !== undefined) recordJobPane(bJobId, bResult.paneId);
      appendEvent(bJobId, { level: 'info', event: 'worker_started', message: `pane ${bPaneId} spawned (unfocused, --parent coordination handoff)` });

      // Atomically: append B (reports to A), re-point reports_to *→A to *→B,
      // update agents[].report_to, add handoff_to A→B (single lock section so
      // no child can report to a half-updated target mid-handoff). The session
      // root is NOT moved.
      const { rePointedChildren } = insertCoordinator(sessionId, sessionCwd, {
        newRoot: {
          job_id: bJobId,
          pane_id: bPaneId,
          cwd: workCwd,
          name,
          agent: agentId,
          host_session_id: null,
          title: deriveTitle(prompt),
        },
        oldRootJobId: aJobId,
      });

      // Sync job-layer routing for each re-pointed child so meta.report_to
      // matches the graph (children now report to B).
      for (const { jobId: childId, newReportTo } of rePointedChildren) {
        try {
          recordJobReportTo(childId, { reportTo: newReportTo });
        } catch {
          // Best-effort: child job record may already be finalized or gone.
        }
      }

      // Re-publish CRTR_PARENT_JOB_ID=B into A's env so A's FUTURE spawns also
      // attach under B (B is the coordinator now). A keeps its root + lifecycle
      // and is NOT superseded — it remains the session's live anchor.
      process.env['CRTR_PARENT_JOB_ID'] = bJobId;

      const follow_up =
        `Coordination handed off. B (job_id: ${bJobId}) is now the coordinator: everything that ` +
        `reported to you (A, job_id: ${aJobId}) now reports to B, and B reports back to you.\n` +
        `You remain the session root and stay live — nothing was superseded.\n` +
        `B runs unfocused in pane ${bPaneId}; bring it alongside with \`crtr agent focus ${bJobId} --new\`.\n` +
        `Your future \`crtr agent new\` spawns now attach under B as well.`;

      return { job_id: bJobId, session_id: sessionId, agent: agentId, name, follow_up };
    }

    // Routing edges. report-to defaults to the spawning node (its parent node,
    // or the host/root node at top level) so completion still flows "up" by
    // default; pass --report-to to redirect, including to a node the agent will
    // itself create (e.g. an agent that spins up its own supervisor).
    // selfHealRootJobId is set when the extension didn't run first (top-level
    // with piSessionId available); it takes precedence over the legacy host node.
    // Phase 4.3: use root_node_id from the session view as the spawner for top-level
    // spawns; fall back to the deprecated hostNodeIdFor() for legacy/no-pi-id path.
    const sessionView = loadSessionView(sessionId, sessionCwd);
    const spawnerNode = parent ?? selfHealRootJobId ?? getSessionRootNodeId(sessionView ?? {}) ?? hostNodeIdFor({ pi_session_id: piSessionId, root_pane: rootPane });
    const reportToArg = parseNodeRefList(input['reportTo']);
    const reportTo = reportToArg.length > 0 ? reportToArg : [spawnerNode];
    const subscribesTo = parseNodeRefList(input['subscribeTo']);

    const persistent = input['persistent'] === true;
    const lifecycle: 'worker' | 'persistent' = persistent ? 'persistent' : 'worker';

    const { jobId } = createJob(sub !== undefined ? 'subagent' : 'general', { cwd: workCwd, lifecycle });

    // Persist completion routing in meta.json (R1) so any terminal-transition
    // path notifies the parent without depending on the child's runtime env.
    const steerOnComplete = input['steerOnComplete'] === true;
    recordJobReportTo(jobId, {
      reportTo,
      sessionId,
      sessionCwd,
      name,
      title: deriveTitle(prompt),
      delivery: steerOnComplete ? 'steer' : 'followUp',
    });

    const result = spawnAgent({
      prompt: agentNewPrompt(prompt, jobId),
      cwd: workCwd,
      jobId,
      maxPanesPerWindow: resolveMaxPanes(),
      name,
      systemPrompt,
      model,
      tools,
      lifecycle,
      env: {
        CRTR_SESSION_ID: sessionId,
        CRTR_SESSION_CWD: sessionCwd,
        CRTR_PARENT_JOB_ID: jobId,
        CRTR_REPORT_TO: reportTo.join(','),
        CRTR_JOB_LIFECYCLE: lifecycle,
      },
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const paneId = result.paneId ?? 'unknown';
    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `pane ${paneId} spawned (unfocused)` });

    appendAgent(sessionId, sessionCwd, {
      job_id: jobId,
      node_id: jobId,
      parent,
      report_to: reportTo,
      subscribes_to: subscribesTo,
      name,
      agent: agentId,
      pane_id: paneId,
      cwd: workCwd,
      created: new Date().toISOString(),
      title: deriveTitle(prompt),
      host_session_id: null,
      status: 'running',
    });

    const follow_up =
      `Worker spawned (non-blocking). It can take up to ~20 min to finish,\n` +
      `depending on difficulty. Under pi its completion auto-injects into your\n` +
      `session, so don't poll: if you have other work, keep going; if you're\n` +
      `blocked on this result, end your turn now and the completion notice will\n` +
      `wake you. Then fetch the body with \`crtr job read result ${jobId}\` if needed.\n` +
      `(Under claude, pull it: \`crtr job read result ${jobId} --wait\`.) Look in on it\n` +
      `with \`crtr agent focus ${jobId} --new\` (side-by-side) or \`--replace\` (hand off\n` +
      `your pane). You own collection \u2014 don't relay these to the user.`;

    return { job_id: jobId, session_id: sessionId, agent: agentId, name, follow_up };
  },
});

// ---------------------------------------------------------------------------
// agent root-init — bootstrap a persistent root job for the top-level pi session
// ---------------------------------------------------------------------------

export const rootInitLeaf = defineLeaf({
  name: 'root-init',
  help: {
    name: 'agent root-init',
    summary: 'bootstrap a persistent root job for the current top-level pi session; idempotent — /reload returns the same session+job',
    params: [],
    output: [
      { name: 'session_id', type: 'string', required: true, constraint: 'Deterministic session id for this pi conversation (pi-<CRTR_PI_SESSION_ID>). Stable across /reload.' },
      { name: 'job_id', type: 'string', required: true, constraint: 'Root job id (persistent, no pid, reaped solely by pane-death). Use as CRTR_JOB_ID and CRTR_SESSION_ID in the environment.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates or resolves a persistent pi-root job for the current pi conversation.',
      'Idempotent: repeated calls with the same CRTR_PI_SESSION_ID return the same session_id/job_id while the root job is live.',
      'Reaps superseded sibling sessions on the same tmux pane (prior pi conversations), finalizing their root jobs with status \'closed\'.',
      'Requires CRTR_PI_SESSION_ID (set by the standing inbox-watcher extension at session_start) and TMUX_PANE.',
    ],
  },
  run: async () => {
    const piSessionId = process.env['CRTR_PI_SESSION_ID'];
    if (!piSessionId || piSessionId.trim() === '') {
      throw new InputError({
        error: 'missing_pi_session_id',
        message: 'CRTR_PI_SESSION_ID is not set — run inside a pi session with the inbox-watcher extension installed.',
        next: 'Install pi-personal-extensions so CRTR_PI_SESSION_ID is published at session_start.',
      });
    }
    const rootPane = process.env['TMUX_PANE'];
    if (!rootPane || rootPane.trim() === '') {
      throw new InputError({
        error: 'not_in_tmux',
        message: 'TMUX_PANE is not set — run inside a tmux session.',
        next: 'Run inside tmux.',
      });
    }
    const cwd = process.cwd();
    const { sessionId, jobId } = ensureRootJob({
      piSessionId,
      rootPane,
      tmuxSession: subagentSessionName(rootPane),
      cwd,
    });
    return { session_id: sessionId, job_id: jobId };
  },
});

// ---------------------------------------------------------------------------
// agent fork
// ---------------------------------------------------------------------------

export const newFork = defineLeaf({
  name: 'fork',
  help: {
    name: 'agent fork',
    summary: 'fork the current agent session into a sibling pane; returns a job handle immediately',
    params: [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — run it and report the worker\'s result; do not relay it to the user.' },
    ],
    outputKind: 'object',
    effects: [
      'Claude Code only: requires $CLAUDE_CODE_SESSION_ID. pi does not expose its session id to subprocesses, so fork is unavailable under pi — use `crtr agent new` instead.',
      'Spawns a forked agent session in a sibling tmux pane.',
      'Creates a job entry and result sidecar as with `crtr agent new`.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const agentKind = detectAgentKind();
    if (agentKind === 'pi') {
      throw new InputError({
        error: 'fork_unsupported',
        message: 'crtr agent fork is not supported under pi: pi does not expose the active session id to subprocesses.',
        next: 'Use `crtr agent new` to spawn a fresh pi agent instead.',
      });
    }
    const parentSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (parentSessionId === undefined || parentSessionId === '') {
      throw new InputError({
        error: 'missing_session_id',
        message: 'crtr agent fork requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
        next: 'Run this command from within a Claude Code session.',
      });
    }

    const workCwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const sessionCwd = process.env['CRTR_SESSION_CWD'] && process.env['CRTR_SESSION_CWD'] !== ''
      ? process.env['CRTR_SESSION_CWD']
      : process.cwd();
    const name = input['name'] as string;

    // Session wiring: join the caller's session or mint a new one if none.
    const { sessionId: envSession, parentJobId } = currentSessionContext();
    const rootPane = process.env['TMUX_PANE']!;
    let sessionId = envSession;
    const parent = parentJobId;
    if (sessionId === null) sessionId = mintSessionId();
    ensureSession({ sessionId, rootPane, tmuxSession: subagentSessionName(rootPane), cwd: sessionCwd });

    // Phase 4.3: use root_node_id from the session view; fall back to the pane node.
    const forkView = loadSessionView(sessionId, sessionCwd);
    const spawnerNode = parent ?? getSessionRootNodeId(forkView ?? {}) ?? hostPaneNodeId(rootPane);

    const { jobId } = createJob('fork', { cwd: workCwd });
    recordJobReportTo(jobId, {
      reportTo: [spawnerNode],
      sessionId,
      sessionCwd,
      name,
      title: `Fork of ${name}`,
    });

    const result = spawnAgent({
      prompt: `Fork of session ${parentSessionId}`,
      cwd: workCwd,
      jobId,
      fork: { sessionId: parentSessionId },
      maxPanesPerWindow: resolveMaxPanes(),
      name,
      env: {
        CRTR_SESSION_ID: sessionId,
        CRTR_SESSION_CWD: sessionCwd,
        CRTR_PARENT_JOB_ID: jobId,
        CRTR_REPORT_TO: spawnerNode,
      },
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const forkPaneId = result.paneId ?? 'unknown';
    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `forked pane ${forkPaneId} spawned` });

    appendAgent(sessionId, sessionCwd, {
      job_id: jobId,
      node_id: jobId,
      parent,
      report_to: [spawnerNode],
      subscribes_to: [],
      name,
      agent: 'fork',
      pane_id: forkPaneId,
      cwd: workCwd,
      created: new Date().toISOString(),
      title: `Fork of ${name}`,
      host_session_id: null,
      status: 'running',
    });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});
