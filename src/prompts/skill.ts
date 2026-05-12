export function skillPrompt(): string {
  return `# Skills — capture and recall knowledge

\`crtr\` skills are markdown documents the agent loads on demand. Use them for
anything you want recalled later: architectural primers, runbooks, your
personal preferences, domain glossaries, decision records — methodology *or*
captured knowledge. The CLI is the index; \`crtr skill list/search/grep\`
discovers what's available so you never need a hand-maintained router file.

Skills live in three places, in resolution order:
1. **Scope-direct** — \`<scope-root>/skills/<name>/SKILL.md\` (no plugin wrapper, shown as \`user:<name>\` or \`project:<name>\`)
2. **Plugin skills** — \`<plugin>/skills/<name>/SKILL.md\` (shown as \`<scope>:<plugin>/<name>\`)
3. Project scope beats user scope; non-marketplace plugins beat marketplace ones.

Ambiguous names exit \`4\` — disambiguate with \`<plugin>:<name>\` or \`_:<name>\`
for scope-direct.

## Discover

\`\`\`
crtr skill list                    # one per line: <qualifier> — <description>
crtr skill search <query>          # rank by name, description, keywords
crtr skill grep <pattern>          # regex search across SKILL.md bodies
\`\`\`

## Load

\`\`\`
crtr skill show <name>             # print SKILL.md body to stdout
crtr skill show <plugin>:<name>    # disambiguate when names collide
crtr skill show _:<name>           # explicit scope-direct
crtr skill path <name>             # absolute path to SKILL.md
crtr skill where <name>            # {scope, plugin, path} as JSON
\`\`\`

\`show\` is the default verb: \`crtr skill <name>\` (with no verb) also prints
the body.

## Author

\`\`\`
crtr skill create [topic...]       # walkthrough — pick a template, capture knowledge
crtr skill new <name>              # bare scaffold, scope-direct (asks for --scope)
crtr skill new <plugin>:<name>     # bare scaffold inside an existing plugin
crtr skill show authoring-skills   # the SKILL.md authoring guide
\`\`\`

Reach for \`create\` when capturing something new — it walks you through choosing
a template (architectural primer, preference, runbook, glossary, decision,
freeform) and applies the right research workflow for that template.

## Toggle

\`\`\`
crtr skill enable <name>           # clear any disable in the chosen scope
crtr skill disable <name>          # hide from list and agent discovery
\`\`\`

## Exit codes

- \`0\` — success
- \`3\` — skill not found
- \`4\` — ambiguous name; use \`<plugin>:<name>\`
`;
}

