import { planReviewPrompt, specReviewPrompt } from './review.js';

/**
 * First user message for a spec → plan handoff.
 *
 * Thin prompt: the worker discovers the full planning workflow by running
 * `crtr flow plan new -h`, then saves the plan via `crtr flow plan new`. This avoids
 * embedding the planPrompt() blob here and keeps the prompt in sync with the
 * live CLI without any coupling.
 */
export function planHandoffPrompt(specPath: string, jobId: string): string {
  return `You were launched in a new tmux pane to turn an approved spec into a plan.

**Spec:** ${specPath}

1. Run \`crtr flow plan new -h\` to load the planning workflow and output schema.
2. Read the spec end-to-end.
3. Follow the workflow from step 1 and save the plan by passing the plan markdown to \`crtr flow plan new\` on stdin.
4. When done, submit your result:

\`\`\`bash
echo '{"status":"done","plan_saved":true}' > /tmp/crtr-result-${jobId}.json
crtr job submit ${jobId} --context-file /tmp/crtr-result-${jobId}.json
\`\`\`

If you cannot complete the plan, still submit:

\`\`\`bash
echo '{"status":"failed","reason":"<why>"}' > /tmp/crtr-result-${jobId}.json
crtr job submit ${jobId} --context-file /tmp/crtr-result-${jobId}.json
\`\`\`

Begin now.`;
}

/**
 * First user message for a plan → implementation handoff.
 */
export function implementHandoffPrompt(planPath: string, jobId: string): string {
  return `You are executing an approved plan. For small plans, implement directly.
For plans with parallelizable scale, orchestrate parallel subagents and
coordinate them — don't write all the code yourself when the plan is
structured to fan out.

**Plan to implement:** ${planPath}

## Phase 1: Read

1. Read the plan end-to-end. If it references a spec, read that too.
2. Read the files the plan names under "Files to modify / create" and
   "Existing utilities to reuse" to ground yourself in current code.
3. If the plan has task blocks with dependencies, extract the task list,
   dependency graph, and integration contracts.

## Phase 2: Scale

Count the plan's **independent task groups** (tasks with no mutual
dependencies that can run in parallel). Pick the strategy:

| Independent groups | Files touched | Strategy |
|-------------------|---------------|----------|
| 1                 | 1–3           | **Implement directly.** Skip Phases 3–5; just execute the plan and go to Phase 6. |
| 1–2               | 3–5           | Implement directly, or single subagent if you want parallelism with verification |
| 2–4               | 5–15          | **2 parallel subagents** |
| 4–8               | 10–30         | **3 parallel subagents** |
| 8+                | 25+           | **4 parallel subagents** (cap) |

Use the higher column to pick the tier. Never spawn more subagents than
there are independent groups. **Bump one tier** if: tight cross-group
interface coordination, mixed languages/frameworks, or both infra +
application layers change.

## Phase 3: Partition

Group tasks into **disjoint sets** where:

- Each group owns clear file boundaries — **no two groups edit the same files**.
- Within a group, tasks are sequenced for one subagent to execute in order.
- Across groups, dependencies become layers: dependent groups run *after*
  their predecessors complete.

If two tasks must touch the same file, sequence them in the same group.

## Phase 4: Dispatch

For each task group in the current dependency layer, dispatch a subagent
in parallel via the Task tool. Use \`general-purpose\` by default; use
\`devcore:programmer\` if the project has devcore installed.

**Each subagent's prompt must include:**
- The specific tasks from the plan it owns (paste verbatim)
- The plan path: \`${planPath}\`
- The spec path if one exists
- The exact file ownership for this group
- Integration contracts it produces or consumes (types, APIs, shapes)
- **Constraint: do NOT run tests or typechecks** — other subagents may be
  mid-edit. The orchestrator runs verification at layer boundaries.
- Instruction to return when its tasks are complete, surfacing blockers

## Phase 5: Coordinate

Wait for all subagents in the current layer. Then:

- If any reports a blocker, resolve it: fix yourself, adjust scope with
  the user, or re-dispatch a corrected task. Don't proceed past the blocker.
- Run the plan's verification for the just-finished layer (tests, manual
  checks). Fix any failures before dispatching the next layer.
- Dispatch the next layer.

**Stay in the coordinator role.** Don't implement tasks yourself unless a
subagent returns blocked work and the fix is small enough that re-dispatch
would be slower.

## Phase 6: Report and submit

When all tasks complete and verification passes, submit your result:

\`\`\`bash
echo '{"status":"done","summary":"<one-line summary of files touched>"}' > /tmp/crtr-result-${jobId}.json
crtr job submit ${jobId} --context-file /tmp/crtr-result-${jobId}.json
\`\`\`

If implementation fails, still submit:
\`\`\`bash
echo '{"status":"failed","reason":"<why>"}' > /tmp/crtr-result-${jobId}.json
crtr job submit ${jobId} --context-file /tmp/crtr-result-${jobId}.json
\`\`\`

## Guardrails (apply to you AND your subagents)

- **No redesign.** If the plan is wrong, surface the issue — do not
  silently substitute your own approach.
- **No scope expansion.** No drive-by refactors, no "while I'm here"
  cleanup, no new abstractions the plan didn't request.
- **Honor conventions.** Match each file's existing style, naming, and
  patterns. Use the utilities the plan named.
- **Commit only if the user asks.**

Begin by reading the plan.`;
}

/**
 * First user message for a reviewer agent.
 * The reviewer submits via `crtr job submit` rather than `crtr agent submit`.
 */
export function reviewerHandoffPrompt(
  artifactPath: string,
  artifactKind: 'plan' | 'spec',
  specPath: string | null,
  jobId: string,
): string {
  const reviewBody =
    artifactKind === 'spec'
      ? specReviewPrompt(artifactPath)
      : planReviewPrompt(artifactPath, specPath);

  const patched = reviewBody.replace(
    '__CRTR_SUBMIT_INSTRUCTION__',
    `the submit command injected below. The \`--kill-pane\` flag closes this reviewer pane after submission — keep it, do not drop it.\n\n\`\`\`bash\ncat > /tmp/crtr-result-${jobId}.json <<'JSON'\n{"status":"done","review":"<your full review markdown>"}\nJSON\ncrtr job submit ${jobId} --context-file /tmp/crtr-result-${jobId}.json --kill-pane\n\`\`\``,
  );

  return `${patched}

After calling \`crtr job submit\`, your turn ends and the pane closes itself. Do NOT chat or summarize after submission.`;
}
