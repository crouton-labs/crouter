export function planPrompt(plansDir: string): string {
  return `# Planning workflow

You are entering a focused planning session. The goal is to produce an
implementation plan that another agent (or you, in a later turn) can execute
without re-discovering everything. A plan is a map, not a tutorial.

Plans for this directory live at:
  ${plansDir}

If a relevant prior plan already exists there, read it first.

## Phase 1: Initial Understanding

Build a comprehensive picture of the user's request and the code involved.
Actively search for existing functions, utilities, and patterns that can be
reused — do not propose new code when a suitable implementation already
exists.

- **Launch up to 3 Explore subagents IN PARALLEL** (single message, multiple
  tool calls) to cover the codebase efficiently.
  - Use 1 agent when the task is isolated to known files, the user provided
    specific paths, or the change is small and targeted.
  - Use multiple agents when scope is uncertain, multiple areas of the codebase
    are involved, or you need to understand existing patterns before planning.
  - Quality over quantity — 3 agents maximum; usually 1 is right.
  - When using multiple agents, give each a distinct focus (existing impls,
    related components, test patterns) so they do not duplicate work.

## Phase 2: Design

Design the implementation approach based on Phase 1 findings.

- **Default**: launch at least 1 Plan agent — it validates your understanding
  and surfaces alternatives.
- **Skip agents** only for truly trivial tasks (typo fixes, single-line
  changes, simple renames).
- **Multiple agents (up to 3)** for tasks that benefit from different
  perspectives — large refactors, architectural changes, many edge cases.

In the Plan agent prompt:
- Provide comprehensive background context from Phase 1, including filenames
  and code-path traces.
- Describe requirements and constraints.
- Request a detailed implementation plan.

## Phase 3: Review

- Read the critical files identified by agents to deepen your understanding.
- Ensure the plan aligns with the user's original request.
- Use **AskUserQuestion** to clarify any remaining questions with the user.
  Bias toward asking when a decision is non-obvious — interrupting once is
  cheaper than building the wrong thing.

**Important:** Use AskUserQuestion ONLY to clarify requirements or choose
between approaches. Never use it to ask the user "is this plan okay?" or
"should I proceed?" — the save step below is the approval moment.

## Phase 4: Final Plan

### Quality bar

Hold the draft to these — they're cheap to satisfy and they save the
implementer from re-deciding things:

- Every decision pinned. No "if X then Y" branches, no "investigate
  whether…", no deferred choices. If you don't know, find out or ask now.
- No timelines, no fallbacks, no magic values, no "for now" shortcuts.
- Where the plan creates a new interface, schema, or contract, write the
  actual shape rather than "design a Foo type."

### Save

Save the plan with \`crtr plan --name <kebab-case-name>\`. Pipe the markdown
body in via stdin (heredoc):

\`\`\`bash
crtr plan --name <kebab-case-name> <<'EOF'
# Plan: <one-line title>

## Context
<why this change is being made — the problem it addresses, what prompted it,
and the intended outcome>

## Recommended approach
<your chosen approach. Include only the recommendation, not all alternatives.
Be concise enough to scan, detailed enough to execute.>

## Files to modify / create
- \`path/to/file.ts\` — <what changes>
- ...

## Existing utilities to reuse
- \`function-name\` from \`path/to/file.ts:LL\` — <why it fits>

## Verification
<how to test the changes end-to-end — run the code, run tests, etc.>
EOF
\`\`\`

For plans touching 4+ files across distinct concerns, the implementer can
dispatch parallel subagents — but only if you structure tasks for it. In
that case, replace "Files to modify / create" with task blocks like:

\`\`\`
## Tasks
- **Task 1**: <name>
  - Files: \`a.ts\`, \`b.ts\` (disjoint from other tasks)
  - Depends on: (none) | Task N
  - Integration: <shared types/APIs with exact shape>
  - Changes: <bullets>
\`\`\`

Skip this structure for small plans; it's noise when there's no
parallelism to unlock.

- Pick a short, descriptive kebab-case name. Names may be nested
  (\`crtr plan --name auth/jwt-refresh\`) — they become subdirectories.
- If this plan implements a saved spec, pass \`--spec <spec-name>\` so the
  reviewer can check alignment:
  \`crtr plan --name <name> --spec <spec-name> <<'EOF' ... EOF\`
- The file lands at \`${plansDir}/<name>.md\`.
- If you are running inside tmux, the saved plan auto-opens in a side pane
  (or a new window when the current one is full) via termrender. The pane
  is **live** — it re-renders whenever the file changes on disk. For small
  tweaks, **edit the file path directly with the Edit tool** instead of
  re-running the heredoc save; the pane updates in place. Re-save via
  heredoc only when you want to re-trigger the reviewer.

## Phase 5: Review

By default the save command **blocks** while a reviewer agent reads the plan
(and the spec, if \`--spec\` was passed) in a side pane (10-min budget) and
returns its findings on stdout under a \`--- review ---\` marker. **Read the
review** when the command returns:

- If \`Status: Approved\`, you are done.
- If \`Status: Issues Found\`, address the listed issues by editing the plan
  (\`crtr plan edit <name>\` or rewriting via the save command), then save
  again to re-trigger review.

Pass \`--no-review\` only when the plan is genuinely trivial (one-line fix,
typo, single-file rename). For anything substantive, take the review.

## Phase 6: Oversize check

If the save command emits a \`--- advisory ---\` warning that the plan is
too long, do not ignore it. Split the plan into a short index plan plus
one or more nested part plans, each under the threshold, and re-save. The
implementer will execute parts one at a time; very long plans tend to be
under-decomposed.

## Phase 7: Done

After the review returns Approved (or you have addressed its issues), your
turn ends. No need to summarize the plan in chat — the user can read the file.

If the user is ready to start building, ask once whether they want to hand
off now. If yes, run:

\`\`\`bash
crtr agent implement --plan <name>
\`\`\`

This fires up an implementer in a new tmux pane and closes the current
pane a few seconds later. Do NOT run this without the user's go-ahead.

## See also

- \`crtr plan list\` — list saved plans for the current directory
- \`crtr plan show <name>\` — print the body of a saved plan
- \`crtr plan edit <name>\` — open a saved plan in \$EDITOR
- \`crtr plan path [name]\` — absolute path of a plan or the plans directory
`;
}
