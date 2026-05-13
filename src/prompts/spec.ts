export function specPrompt(specsDir: string): string {
  return `# Spec workflow

You are entering a focused spec session. The goal is to produce a design +
requirements spec — a document describing **what** to build, the shape of the
solution, and the behaviors it must satisfy. A spec is upstream of a plan: it
captures decisions, not implementation steps.

Specs for this directory live at:
  ${specsDir}

If a relevant prior spec already exists there, read it first. Treat an
existing spec as the starting point — extend or revise rather than restart.

**Anti-pattern: do not fish for clarifications upfront.** Draft a concrete
spec first based on your investigation, *then* iterate. A specific draft the
user can react to converges faster than a list of questions in a vacuum.

## Phase 1: Shape

Build a comprehensive picture of the problem and the relevant code. Surface
existing patterns, constraints, and prior decisions.

- **Launch up to 3 Explore subagents IN PARALLEL** (single message, multiple
  tool calls) to cover the codebase efficiently.
  - Use 1 agent for narrow, well-scoped problems.
  - Use multiple agents when the spec touches several subsystems or you need
    to compare existing implementations.
  - Quality over quantity — 3 agents maximum.

After exploration, draft a high-level design in your head: the shape of the
solution, the new or changed pieces, the boundaries.

## Phase 2: Requirements

Translate the shape into concrete behavioral requirements. Each requirement
should be:

- **Testable** — has a clear pass/fail condition.
- **Behavior-focused** — describes what the system does, not how.
- **Scoped** — covers one observable behavior.

Group requirements by capability. Plain English is fine for most things. If
a requirement is conditional or stateful enough that phrasing gets fuzzy,
EARS templates can sharpen it (\`When <trigger>, the system shall <behavior>\`
or \`If <condition>, then the system shall <response>\`) — reach for them
when they earn their keep, not by default.

For larger / multi-component designs, before moving on it's worth walking
the design end-to-end as a sanity check: at each step from trigger to
final state, ask whether preconditions, state, failure handling, and
handoffs between components are actually specified. Skip this for small
self-contained specs — it's the kind of thing that catches bugs in the
seams, so apply it where there are seams.

## Phase 3: Deepen

- Read the critical files identified during Phase 1 to deepen your
  understanding before locking decisions.
- Reconcile requirements against the shape — if a requirement reveals a gap
  in the design, refine the design before saving.
- Use **AskUserQuestion** for any remaining ambiguities. Bias toward asking
  when a decision is non-obvious or when the user's intent is genuinely
  unclear.

**Important:** Use AskUserQuestion ONLY to clarify requirements or choose
between approaches. Never use it to ask "is this spec okay?" or "should I
save?" — the save step below is the approval moment.

## Phase 4: Save

Save the spec with \`crtr spec --name <kebab-case-name>\`. Pipe the markdown
body in via stdin (heredoc):

\`\`\`bash
crtr spec --name <kebab-case-name> <<'EOF'
# Spec: <one-line title>

## Context
<the problem this spec addresses, what motivates it, and the intended
outcome. Include relevant constraints — user goals, stakeholders, deadlines.>

## Design
<the shape of the solution. Components, data flow, key decisions and why
they were chosen. Reference existing code with \`file_path:line_number\`.>

## Requirements
<grouped behavioral requirements. Each one testable. Plain English is fine.>

### <Capability A>
- <one observable behavior>
- ...

### <Capability B>
- ...

## Out of scope
<things explicitly NOT covered, so the next reader knows where the edges
are.>

## Open questions
<anything you could not resolve. Empty if all decisions are pinned.>
EOF
\`\`\`

- Pick a short, descriptive kebab-case name. Names may be nested
  (\`crtr spec --name auth/refresh-tokens\`).
- The file lands at \`${specsDir}/<name>.md\`.
- If you are running inside tmux, the saved spec auto-opens in a side pane
  (or a new window when the current one is full) via termrender. The pane
  is **live** — it re-renders whenever the file changes on disk. For small
  tweaks, **edit the file path directly with the Edit tool** instead of
  re-running the heredoc save; the pane updates in place. Re-save via
  heredoc only when you want to re-trigger the reviewer.

## Phase 5: Review

By default the save command **blocks** while a reviewer agent reads the spec
in a side pane (10-min budget) and returns its findings on stdout under a
\`--- review ---\` marker. **Read the review** when the command returns:

- If \`Status: Approved\`, you are done.
- If \`Status: Issues Found\`, address the listed issues by editing the spec
  (\`crtr spec edit <name>\` or rewriting via the save command), then save
  again to re-trigger review.

Pass \`--no-review\` only when the spec is genuinely trivial (a paragraph, one
behavior, no design decisions). For anything substantive, take the review.

## Phase 6: Done

After the review returns Approved (or you have addressed its issues), your
turn ends. No need to summarize the spec in chat — the user can read the file.

If the user is ready to move into planning, ask once whether they want to
hand off now. If yes, run:

\`\`\`bash
crtr agent plan --spec <name>
\`\`\`

This fires up a planner in a new tmux pane and closes the current pane a
few seconds later. Do NOT run this without the user's go-ahead — the kill
is irreversible for this session.

## See also

- \`crtr spec list\` — list saved specs for the current directory
- \`crtr spec show <name>\` — print the body of a saved spec
- \`crtr spec edit <name>\` — open a saved spec in \$EDITOR
- \`crtr spec path [name]\` — absolute path of a spec or the specs directory
`;
}
