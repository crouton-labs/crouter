// `crtr agent` umbrella — agentic workflows: spec/plan/debug + spawn primitives.
//
// `agent new {prompt,fork,planner,implementer,reviewer}` are the spawn leaves
// (formerly `job start *`). Spawning creates a job record; monitoring lives at
// `crtr job`. This split keeps the job registry agnostic of producer — agents
// are one producer, future producers compose under their own subtree.
//
// Terminal-write contract for spawned workers:
//   Worker calls `crtr job submit` → jobs.writeResult(jobId, result, 'done').
//   If claude exits without submitting, the wrapper shell calls `crtr job _fail`
//   → jobs.writeResult(jobId, {}, 'failed') IF result.json does not yet exist.
//   `job read result` watches result.json appearance as the sole completion signal.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { createJob, appendEvent } from '../core/jobs.js';
import { spawnAgent, spawnAndDetach, isInTmux } from '../core/spawn.js';
import { readConfig } from '../core/config.js';
import { planHandoffPrompt, implementHandoffPrompt, reviewerHandoffPrompt } from '../prompts/agent.js';
import { existsSync } from 'node:fs';
import { registerSpec } from './spec.js';
import { registerPlan } from './plan.js';
import { registerDebug } from './debug.js';

const DEFAULT_KILL_SECS = 2;

function followUpResult(jobId: string): string {
  return `crtr job read result ${jobId} --wait`;
}

function resolveMaxPanes(): number {
  const cfg = readConfig('user');
  return cfg.max_panes_per_window;
}

function assertTmux(): void {
  if (!isInTmux()) {
    throw new InputError({
      error: 'not_in_tmux',
      message: 'crtr agent new requires tmux (TMUX env var not set).',
      next: 'Run inside a tmux session.',
    });
  }
}

// ---------------------------------------------------------------------------
// agent new prompt
// ---------------------------------------------------------------------------

