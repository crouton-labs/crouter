---
kind: reference
when-and-why-to-read: When designing how agents load context — what belongs in a system prompt vs on-demand, how knowledge is stored, scoped, or auto-injected, or when adding any new kind of agent-facing document — this reference should be read because it records the decision and reasoning behind crouter's unified document-substrate, the taste that should govern any change to how agents store and load knowledge.
short-form: Agent guidance — skills, preferences, references — is one substrate of markdown files whose frontmatter dictates when, where, and how much loads. Three semantic-memory kinds, two injection hooks, a four-rung disclosure ladder, per-directory scope.
system-prompt-visibility: name
file-read-visibility: none
---

# The document substrate — one store for all agent knowledge

This is the first artifact of the thing it describes: a reference document in the substrate, explaining why the substrate is shaped the way it is. It is taste, not a spec — the design doc carries the precise shape; this carries the *why* so a later agent makes the same calls for the same reasons.

## The realization

All agent guidance — what we used to call memories, skills, directives, docs, rules, and notes — is the same thing at bottom: a markdown document with frontmatter that dictates **when, where, and how much** of it gets read into an agent. They were never six subsystems. They are one substrate with a kind and a loading policy. The whole design is finding the primitives and the frontmatter that make that one configurable system instead of six parallel ones.

## Two kinds of memory, and only one of them is ours

Knowledge splits first into **episodic** (the record of what happened — the conversation, and any summarization of it) and **semantic** (knowledge held independent of any one episode). Episodic memory belongs to the *system*: it owns conversation storage and any automatic summarization, and an agent does not hand-curate it. This substrate is **semantic memory only**.

Semantic memory has exactly three kinds, and every old type maps cleanly onto one:

- **skill** — procedural: how to *do* something (a playbook, a sales motion). [was: skills]
- **reference** — referential: how something *works* or what is *true* (code docs, an org chart, a factual matter, a CLAUDE.md). [was: docs, notes, factual memories]
- **preference** — preferential: how the agent should *behave* (a directive, a rule, feedback). [was: directives, rules, behavioral memories]

Three kinds is not a simplification we settled for — it is the actual decomposition of semantic memory, and the fact that all six prior types fall onto it without remainder is the evidence it is right.

## Loading is two hooks and a four-rung dial

There are exactly two moments a document can surface into an agent, because there are exactly two injection points: **at boot** (the system prompt / CLI docs) and **on read** (when a related file is read). Every document independently sets how much of itself surfaces at each, on one monotone ladder:

`none` (invisible; found only by search) → `name` (just its title) → `preview` (the routing line) → `content` (the full body).

The **preview** is generated, never hand-written: *"{when}, read this {kind}. {why}."* — composed from the `when` and `why` frontmatter. That single line is the heart of progressive disclosure: it costs almost nothing in context and tells the agent precisely whether to spend the read.

## Why `short-form` is not a rung — the satisficing rule

A document also carries a `short-form`: an abbreviated version of its content. It is tempting to make that a disclosure rung between preview and content. **It must not be.** An agent handed an abbreviation always believes it now has enough and never reads the rest — it satisfices, every time. An abbreviation in the context window is therefore worse than none: it quietly suppresses the full read. So `short-form` never enters an agent's context as a loading level. It exists for one purpose: a *human* listing what memories exist (`crtr memory list`) wants the gist of each, not its title alone. Disclosure to an agent is name → preview → the whole thing; there is no "just the summary" rung, by design.

## Conditional loading scales with the work

Visibility is conditioned on the agent's own configuration through an optional `gate` — a predicate (the same matcher pi's frontmatter-rules uses) evaluated against the node's config: kind, mode, orchestration depth, scope, cwd. The default is no gate (always eligible), so the common case stays a flat visibility setting. The power case — *a bigger, scaled-up task looks at more avenues; before a big effort you search more* — falls straight out: `gate: {orchestration.depth: {gte: 2}}` surfaces a document only for substantial orchestration. Loading scaling with the size of the work is not a special mechanism; it is one predicate over node config.

The on-read hook triggers **positionally** by default: a document lives in the `.crouter/memory/` of a directory and fires when a file under that directory is read, with an optional `applies-to` glob for cross-cutting cases. So a code reference lives next to the code it explains, stays out of every boot prompt (`system-prompt: none`), and surfaces its pointer the moment someone touches that code (`file-read: preview`).

## Every directory is a workspace of context

Scope resolves the way skills and personas already do — project over user over builtin — but the unit of project scope is **any directory with a `.crouter/`**, not just a repo root. A directory's `.crouter/memory/` dictates the knowledge, behavior, and references of an agent working there. Memory lives where that scope resolver already looks: **user-global at `~/.crouter/memory/`, project at `<dir>/.crouter/memory/`** — out of the canvas home, which now holds only ephemeral per-node memory. Memory joins the workspace, instead of sitting in a machine-global store keyed on the git root.

## Choosing the boot rung — the content bar (human ruling, 2026-06-09)

`content` is reserved for guidance that should be in **every** agent's face regardless of what it is working on — and a content-rung body must be extremely concise and basic: essentially **one bullet point worth of text** that you always want read. The test is two-part — *always relevant* AND *a bullet's worth* — and failing either one means `preview`. A real example of failing the first: "prefer agent-driven over algorithmic" is genuine taste, but it just isn't relevant to most tasks, so inlining it at boot is noise; it routes at `preview`.

Situational guidance — relevant only when doing a certain kind of work — belongs at `preview` no matter how short it is, and anything with longer instructions belongs at `preview` no matter how universal it feels. The routing line is what earns its place at boot; the body is read on demand. Long catalog-style documents whose name already routes well sit at `name`.

And the routing line only works if `when`/`why` are **routing statements, not content paraphrases**: `when` names the situation the agent is in ("When you are refactoring…"), `why` names the payoff of reading ("…because it informs how to perform good refactors"). A reader must be able to decide whether to open the document from that one line alone; restating the document's content there defeats the ladder.

## The payoff, and the stance

The point of all of this is that an agent can write skills, references, and preferences **freely** — as often as a thought is worth keeping — without fear of bloating its context, because it also declares when and how much each should surface. Context stays clean by construction, not by restraint. This is self-improving prompting and progressive disclosure made into storage: the agent keeps learning, and the cost of what it learns is paid only when it is relevant.

This replaces the prior systems outright — a clean cutover, not a back-compatible layer beside them. The old shapes do not survive next to the new one; carrying both would bloat the system and hide which is real. One substrate, one resolver, one CLI.
