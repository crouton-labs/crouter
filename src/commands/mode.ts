// `crtr mode` umbrella — modes of operation: spec, plan, implement, review, debug.
//
// Collects the workflow-oriented commands:
//   spec / plan / debug  — the artifact and root-cause workflows (from their
//                          own files); planner, implementer, reviewer — the
//                          handoff-spawn leaves previously under `agent new`.
//
// The spawn primitives (agent new / fork) and subagent management remain under
// `crtr agent`. Results from spawned workers are collected at `crtr job`.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { existsSync } from 'node:fs';
import { createJob, appendEvent, recordJobPane } from '../core/jobs.js';
import { spawnAndDetach, spawnAgent } from '../core/spawn.js';
import {
  planHandoffPrompt,
  implementHandoffPrompt,
  reviewerHandoffPrompt,
} from '../prompts/agent.js';
import {
  assertTmux,
  resolveMaxPanes,
  followUpResult,
} from './agent.js';
import { registerSpec } from './spec.js';
import { registerPlan } from './plan.js';
import { registerDebug } from './debug.js';

const DEFAULT_KILL_SECS = 2;

// ---------------------------------------------------------------------------
// mode planner
// ---------------------------------------------------------------------------

const newPlanner = defineLeaf({
  name: 'planner',
  help: {
    name: 'mode planner',
    summary: 'launch a planning agent for an approved spec; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'spec_path', type: 'path', required: true, constraint: 'Absolute path to the spec file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — run it and report the worker\'s result; do not relay it to the user.' },
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

    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    const plannerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `planner pane ${plannerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// mode implementer
// ---------------------------------------------------------------------------

const newImplementer = defineLeaf({
  name: 'implementer',
  help: {
    name: 'mode implementer',
    summary: 'launch an implementation agent for an approved plan; closes the originating pane after handoff',
    params: [
      { kind: 'positional', name: 'plan_path', type: 'path', required: true, constraint: 'Absolute path to the plan file.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — run it and report the worker\'s result; do not relay it to the user.' },
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

    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    const implPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `implementer pane ${implPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// mode reviewer
// ---------------------------------------------------------------------------

const newReviewer = defineLeaf({
  name: 'reviewer',
  help: {
    name: 'mode reviewer',
    summary: 'launch a reviewer agent for a plan or spec artifact; the originating pane stays alive to collect the verdict',
    params: [
      { kind: 'positional', name: 'artifact_path', type: 'path', required: true, constraint: 'Absolute path to the artifact to review.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: ['plan', 'spec'], required: true, constraint: 'Artifact kind to review.' },
      { kind: 'flag', name: 'spec-path', type: 'path', required: false, constraint: 'Absolute path to the spec, for plan reviews. Omit for spec reviews.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — run it and report the worker\'s result; do not relay it to the user.' },
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

    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    const reviewerPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `reviewer pane ${reviewerPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// mode (root umbrella)
// ---------------------------------------------------------------------------

export function registerMode(): BranchDef {
  return defineBranch({
    name: 'mode',
    rootEntry: {
      concept: 'modes of operation: spec → plan → implement → review → debug. Workflow commands for the full agentic development lifecycle',
      desc: 'spec, plan, implement, review, debug workflows',
      useWhen: 'running any structured workflow phase — writing a spec, decomposing into a plan, handing off to an implementer or reviewer, or root-causing a bug. These are the "what to do next" commands; `crtr agent new` is the raw spawn primitive.',
    },
    help: {
      name: 'mode',
      summary: 'modes of operation: spec, plan, implement, review, debug',
      model:
        'Full agentic development lifecycle in one subtree. spec captures requirements; plan decomposes them into executable steps; planner/implementer/reviewer are the handoff-spawn leaves that delegate each phase to a fresh worker and return a job handle; debug root-causes failures with a reproduce-first workflow. Spawned workers register as jobs — monitor and collect at `crtr job`.',
      children: [
        { name: 'spec', desc: 'create, read, list specifications', useWhen: 'capturing requirements before planning' },
        { name: 'plan', desc: 'create, read, list plans', useWhen: 'shaping or inspecting work' },
        { name: 'debug', desc: 'reproduce-first root-cause workflow', useWhen: 'a bug, test failure, or unexpected behavior needs root-causing' },
        { name: 'planner', desc: 'planning agent for an approved spec', useWhen: 'handing off spec → plan decomposition to a fresh agent' },
        { name: 'implementer', desc: 'implementation agent for an approved plan', useWhen: 'handing off plan → code implementation to a fresh agent' },
        { name: 'reviewer', desc: 'review agent for a plan or spec artifact', useWhen: 'launching a review of a plan or spec artifact' },
      ],
    },
    children: [registerSpec(), registerPlan(), registerDebug(), newPlanner, newImplementer, newReviewer],
  });
}
