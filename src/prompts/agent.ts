import { planPrompt } from './plan.js';

/**
 * First user message for a spec → plan handoff.
 * Bundles the full planning workflow with the spec to plan.
 */
export function planHandoffPrompt(specPath: string, plansDir: string): string {
  return `${planPrompt(plansDir)}

---

## Your task

You were just launched in a new tmux pane via \`crtr agent plan\`. A spec
has been approved upstream and you are responsible for turning it into a plan.

**Spec to plan:** ${specPath}

Read the spec end-to-end before anything else. Then proceed through the
workflow above. When you save the plan, pass \`--spec <spec-name>\` so the
plan reviewer can check alignment.

The originating pane has closed; the user is watching you here. Begin now.`;
}

/**
 * First user message for a plan → implementation handoff.
 */
export function implementHandoffPrompt(planPath: string): string {
  return `You are executing an approved plan. For small plans, implement directly.
For plans with parallelizable scale, orchestrate parallel subagents and
coordinate them — don't write all the code yourself when the plan is
structured to fan out.

**Plan to implement:** ${planPath}

## Phase 1: Read

1. Read the plan end-to-end. If it references a spec (\`--spec\` was passed
   at save time), read that too — it's the contract you are realizing.
2. Read the files the plan names under "Files to modify / create" (or the
   per-task \`Files:\` lines) and "Existing utilities to reuse" to ground
   yourself in current code.
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

## Phase 6: Report

When all tasks complete and verification passes, write one short message:
files touched per group, tests run, what works. The user may then ask for
a code review via \`crtr agent review\`.

## Guardrails (apply to you AND your subagents)

- **No redesign.** If the plan is wrong, surface the issue — do not
  silently substitute your own approach.
- **No scope expansion.** No drive-by refactors, no "while I'm here"
  cleanup, no new abstractions the plan didn't request.
- **Honor conventions.** Match each file's existing style, naming, and
  patterns. Use the utilities the plan named.
- **Commit only if the user asks.**

You were launched in a new tmux pane via \`crtr agent implement\`. The
originating pane has closed; the user is watching you here. Begin by reading
the plan.`;
}

/**
 * First user message for a handoff to code review of the working tree.
 */
export function reviewHandoffPrompt(): string {
  return `You are a code reviewer. A change has just been implemented and your job is
to review it before it lands.

## Scope

Review the **uncommitted** changes in the working tree of the current
directory. Use \`git status\` and \`git diff\` (including staged changes via
\`git diff --cached\`) to enumerate what changed. If there are zero changes,
say so and stop.

## What to check

| Category | What to look for |
|----------|------------------|
| Correctness | Does the code do what it claims? Off-by-ones, wrong branches, missed cases. |
| Security | Injection, auth bypass, leaking secrets, unsafe defaults. |
| Style fit | Matches the file's existing conventions, naming, error-handling style. |
| Tests | Are there tests for new behavior? Do they actually exercise the change? |
| Scope | Did the change stay within its mandate, or sneak in unrelated edits? |
| Reuse | Are there existing utilities that should have been used? |

## Calibration

Only flag issues that would matter to the next reader, on-call, or future
maintainer. Nits are fine in a "Recommendations" section, but **do not block
on style preferences**. Approve unless something is wrong, missing, or risky.

## Output

\`\`\`
## Code Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [file:line]: [specific issue] — [why it matters]

**Recommendations (advisory):**
- [suggestions]
\`\`\`

After printing the review, your turn ends.

You were launched in a new tmux pane via \`crtr agent review\`. The
originating pane has closed; the user is watching you here. Begin by checking
the working tree.`;
}
