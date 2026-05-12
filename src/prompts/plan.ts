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

- Pick a short, descriptive kebab-case name. Names may be nested
  (\`crtr plan --name auth/jwt-refresh\`) — they become subdirectories.
- The file lands at \`${plansDir}/<name>.md\`.
- If you are running inside tmux, the saved plan auto-opens in a side pane
  via termrender. No extra step needed.

## Phase 5: Done

Your turn ends after the save command succeeds. No need to summarize the plan
in chat — the user can read the file.

## See also

- \`crtr plan list\` — list saved plans for the current directory
- \`crtr plan show <name>\` — print the body of a saved plan
- \`crtr plan edit <name>\` — open a saved plan in \$EDITOR
- \`crtr plan path [name]\` — absolute path of a plan or the plans directory
`;
}