const newPrompt = defineLeaf({
  name: 'prompt',
  help: {
    name: 'agent new prompt',
    summary: 'spawn a fresh Claude agent with a prompt; returns a job handle immediately',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'Prompt text sent to the spawned agent.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory for the spawned agent. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read status|logs|result` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a Claude agent in a sibling tmux pane.',
      'Creates a job entry at $XDG_STATE_HOME/crtr/jobs/<job_id>/.',
      'On completion, result writes atomically to result.json.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const prompt = input['prompt'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    const { jobId } = createJob('prompt', { cwd });

    const promptWithSubmit = `${prompt}

---
When your task is complete, submit your result (markdown body piped on stdin):
\`\`\`bash
crtr job submit ${jobId} <<'MD'
<your result as markdown>
MD
\`\`\`
If you cannot complete the task, submit a failure with a reason (no stdin needed):
\`\`\`bash
crtr job submit ${jobId} --status failed --reason "<why>"
\`\`\``;

    const result = spawnAgent({
      prompt: promptWithSubmit,
      cwd,
      jobId,
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const paneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `pane ${paneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent new fork
// ---------------------------------------------------------------------------

const newFork = defineLeaf({
  name: 'fork',
  help: {
    name: 'agent new fork',
    summary: 'fork the current Claude session into a sibling pane; returns a job handle immediately',
    params: [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
      'Spawns a forked Claude session in a sibling tmux pane.',
      'Creates a job entry and result sidecar as with `agent new prompt`.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const parentSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (parentSessionId === undefined || parentSessionId === '') {
      throw new InputError({
        error: 'missing_session_id',
        message: 'crtr agent new fork requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
        next: 'Run this command from within a Claude Code session.',
      });
    }

    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    const { jobId } = createJob('fork', { cwd });

    const promptWithSubmit = `Fork of session ${parentSessionId}

---
When your task is complete, submit your result (markdown body piped on stdin):
\`\`\`bash
crtr job submit ${jobId} <<'MD'
<your result as markdown>
MD
\`\`\`
If you cannot complete the task, submit a failure with a reason (no stdin needed):
\`\`\`bash
crtr job submit ${jobId} --status failed --reason "<why>"
\`\`\``;

    const result = spawnAgent({
      prompt: promptWithSubmit,
      cwd,
      jobId,
      fork: { sessionId: parentSessionId },
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const forkPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `forked pane ${forkPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent new planner
// ---------------------------------------------------------------------------

const newPlanner = defineLeaf({
  name: 'planner',
  help: {
    name: 'agent new planner',
    summary: 'launch a planning agent for an approved spec; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'spec_path', type: 'path', required: true, constraint: 'Absolute path to the spec file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a planner agent in a sibling tmux pane.',
      'Closes the originating pane after a short delay.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const specPath = input['spec_path'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(specPath)) {
      throw new InputError({
        error: 'not_found',
        message: `spec not found: ${specPath}`,
        field: 'spec_path',
        next: 'Provide an absolute path to an existing spec file.',
      });
    }

    const { jobId } = createJob('planner', { cwd });

    const result = spawnAndDetach({
      prompt: planHandoffPrompt(specPath, jobId),
      cwd,
      jobId,
      placement: 'split-h',
      killAfterSeconds: DEFAULT_KILL_SECS,
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const plannerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `planner pane ${plannerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent new implementer
// ---------------------------------------------------------------------------

const newImplementer = defineLeaf({
  name: 'implementer',
  help: {
    name: 'agent new implementer',
    summary: 'launch an implementation agent for an approved plan; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'plan_path', type: 'path', required: true, constraint: 'Absolute path to the plan file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns an implementer agent in a sibling tmux pane.',
      'Closes the originating pane after a short delay.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const planPath = input['plan_path'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(planPath)) {
      throw new InputError({
        error: 'not_found',
        message: `plan not found: ${planPath}`,
        field: 'plan_path',
        next: 'Provide an absolute path to an existing plan file.',
      });
    }

    const { jobId } = createJob('implementer', { cwd });

    const result = spawnAndDetach({
      prompt: implementHandoffPrompt(planPath, jobId),
      cwd,
      jobId,
      placement: 'split-h',
      killAfterSeconds: DEFAULT_KILL_SECS,
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Check tmux is running and try again.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const implPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `implementer pane ${implPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent new reviewer
// ---------------------------------------------------------------------------

const newReviewer = defineLeaf({
  name: 'reviewer',
  help: {
    name: 'agent new reviewer',
    summary: 'launch a reviewer agent for a plan or spec artifact; the originating pane stays alive to collect the verdict',
    params: [
      { kind: 'positional', name: 'artifact_path', type: 'path', required: true, constraint: 'Absolute path to the artifact to review.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: ['plan', 'spec'], required: true, constraint: 'Artifact kind to review.' },
      { kind: 'flag', name: 'spec-path', type: 'path', required: false, constraint: 'Absolute path to the spec, for plan reviews. Omit for spec reviews.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to `claude -n`; surfaces in pane title and /resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Recommended next call.' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns a reviewer agent in a sibling tmux pane.',
      'The originating pane stays alive — wait on the result and act on the verdict.',
      'Creates a job entry and result sidecar.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const artifactPath = input['artifact_path'] as string;
    const artifactKind = input['kind'] as 'plan' | 'spec';
    const specPath = typeof input['specPath'] === 'string' ? input['specPath'] : undefined;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    if (!existsSync(artifactPath)) {
      throw new InputError({
        error: 'not_found',
        message: `artifact not found: ${artifactPath}`,
        field: 'artifact_path',
        next: 'Provide an absolute path to an existing artifact file.',
      });
    }

    const { jobId } = createJob('reviewer', { cwd });

    // The reviewer is a subordinate the caller waits on (verdict → revise or
    // hand off), NOT a handoff successor. Use spawnAgent so the originating
    // pane (planner/orchestrator) stays alive to collect the result; do not
    // self-kill the caller the way planner/implementer handoffs do.
    const result = spawnAgent({
      prompt: reviewerHandoffPrompt(artifactPath, artifactKind, specPath !== undefined ? specPath : null, jobId),
      cwd,
      jobId,
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    const reviewerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `reviewer pane ${reviewerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent new (branch)
// ---------------------------------------------------------------------------

const newBranch = defineBranch({
  name: 'new',
  help: {
    name: 'agent new',
    summary: 'spawn agent workers; all return a job handle immediately',
    children: [
      { name: 'prompt', desc: 'fresh agent with a prompt', useWhen: 'spawning a general-purpose agent' },
      { name: 'fork', desc: 'fork current session into a sibling pane', useWhen: 'branching the current session\'s context into a new agent' },
      { name: 'planner', desc: 'planning agent for a spec', useWhen: 'handing off spec → plan decomposition' },
      { name: 'implementer', desc: 'implementation agent for a plan', useWhen: 'handing off plan → code implementation' },
      { name: 'reviewer', desc: 'review agent for a plan or spec', useWhen: 'launching a review of a plan or spec artifact' },
    ],
  },
  children: [newPrompt, newFork, newPlanner, newImplementer, newReviewer],
});

// ---------------------------------------------------------------------------
// agent (root umbrella)
// ---------------------------------------------------------------------------

export function registerAgent(): BranchDef {
  return defineBranch({
    name: 'agent',
    help: {
      name: 'agent',
      summary: 'agentic workflows: spec, plan, debug, and spawning agent workers',
      model:
        'spec captures requirements; plan decomposes them; debug root-causes failures reproduce-first; new spawns the worker that executes the next phase. Spawned workers register as jobs — monitor and collect at `crtr job`.',
      children: [
        { name: 'spec', desc: 'create, read, list specifications', useWhen: 'capturing requirements before planning' },
        { name: 'plan', desc: 'create, read, list plans', useWhen: 'shaping or inspecting work' },
        { name: 'debug', desc: 'reproduce-first root-cause workflow', useWhen: 'a bug, test failure, or unexpected behavior needs root-causing' },
        { name: 'new', desc: 'spawn agent workers (prompt, fork, planner, implementer, reviewer)', useWhen: 'launching a new agent worker' },
      ],
    },
    children: [registerSpec(), registerPlan(), registerDebug(), newBranch],
  });
}
