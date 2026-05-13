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
crtr skill create [topic...]       # pick a template type
crtr skill template <type> [topic] # workflow + skeleton for that type
crtr skill new <name>              # bare scaffold, scope-direct
\`\`\`

Don't load \`create\` and \`template\` in the same turn — \`create\` decides the
type, then call \`template\`.

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

- \`primer\` — codebase/architectural knowledge ("how does X work, why, what
  are the gotchas"). Triggers parallel-explore research.
- \`playbook\` — methodology/judgment ("how to think about X"). The
  \`authoring:skills\`-style skill that teaches decisions, not facts.
- \`freeform\` — anything else (glossary, decision record, runbook, prefs).

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
`;
}

export function skillTemplatePrompt(type: string, topic: string): string {
  const t = type.toLowerCase();
  if (t === 'primer') return primerTemplatePrompt(topic);
  if (t === 'playbook') return playbookTemplatePrompt(topic);
  if (t === 'freeform') return freeformTemplatePrompt(topic);
  return `unknown template type: ${type}\nvalid: primer | playbook | freeform\nrun \`crtr skill create\` to pick.\n`;
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
crtr skill new <name> --scope project --description "<what+when, ≤250 chars, front-loaded triggers>"
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

## Related
- \`<other-skill>\` — interaction
\`\`\`

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
before writing. Update related skills' \`## Related\` sections.
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
crtr skill new <name> --scope <user|project> --description "<what it teaches + when to load, ≤250 chars, front-loaded triggers>"
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

## Related
- \`<other-skill>\` — interaction
\`\`\`

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
crtr skill show authoring-skills
\`\`\`

The playbook above gives you structure + density rules. \`authoring-skills\`
covers the SKILL.md surface itself.

## Constraints

- Topic fails litmus? → \`crtr skill template freeform\` or \`primer\`.
- No unconfirmed heuristics — if not from user experience or clear principle,
  leave it out.
- Update related skills' \`## Related\` if interactions exist.
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
crtr skill new <name> --scope <user|project> --description "<what+when, ≤250 chars, front-loaded triggers>"
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

If the content is actually methodology or codebase knowledge:

\`\`\`
crtr skill template playbook ${topic ? topic : '<topic>'}
crtr skill template primer ${topic ? topic : '<topic>'}
\`\`\`
`;
}
