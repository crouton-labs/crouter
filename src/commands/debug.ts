// `crtr agent debug` leaf — reproduce-first root-cause workflow.
//
// Running it spawns a reproduction-only agent in a sibling tmux pane (the same
// spawn + job-handle shape as `crtr agent new prompt`) and returns a job handle
// plus a follow_up. The orchestrator-side methodology lives in FLOW_DEBUG_GUIDE
// (the leaf's help.guide), loaded via `crtr agent debug -h` after the repro
// agent returns. Methodology stays in the CLI guide field, like PLAN_NEW_GUIDE;
// no builtin skill.
export const FLOW_DEBUG_GUIDE = `## Debug workflow — reproduce first

Audience: the agent that ran \`crtr agent debug\`. A reproduction agent is
already spawned in a sibling pane. It writes ONE failing integration test and
never fixes anything. You do everything after: gate on the repro, root-cause,
fix, verify against that same test.

### Phase 0: Await the repro agent

Run \`crtr job read result <job_id> --wait\` (10-min budget).
On status:"timeout": re-issue the wait, or run \`crtr job read logs <job_id> --follow\`
until the job is terminal.

### Phase 1: Gate on reproduction

\`reproduces:true\`: read \`test_path\`, run \`test_command\` YOURSELF, confirm
it fails for the stated reason. Do not trust the agent's claim — if it passes
or fails differently, treat repro as NOT achieved. This test is the regression
gate; it stays in the suite after the fix.
\`status:"failed"\` / \`reproduces:false\` / your run disproves it: no repro
harness. Continue, but record "no reproduction — fix unverified; do not claim
verified-fixed."

### Phase 2: Reconnaissance

Read the key files yourself — entry point, failure point, the data flow
between. \`git log\` / \`git blame\` near the failure: recent changes are
high-signal.

### Phase 3: Assess difficulty, scale investigators

Simple → solo (Explore subagents for tracing if the area is large).
Medium → 2–3 parallel \`devcore:senior-advisor\`: data-flow tracer, assumption
auditor, change investigator.
Hard (intermittent, races, "been stuck", many modules) → 3–5 parallel:
end-to-end tracer, assumption breaker, git archaeologist, boundary inspector.
Give investigators file paths, observed behavior, and concrete tasks — never
your hypotheses. Challenge theories against each other; the one that survives
disconfirmation wins.

### Phase 4: Fix

Minimal root-cause fix. No scope expansion, no drive-by refactor.

### Phase 5: Verify

Re-run \`test_command\`: it MUST now pass. Run the broader suite for
regressions. If there was no repro test, state the fix is unverified by
reproduction and recommend explicit manual verification.

### Phase 6: Report

Root cause (exact line + why), evidence, the now-passing repro test path,
confidence (High/Medium/Low; if not High, name what is uncertain).

### Constraints

The repro test is the regression guard — it stays; a fix-agent must never
weaken it. Investigators run in forked contexts; they return summaries, not
raw output. No code changes during Phases 2–3 except the repro test.`;

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { createJob, appendEvent } from '../core/jobs.js';
import { spawnAgent, isInTmux } from '../core/spawn.js';
import { readConfig } from '../core/config.js';
import { reproHandoffPrompt } from '../prompts/debug.js';

// Inlined from job.ts (module-private there; not exported, per the no-shim
// convention). Same forms.
function resolveMaxPanes(): number {
  const cfg = readConfig('user');
  return cfg.max_panes_per_window;
}

function assertTmux(): void {
  if (!isInTmux()) {
    throw new InputError({
      error: 'not_in_tmux',
      message: 'crtr agent debug requires tmux (TMUX env var not set).',
      next: 'Run inside a tmux session.',
    });
  }
}

export function registerDebug(): LeafDef {
  return defineLeaf({
    name: 'debug',
    help: {
      name: 'agent debug',
      summary:
        'reproduce-first root-cause workflow: spawns a reproduction agent, then you root-cause and fix',
      guide: FLOW_DEBUG_GUIDE,
      params: [
        {
          kind: 'stdin',
          name: 'steps_to_reproduce',
          required: true,
          constraint: 'Prose describing how to reproduce the failure. Pipe on stdin.',
        },
        {
          kind: 'flag',
          name: 'summary',
          type: 'string',
          required: true,
          constraint: 'One paragraph summary of the failure: symptom, where observed, expected vs actual.',
        },
        {
          kind: 'flag',
          name: 'cwd',
          type: 'path',
          required: false,
          constraint: 'Working directory for the spawned agent. Defaults to process.cwd().',
        },
      ],
      output: [
        {
          name: 'job_id',
          type: 'string',
          required: true,
          constraint: 'Use with `job read status`, `job read logs`, `job read result`, `job cancel`.',
        },
        {
          name: 'follow_up',
          type: 'string',
          required: true,
          constraint: 'Recommended next call.',
        },
      ],
      outputKind: 'object',
      effects: [
        'Spawns a reproduction agent in a sibling tmux pane.',
        'Creates a job entry at $XDG_STATE_HOME/crtr/jobs/<job_id>/.',
        'On completion, result writes atomically to result.json.',
      ],
    },
    run: async (input) => {
      assertTmux();
      const stepsToReproduce = input['steps_to_reproduce'] as string;
      const summary = input['summary'] as string;
      const cwd = (input['cwd'] as string | undefined) ?? process.cwd();

      const issue = `${summary}\n\n${stepsToReproduce}`;

      const { jobId } = createJob('debug-repro', { cwd });

      const result = spawnAgent({
        prompt: reproHandoffPrompt(issue, jobId),
        cwd,
        jobId,
        maxPanesPerWindow: resolveMaxPanes(),
      });

      if (result.status === 'not-in-tmux') {
        throw new InputError({
          error: 'not_in_tmux',
          message: result.message,
          next: 'Run inside a tmux session.',
        });
      }
      if (result.status === 'spawn-failed') {
        throw new InputError({
          error: 'spawn_failed',
          message: result.message,
          next: 'Check tmux is running and try again.',
        });
      }

      const paneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
      appendEvent(jobId, {
        level: 'info',
        event: 'worker_started',
        message: `repro pane ${paneLabel} spawned`,
      });

      return {
        job_id: jobId,
        follow_up: `Await the reproduction agent: crtr job read result ${jobId} --wait. Then run \`crtr agent debug -h\` and follow the workflow from Phase 1.`,
      };
    },
  });
}
