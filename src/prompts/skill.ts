export function skillPrompt(): string {
  return `# Skills — durable agent memory

Skills are markdown the agent loads on demand. **Audience: future LLM agent
sessions, not humans.** Write for the model: terse, decision-first, dense.
The CLI is the index — \`crtr skill list/search/grep\` discovers what's saved.

## Route by intent

If a query follows this prompt, route based on it. Run the suggested command
first, then act on its output.

- **Capture** ("save", "remember", "build context for", "make a skill"):
  \`crtr skill create [topic]\` — picks template, hints next command.
- **Find** ("what do we have on X", "skill for Y"):
  \`crtr skill search <query>\` → \`crtr skill show <name>\` on best hit.
- **Load by name** ("show me X"): \`crtr skill show <name>\`.
- **List all**: \`crtr skill list\`.
- **No intent given / query empty**: ask the user what they want before running.

Don't load \`create\` and \`template\` outputs in the same turn — \`create\` decides
the type, then call \`template\`.

Locations (resolution order):
1. **Scope-direct** \`<scope-root>/skills/<name>/SKILL.md\` → \`user:<name>\` / \`project:<name>\`
2. **Plugin skills** \`<plugin>/skills/<name>/SKILL.md\` → \`<scope>:<plugin>/<name>\`
3. Project > user; non-marketplace plugins > marketplace.

Ambiguous names exit \`4\` — disambiguate with \`<plugin>:<name>\` or \`_:<name>\`.

## Discover

\`\`\`
crtr skill list                    # <qualifier> — <description>
crtr skill search <query>          # ranked by name/description/keywords
crtr skill grep <pattern>          # regex across SKILL.md bodies
\`\`\`

## Load

\`\`\`
crtr skill show <name>             # body to stdout (default verb)
crtr skill show _:<name>           # explicit scope-direct
crtr skill path <name>             # absolute path
crtr skill where <name>            # {scope, plugin, path} JSON
\`\`\`

## Author (progressive disclosure)

\`\`\`
crtr skill create [topic...]            # pick a template type
crtr skill template <type> [topic]      # workflow + skeleton for that type
crtr skill new <name> --type <type>     # bare scaffold with typed frontmatter
\`\`\`

Five types — pick by what the agent does after reading:

- \`playbook\` — decide (judgment, heuristics, when-to-use)
- \`primer\` — navigate (codebase facts, architecture)
- \`reference\` — look up (stable facts, tables)
- \`runbook\` — execute (numbered procedure)
- \`freeform\` — none of the above (catchall)

Don't load \`create\` and \`template\` in the same turn — \`create\` decides the
type, then call \`template\`.

## Neighbors auto-append

\`crtr skill show <name>\` appends a \`## Neighbors\` section listing siblings
(same parent dir) and nested skills. Skill bodies should write \`## Related\`
**only** for cross-plugin or distant refs — within-plugin links are redundant.

Suppress with \`crtr skill show <name> --no-neighbors\`.

## Toggle

\`\`\`
crtr skill enable <name>
crtr skill disable <name>
\`\`\`

## Exit codes

\`0\` success · \`3\` not found · \`4\` ambiguous (qualify name)
`;
}

export function skillCreatePrompt(topic: string): string {
  const topicLine = topic
    ? `Topic: **${topic}**`
    : `No topic provided — ask the user what to capture before proceeding.`;
  return `# Author a skill — step 1: pick template type

You are about to write a skill (markdown read by future LLM agent sessions,
not humans). Pick the template, then load its workflow.

${topicLine}

## Templates

Pick by what the agent does after reading the skill:

- \`playbook\` — **decide**. Judgment, heuristics, when-to-use / when-not-to-use.
  Examples: skill-authoring, debugging methodology. Most skills are this.
- \`primer\` — **navigate**. Codebase/architectural facts. *"How does this
  subsystem work, why, what are the gotchas."* Triggers parallel-explore.
- \`reference\` — **look up**. Stable facts: protocol fields, API surface,
  glossaries, lookup tables. Source of truth is external (spec, docs).
- \`runbook\` — **execute**. Numbered procedure with decision points and
  rollback. Examples: deploy, incident response, review workflow.
- \`freeform\` — **none of the above**. Catchall for decision records, prefs,
  miscellany.

Litmus: *"when X, do Y"* → playbook. *"these are the fields of Y"* →
reference. *"step 1, step 2, step 3"* → runbook. *"how X is built inside
this repo"* → primer.

## Next

1. Pick a type. If unclear, use \`AskUserQuestion\` with your best guess first.
2. Run:

   \`\`\`
   crtr skill template <type>${topic ? ` ${topic}` : ' [topic]'}
   \`\`\`

   That output contains the research methodology, SKILL.md skeleton, and
   scaffold command. Follow it directly — don't paraphrase.

## Push back when

- Subsystem is small/self-evident → suggest CLAUDE.md note instead of primer.
- "Topic" is really a one-off task → don't capture; just do the work.
- Content is one-off lookup that lives elsewhere → link to it, don't mirror.
`;
}

