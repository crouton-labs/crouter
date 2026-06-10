---
kind: skill
when-and-why-to-read: When you are about to write or update a memory document — including any time the user asks you to remember something — or need to debug why a document is (not) surfacing, this skill should be read because it tells you how to choose kind and scope, set the disclosure rungs and gate, size the body, and when to first ask the user a clarifying question.
short-form: Author excellent memories — kind, scope, visibility rungs, gates, body sizing, and the asked-to-remember workflow.
system-prompt-visibility: preview
file-read-visibility: none
---

# Writing memories

A memory is a markdown document whose frontmatter decides **when, where, and how much** of it loads into future agents. The body is the easy part; the craft is routing — deciding who sees it, at what moment, at what context cost. Every frontmatter choice below is a routing choice.

## When asked to remember something

1. **Write the routing line first.** Before storing anything, try to complete: *"When <circumstance>, this <kind> should be read because <payoff>."* If you cannot name the concrete situation a future agent will be in when this matters, you do not understand the memory yet — ask the user **one sharp question** instead of improvising. "Remember I like chicken" routes cleanly (food/meal decisions); "remember to be careful with the API" does not (which API? careful how? against what failure?) — that one needs clarifying before it becomes a memory. The routing line is a comprehension test.
2. **Find before write.** `crtr memory find <topic>` for an existing doc; update it rather than minting a near-duplicate. Prefer growing `food-preferences` over creating `likes-chicken` — one document per recurring *circumstance*, not one per fact. Group related docs with path names (`area/topic`). Delete memories that turn out wrong.
3. **Capture the why, not just the what.** Especially for corrections: record what was rejected and the reasoning. The why is what lets a future agent apply the rule to cases you never saw.
4. **Don't store what's already recorded** — code structure, git history, CLAUDE.md content — or what only matters to this conversation. If asked to remember something the repo already records, ask what was non-obvious about it and store that instead.

## Choosing kind