export function skillCreatePrompt(topic: string): string {
  const topicLine = topic
    ? `User-provided topic: **${topic}**`
    : `No topic was provided — ask the user what they want to capture before continuing.`;
  return `# Capture knowledge as a skill

You are about to author a new \`crtr\` skill — a SKILL.md the agent will recall
on demand. Skills can capture *any* kind of durable knowledge: architectural
primers, runbooks, personal preferences, domain glossaries, decision records,
freeform notes. Don't conflate this with "methodology only" — if the user wants
the agent to remember something later, a skill is the right shape.

${topicLine}

## Step 1 — Decide the template

Ask the user (use \`AskUserQuestion\` if available) which template fits, with
your best guess pre-selected. Don't write anything until this is settled.

| Template | When to use | Research workflow |
|----------|-------------|-------------------|
| \`primer\` | Architectural/codebase knowledge — "how does X work, why does it exist" | Parallel-explore (Step 3a) |
| \`preference\` | User preferences, style guides, "remember I like X" | None — just ask 2-3 sharpening questions |
| \`runbook\` | Operational procedure, incident response, "here's how to do X" | Light — confirm steps with the user |
| \`glossary\` | Domain terms and invariants | None — list terms, get definitions from user |
| \`decision\` | ADR-style record: context / decision / consequences | Confirm context and tradeoffs with user |
| \`freeform\` | Anything else | Ask what shape they want |

If the user is asking for a codebase primer, **also** consider whether the
subsystem is large enough to justify it. Small/self-evident systems do not
need a primer — push back and offer to write a one-paragraph note instead.

## Step 2 — Decide the scope and name

Ask the user:
- **Scope** — \`user\` (lives in \`~/.crouter/skills/\`, available everywhere) or
  \`project\` (lives in \`<project>/.crouter/skills/\`, only here). Default
  \`project\` if cwd is inside a project scope; otherwise \`user\`.
- **Name** — kebab-case slug. Suggest one from the topic.

Check for collisions: \`crtr skill where <name>\`. If it exists, ask whether to
update the existing one or pick a different name.

## Step 3 — Research (template-specific)

### 3a. \`primer\` — parallel codebase exploration

Dispatch 4–8 \`Explore\` subagents in parallel. Partition by **slice, not by
directory**:

- **Entry points** — HTTP routes, CLI commands, cron, event handlers, public exports
- **Data model** — schemas, types, DB tables, key invariants
- **Control flow** — how a typical request/job traverses the system end-to-end
- **External integrations** — third-party APIs, queues, services, env vars
- **Tests** — what's tested reveals what's load-bearing
- **History** — recent \`git log\` for this area surfaces ongoing work and pain
- **Cross-cutting** — auth, errors, logging, feature flags as they apply here

Each subagent must return **concrete \`file:line\` references**, *non-obvious*
facts (skip what's obvious from filenames), naming conventions, and gotchas.
Reject vague summaries.

### 3b. \`preference\` / \`glossary\` / \`decision\` — interview

Use \`AskUserQuestion\` to batch sharpening questions (≤4 at a time, multiple
choice with your best guess first). Frame each as "here's my read; is this
right?" Never write assumptions into the skill — if a fact isn't confirmed by
code or the user, it doesn't go in.

### 3c. \`runbook\` — walk it

If the procedure exists, run/grep it and confirm. Otherwise, have the user
narrate it once and read back the steps.

## Step 4 — Verify intent

Before writing, summarize your working hypothesis back to the user in 2-3
sentences: **what this skill is about and when it should be loaded.** This is
what code and grep can't tell you. Get a yes or correction.

## Step 5 — Scaffold and write

Run:

\`\`\`
crtr skill new <name> --scope <user|project> --description "<one-line trigger>"
\`\`\`

(For a plugin-scoped skill instead, use \`crtr skill new <plugin>:<name>\`.)

This creates \`SKILL.md\` with frontmatter only. Open it and fill the body
using the template skeleton below for the kind you chose. **Density rules:**
\`file:line\` over prose; tables where structure fits; skip anything
self-evident from a 30-second skim of the code; no "this section covers…"
meta-commentary.

The \`description:\` field drives auto-discovery — front-load the trigger
keywords the user (or agent) would naturally say. Aim for ≤250 chars.

### Skeletons

**\`primer\`**

\`\`\`markdown
# <topic>

## Purpose
Why this exists. The business problem it solves. Who depends on it.
(1–3 tight paragraphs — what code can't tell you.)

## Architecture
Components, responsibilities, data/control flow, boundaries.

## File map
| Path | Role |
|------|------|
| \`src/foo/bar.ts\` | … |

## Key concepts
Domain terms, invariants, non-obvious constraints.

## Entry points
Where work enters the system, with \`file:line\`.

## Gotchas
Non-obvious coupling. Things that look broken but aren't. Past footguns.

## Related
- \`<other-skill>\` — how they interact
\`\`\`

**\`preference\`**

\`\`\`markdown
# <topic preferences>

## Rule
What the user wants.

## Why
Reason given — past incident, strong preference, constraint.

## How to apply
When/where this guidance kicks in.
\`\`\`

**\`runbook\`**

\`\`\`markdown
# <procedure>

## When to run this
Triggering condition.

## Steps
1. …
2. …

## Verification
How to confirm success.

## Rollback
How to undo if something goes wrong.
\`\`\`

**\`glossary\`**

\`\`\`markdown
# <domain> glossary

| Term | Definition | Notes |
|------|------------|-------|
| … | … | … |
\`\`\`

**\`decision\`**

\`\`\`markdown
# <decision title> — <date>

## Context
What forced the decision.

## Decision
What we chose.

## Consequences
What this costs us. What it buys us.

## Alternatives considered
- …
\`\`\`

## Step 6 — Verify the skill is discoverable

\`\`\`
crtr skill where <name>            # confirm path/scope
crtr skill list                    # confirm it shows up
crtr skill show <name>             # confirm the body reads well
\`\`\`

If \`description:\` doesn't trigger the right discoveries, sharpen it. If the
body is bloated, cut it. Budget ~150 lines for SKILL.md; move deep reference
into sibling files in the same directory.

## Constraints

- Push back on trivial captures — if a one-line note in CLAUDE.md or a code
  comment would do, suggest that instead.
- Never write unconfirmed assumptions into the skill.
- For updates to an existing skill, diff your draft against the current file
  and call out what changed and why before writing.
- Update related skills' \`## Related\` sections if you're adding something
  that interacts with them.
`;
}