export function skillTemplatePrompt(type: string, topic: string): string {
  const t = type.toLowerCase();
  if (t === 'primer') return primerTemplatePrompt(topic);
  if (t === 'playbook') return playbookTemplatePrompt(topic);
  if (t === 'reference') return referenceTemplatePrompt(topic);
  if (t === 'runbook') return runbookTemplatePrompt(topic);
  if (t === 'freeform') return freeformTemplatePrompt(topic);
  return `unknown template type: ${type}\nvalid: playbook | primer | reference | runbook | freeform\nrun \`crtr skill create\` to pick.\n`;
}

function topicLine(topic: string): string {
  return topic
    ? `Topic: **${topic}**`
    : `No topic — confirm with the user before continuing.`;
}

function primerTemplatePrompt(topic: string): string {
  return `# Primer — codebase knowledge skill

**Audience: future LLM agent sessions.** Captures *why* a subsystem exists +
non-obvious facts that code alone doesn't reveal. Lets a future session skip
re-exploration.

${topicLine(topic)}

## 1. Inventory (parallel)

- \`ls\` repo top level
- check stack manifests
- \`git log --oneline -15\` in this area
- \`crtr skill search <topic>\` / \`crtr skill list\` — does a primer already exist?

If subsystem is small/self-evident, **stop**. Suggest a CLAUDE.md note. Primers
are for large, complicated, or unintuitive systems only.

## 2. Scope + name

- **Scope**: \`project\` by default. \`user\` only if cross-repo.
- **Name**: kebab-case. Confirm no collision: \`crtr skill where <name>\`.

## 3. Parallel exploration

Dispatch **4–8 \`Explore\` subagents in parallel**, partitioned by *slice* (not
directory):

- Entry points (routes, CLI, events, public exports)
- Data model (schemas, types, invariants)
- Control flow (typical request/job end-to-end)
- External integrations (APIs, queues, env vars)
- Tests (what's tested = what's load-bearing)
- History (recent git log surfaces pain points)
- Cross-cutting (auth, errors, logging, flags as they apply)

Each subagent returns: concrete \`file:line\` refs, *non-obvious* facts (skip
filename-obvious), naming conventions, gotchas. Reject vague summaries.

## 4. Verify with user

Code = *what*. User = *why*. Use \`AskUserQuestion\` (≤4 questions,
multi-choice, best-guess first):

- Business purpose / who depends on it
- Surprising-looking architectural decisions
- Ownership / deprecation status / expected scale
- Canonical flow when multiple exist

Skip if greppable or won't change the primer. **Never write unconfirmed
assumptions.**

## 5. Scaffold

\`\`\`
crtr skill new <name> --type primer --scope project --description "<what+when, ≤250 chars, front-loaded triggers>"
\`\`\`

## 6. Write the body

\`\`\`markdown
# <topic>

## Purpose
Why this exists. Problem solved. Who depends on it.
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
\`file:line\` where work enters.

## Gotchas
Non-obvious coupling. Looks-broken-but-isn't. Past footguns.
\`\`\`

**No \`## Related\` for within-plugin siblings** — the CLI auto-appends a
\`## Neighbors\` section on \`crtr skill show\`. Add a manual \`## Related\`
only for cross-plugin or distant refs.

**Density rules:**
- \`file:line\` over prose
- Tables where structure fits
- Skip 30-second-skim-obvious
- No "this section covers…" meta
- Budget ~150 lines; deeper reference → sibling files

## 7. Verify

\`\`\`
crtr skill where <name>
crtr skill show <name>
crtr skill search <keyword>     # confirm description triggers discovery
\`\`\`

Sharpen description if discovery misses. Cut body if bloated.

## Updates

If updating existing primer: diff draft vs current, call out changes + why
before writing.
`;
}

