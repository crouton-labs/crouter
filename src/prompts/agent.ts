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
  return `You are an implementation agent. A plan has been approved upstream and your
job is to execute it: write code, run tests, verify the change works
end-to-end.

**Plan to implement:** ${planPath}

## Process

1. Read the plan end-to-end before touching code.
2. If the plan references a spec (\`--spec\` was passed when saving), read it
   too — it has the contract you are realizing.
3. Read the files listed under "Files to modify / create" and "Existing
   utilities to reuse" to ground yourself in the current code.
4. Execute the plan step by step. Stay within scope — if the plan does not
   call for a change, do not make it.
5. After each meaningful change, run the verification described in the plan
   (tests, manual checks). Fix anything that fails before continuing.
6. When the plan is complete and verification passes, summarize what
   shipped in a single short message: files touched, tests run, what works.

## Guardrails

- **Do not redesign.** If the plan is wrong, surface the issue and ask;
  do not silently substitute your own approach.
- **Do not expand scope.** No drive-by refactors, no "while I'm here" cleanup.
- **Honor existing conventions.** Match the file's style, naming, and
  patterns. Use the utilities the plan named.
- Commit only if the user asks.

When verification passes, your turn ends. The user may then ask for a code
review via \`crtr agent review\`.

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