- **skill** — how to *do* something (a playbook, a procedure you'd repeat).
- **reference** — what is *true* or how something *works* (a fact about the user, a system's behavior, code docs).
- **preference** — how to *behave* (a directive, a standing correction).

The reference-vs-preference test: does it direct behavior ("always run lint after authoring") or inform the world-model ("Silas likes chicken", "the daemon never reloads dist/")? A correction usually yields a preference; a learned fact yields a reference; a repeatable procedure yields a skill.

Kind sets sensible default rungs — the common case needs no visibility fields at all:

| kind | at boot | on file-read |
|---|---|---|
| skill | name | none |
| preference | preview | none |
| reference | none | preview |

## The two hooks — boot vs file-read

There are exactly two moments a doc can surface. `system-prompt-visibility` governs **boot** (the system prompt); `file-read-visibility` governs **on-read** (when a related file is opened).

- Behavior and procedure (preferences, skills) are relevant regardless of which file is open → surface at boot, stay out of file-read. That is what the defaults do.
- Knowledge about code (references) belongs **next to the code**: put the doc in that directory's `.crouter/memory/` and it fires positionally when files under that directory are read — costing nothing at boot.
- The exception that matters: a reference about a *person or a process* ("Silas's food preferences") has no code directory to anchor to, so positional triggering is meaningless — set `system-prompt-visibility: preview` so its routing line surfaces at boot instead.
- `applies-to: <glob or list>` extends the on-read trigger beyond position for cross-cutting docs (e.g. a testing reference that should fire for `**/*.test.ts` anywhere).

## Choosing the rung

`none → name → preview → content`. Each rung up costs more of **every** future agent's context, paid at every boot or read, forever. Default down, not up.

- **content** (full body injected): reserved for guidance that is BOTH always relevant AND ~one bullet's worth of text. Fail either test → preview. Situational guidance is preview *no matter how short*; long guidance is preview no matter how universal it feels.
- **preview** (the one-sentence routing line): the workhorse. Costs one line; the body is read on demand.
- **name** (title only): catalog-style docs whose name already routes (`api-reference`).
- **none**: invisible except to `crtr memory find` — archival or narrowly specialized material.

`short-form` is NOT a rung and never enters an agent's context (an agent handed a summary satisfices and skips the real read). It is the gist a human sees in `crtr memory list` — write it for them, and don't make it do routing work.

## The routing line

`when-and-why-to-read` is **read-routing, never content**: it answers when to open the doc and why the read pays — never why the content should be obeyed, and never a paraphrase of the content. A preview that gives away the gist defeats the ladder: the agent feels informed and skips the body. Shape: *"When <circumstance the agent is in>, this <kind> should be read because <what the read buys>."* The test: can a stranger mid-task decide from this single line alone whether to spend the read?

## Gates — conditioning on who the agent is

An optional `gate:` predicate makes the doc eligible only for nodes whose own config matches. Subject fields: `kind` (node role, free-form), `mode` (base|orchestrator), `lifecycle` (terminal|resident), `hasManager` (bool), `cwd`, `scope` (user|project), `orchestration.depth` (hops to the root orchestrator; root = 0). Matchers: scalar equality, list membership, or operator objects (`{gte: 2}`, `{in: […]}`, `{matches: "…"}`, `exists`, `contains`…), with `all`/`any`/`not` combinators.

```yaml
gate: { mode: orchestrator }               # only delegating managers
gate: { orchestration.depth: { gte: 2 } }  # only substantial, scaled-up efforts
```

Default is no gate — always eligible; most docs want exactly that. An empty `gate: {}` is inert (never matches) — don't write it. A failing gate hides the doc from both hooks, but it stays findable by search.

## Scope — where the file lives

- **user** (`~/.crouter/memory/`): facts about the user, cross-project behavior. The chicken memory goes here.
- **project** (`<dir>/.crouter/memory/`): anything about a codebase or workspace — and place it in the *specific directory* it describes (any directory can hold a `.crouter/`), so positional on-read fires precisely.
- **builtin**: ships with crtr itself (contributed via `src/builtin-memory/` in the crouter repo) — docs every crtr agent should have.

Resolution is project > user > builtin with leaf-name fallback (`read <leaf>` finds `area/<leaf>` when unambiguous), so a project doc can shadow a same-named user or builtin doc.

## Mechanics worth knowing

- **Directory entries**: a directory may carry an `INDEX.md` with the same frontmatter schema as any doc; the dir then renders as one entry at the INDEX's rung, and that rung is a **ceiling for its subtree** (`none` hides the whole dir). When a doc mysteriously isn't surfacing, check its ancestors' INDEX rungs and its gate.
- **CLI**: `crtr memory list` (human inventory) · `read <name>` (names are path-derived, never file paths) · `find <query>` (search ignores gates and rungs) · `write` (author) · `lint` (validate after authoring). Run `-h` on a leaf before first use.

## Body content

Write for a stranger: a future session that shares none of this conversation. No "as discussed", no narration of how you learned it — state current truth, not the history of getting there. Keep the reasoning behind rules; cut everything else. Don't pad: a preference can legitimately be two sentences, and a skill should lead with decisions, not mechanism. A body behind `preview` may be long when it earns it, but every line still costs a reader who is mid-task — dense beats complete.

## Worked example

User says: *"remember that I like chicken."*

```bash
echo "Silas likes chicken." | crtr memory write food-preferences \
  --kind reference --scope user \
  --when-and-why-to-read "When you are choosing or recommending food, meals, or recipes for Silas, this reference should be read because it records his food preferences." \
  --short-form "Silas's food likes/dislikes" \
  --system-prompt-visibility preview
```

Reference (a fact, not a directive) · user scope (about the person, not a repo) · `preview` at boot (no code directory to anchor on-read) · named for the recurring circumstance, so future food facts append to the same doc. After authoring, validate: `crtr memory lint`.