function playbookTemplatePrompt(topic: string): string {
  return `# Playbook — methodology skill

**Audience: future LLM agent sessions.** Teaches *judgment*, not facts —
decision frameworks, heuristics, when-to-use / when-not-to-use. Examples:
skill-authoring, debugging methodology, multi-agent orchestration.

${topicLine(topic)}

## Litmus test

> Does this teach judgment, or describe an API?

If you'd write *"when X, do Y because Z"* → playbook. If you'd write tables
of fields/flags/events → reference material (put in sibling \`reference.md\`,
not SKILL.md). If neither fits → use \`crtr skill template freeform\` instead.

**Playbook markers:** teaches a framework · has "when (not) to use" · prose
over tables · reader makes better decisions after 30 seconds.

## 1. Interview

A playbook = user's accumulated judgment. Not greppable. Use
\`AskUserQuestion\` (≤4, multi-choice, best-guess first):

- The decision this skill teaches
- 2–4 most common failure modes without it
- Triggers (words/situations that should load it)
- Non-obvious rules that surprise newcomers

Push back on vagueness. *"Be thoughtful"* ≠ heuristic. *"Prefer one bundled
PR over many small ones for refactors here, because review churn dominates"*
= heuristic.

## 2. Scope + name

- **Scope**: \`user\` for cross-project methodology. \`project\` for repo-specific.
- **Name**: kebab-case, verb-or-noun-phrase. Not "guide-to-X".
- Check \`crtr skill where <name>\`.

## 3. Scaffold

\`\`\`
crtr skill new <name> --type playbook --scope <user|project> --description "<what it teaches + when to load, ≤250 chars, front-loaded triggers>"
\`\`\`

## 4. Density rules

LLM reasoning degrades past ~3k tokens. **Budget ~150 lines for SKILL.md.**

- Decision-first. *"When you need X"* before *"how X works"*.
- One well-placed "don't" > three paragraphs of explanation.
- Reasoning chains > example outputs. Show *how to think*, not *what to produce*.
- Section >20 lines without teaching judgment → move to \`reference.md\`.

**Test:** can someone reading 30 seconds make a better decision? If they need
to read the whole thing for value, you've buried the judgment.

## 5. Body skeleton

\`\`\`markdown
# <skill name>

<1-paragraph: what + when to load>

## When to use
- <trigger>

## When NOT to use
- <anti-trigger>

## The core decision
<central judgment — usually a heuristic or framework>

## <heuristic 1>
<2–6 lines, brief (anti-)example>

## <heuristic 2>
…

## Failure modes
- **<name>**: what it looks like; how to avoid
\`\`\`

**No \`## Related\` for within-plugin siblings** — the CLI auto-appends a
\`## Neighbors\` section on \`crtr skill show\`. Add a manual \`## Related\`
only for cross-plugin or distant refs.

## 6. Progressive disclosure

If deep reference is needed:

\`\`\`
<skill-dir>/
  SKILL.md          # judgment layer — <150 lines
  reference.md      # lookup layer
  examples.md       # optional worked examples
\`\`\`

SKILL.md *links* to siblings (\`see [reference.md](reference.md)\`). Agent
loads supporting files only when needed.

## 7. Verify

\`\`\`
crtr skill where <name>
crtr skill show <name>
crtr skill search <keyword>
\`\`\`

## Deep-dive reference

For canonical SKILL.md authoring (frontmatter fields, argument passing,
dynamic context, subagent forking, hooks):

\`\`\`
crtr skill show crouter-development/skills
\`\`\`

The playbook above gives you structure + density rules.
\`crouter-development/skills\` covers the SKILL.md surface itself.

## Constraints

- Topic fails litmus? → \`crtr skill template freeform\`, \`reference\`, or \`runbook\`.
- No unconfirmed heuristics — if not from user experience or clear principle,
  leave it out.
`;
}

function freeformTemplatePrompt(topic: string): string {
  return `# Freeform — escape hatch skill

**Audience: future LLM agent sessions.** Use when content doesn't fit
\`primer\` (codebase knowledge) or \`playbook\` (methodology) — glossaries,
decisions, runbooks, lists, preferences.

${topicLine(topic)}

## 1. Pick a shape

What kind of thing is this?

- Terms + definitions → glossary-shaped
- "We decided X, here's why" → decision-shaped
- Procedure with steps + rollback → runbook-shaped
- User preferences → preference-shaped
- None of the above → freeform

No strict template; the shape just tells you what to ask for.

## 2. Interview

\`AskUserQuestion\` (≤4, multi-choice, best-guess first). Get only what you
need to write the skill. **No unconfirmed assumptions** — if not from user
or grep, omit it.

## 3. Scope + name + scaffold

\`\`\`
crtr skill new <name> --type freeform --scope <user|project> --description "<what+when, ≤250 chars, front-loaded triggers>"
\`\`\`

## 4. Body — pick the closest skeleton

**Glossary:**
\`\`\`markdown
# <domain> glossary
| Term | Definition | Notes |
|------|------------|-------|
\`\`\`

**Decision:**
\`\`\`markdown
# <decision> — <date>
## Context
## Decision
## Consequences
## Alternatives considered
\`\`\`

**Runbook:**
\`\`\`markdown
# <procedure>
## When to run
## Steps
## Verification
## Rollback
\`\`\`

**Preference:**
\`\`\`markdown
# <preference>
## Rule
## Why
## How to apply
\`\`\`

Or invent your own. Stay tight — no padding.

## 5. Verify

\`\`\`
crtr skill where <name>
crtr skill show <name>
crtr skill search <keyword>
\`\`\`

## Switch templates if needed

Content actually fits a typed template?

\`\`\`
crtr skill template playbook ${topic ? topic : '<topic>'}     # decide
crtr skill template primer ${topic ? topic : '<topic>'}       # navigate codebase
crtr skill template reference ${topic ? topic : '<topic>'}    # look up stable facts
crtr skill template runbook ${topic ? topic : '<topic>'}      # execute a procedure
\`\`\`
`;
}

function referenceTemplatePrompt(topic: string): string {
  return `# Reference — lookup-fact skill

**Audience: future LLM agent sessions.** Captures *stable lookup facts* an
agent will grep or scan: protocol fields, API surfaces, glossaries, enum
tables, status-code maps. Source of truth lives *outside* the skill (RFC,
spec, vendor docs); the skill is a fast in-repo cache.

${topicLine(topic)}

## Litmus test

> Would you *grep* this rather than *read* it?

If you'd skim end-to-end → it's not reference. If you'd jump straight to
the row you need → reference. If you'd make a decision after reading →
\`crtr skill template playbook\`. If you'd execute steps → \`runbook\`.

**Reference markers:** mostly tables · stable across releases · authoritative
source elsewhere · agent loads to *answer*, not to *think*.

## 1. Confirm reference, not playbook

Use \`AskUserQuestion\` (≤4, multi-choice, best-guess first):

- The lookup the agent will perform (e.g., "what does HTTP 423 mean")
- Stability: does this change every release? If yes, push back — link the
  upstream source instead of mirroring it.
- Authoritative source URL (cite in the body)

Skip if the topic is clearly facts (RFCs, public API). **Never invent
field/flag/code values** — pull verbatim from source.

## 2. Scope + name

- **Scope**: \`user\` for cross-project facts. \`project\` for repo-specific.
- **Name**: noun-phrase. \`http-status-codes\` not \`learn-http-status\`.
- Check \`crtr skill where <name>\`.

## 3. Scaffold

\`\`\`
crtr skill new <name> --type reference --scope <user|project> --description "<what to look up + when to load, ≤250 chars>"
\`\`\`

## 4. Density rules

Reference skills are *load and scan*, not *load and read*. Optimize for jump-to-row.

- Tables for anything multi-row. Columns: most-queried field first.
- One topic per file. Split if it doesn't fit one screen.
- Source URL at the top — agent verifies before trusting cached facts.
- No prose paragraphs longer than 2 lines.
- Skip *why* — playbooks teach why. Reference teaches what.

## 5. Body skeleton

\`\`\`markdown
# <topic> reference

**Source of truth:** <URL or spec name>
**Last verified:** <date — when an agent should re-check>

## <table 1 title>
| <field> | <value> | <notes> |
|---------|---------|---------|
| …       | …       | …       |

## <table 2 title>
…

## Edge cases / gotchas
- Brief bullets. *What* is misleading, not *why*.
\`\`\`

**No \`## Related\` for within-plugin siblings** — auto-appended by the CLI.

## 6. Progressive disclosure

If reference is large, split:

\`\`\`
<skill-dir>/
  SKILL.md           # top-level index + most-queried table
  full-table.md      # the full set
  examples.md        # rarely-needed worked examples
\`\`\`

SKILL.md links to siblings (\`see [full-table.md](full-table.md)\`).

## 7. Verify

\`\`\`
crtr skill where <name>
crtr skill show <name>
crtr skill search <keyword>
\`\`\`

Search must surface the skill on a typical lookup query. Sharpen the
description if it doesn't.

## Constraints

- No invented values. If you can't cite the source, leave the row out.
- Topic teaches *judgment*, not facts? → \`crtr skill template playbook\`.
- Topic is a *procedure*? → \`crtr skill template runbook\`.
- Source updates faster than you'll update the skill? → don't capture; link.
`;
}

function runbookTemplatePrompt(topic: string): string {
  return `# Runbook — procedure skill

**Audience: future LLM agent sessions.** Captures a *procedure* the agent
executes: numbered steps, decision points, verification, rollback. Examples:
deploy, incident response, review workflow, release cut.

${topicLine(topic)}

## Litmus test

> After loading this, does the agent *do steps in order*?

If yes → runbook. If the agent makes a decision and stops → \`playbook\`. If
the agent looks up a value → \`reference\`. If neither fits → \`freeform\`.

**Runbook markers:** numbered steps · ordering matters · has rollback or
verification · maps an outcome to a known sequence.

## 1. Capture the procedure

Use \`AskUserQuestion\` (≤4, multi-choice, best-guess first):

- The trigger (when does the agent run this?)
- Steps in order — explicit, atomic. *"Update X"* is not atomic; *"run
  \\\`pnpm db:migrate\\\` and confirm exit 0"* is.
- Decision points within the sequence (when does the agent branch?)
- Rollback / verification (how to confirm success; how to undo on failure)

Push back on vagueness. *"Deploy to prod"* is a label; *"run \\\`pnpm build\\\`,
push to \\\`main\\\`, wait for green CI, click promote"* is a runbook step.

## 2. Scope + name

- **Scope**: \`project\` for repo-specific procedures. \`user\` for cross-project.
- **Name**: verb-phrase. \`deploy-to-prod\` not \`production-deployment-guide\`.
- Check \`crtr skill where <name>\`.

## 3. Scaffold

\`\`\`
crtr skill new <name> --type runbook --scope <user|project> --description "<when to run + outcome, ≤250 chars, front-loaded trigger>"
\`\`\`

## 4. Density rules

- Steps are commands, not advice. Each step is something the agent can verify.
- Decision points get explicit branches, not "use judgment."
- Verification belongs in-line, after the step that produces the change.
- Rollback is mandatory if the procedure changes prod state.

## 5. Body skeleton

\`\`\`markdown
# <procedure>

## When to run
- <trigger>

## Pre-flight
- [ ] <thing that must be true before starting>

## Steps

1. **<atomic action>** — \\\`<command>\\\`
   Verify: <observation that confirms success>
   If <error condition>: <what to do>

2. **<atomic action>** — …

## Decision points

- After step N, if X then go to step M; else continue.

## Verification (post-flight)
- [ ] <how to confirm the procedure succeeded end-to-end>

## Rollback
1. <reverse-order undo steps with their own verification>
\`\`\`

**No \`## Related\` for within-plugin siblings** — auto-appended by the CLI.

## 6. Verify

\`\`\`
crtr skill where <name>
crtr skill show <name>
crtr skill search <keyword>
\`\`\`

Walk through the runbook mentally. Each step verifiable? Each decision
explicit? Rollback covers the state changes? If any answer is no, fix
before shipping.

## Constraints

- Steps without verification are wishes. Add the verify line or cut the step.
- "Use your judgment at step 4" → either turn step 4 into a playbook
  reference, or write the decision criteria explicitly.
- A procedure that's actually one command isn't a runbook — make it a
  CLAUDE.md note.
`;
}
