---
kind: knowledge
when-and-why-to-read: When designing how agents load context — what belongs in a system prompt vs on-demand, how knowledge is stored, scoped, or auto-injected, or when adding any new kind of agent-facing document — this reference should be read because it records the decision and reasoning behind crouter's unified document-substrate, the taste that should govern any change to how agents store and load knowledge.
short-form: Agent guidance — knowledge and preferences — is one substrate of markdown files whose frontmatter dictates when, where, and how much loads. Two semantic-memory kinds, two injection hooks, a four-rung disclosure ladder, per-directory scope.
system-prompt-visibility: name
file-read-visibility: none
---

# The document substrate — one store for all agent knowledge

This is the first artifact of the thing it describes: a reference document in the substrate, explaining why the substrate is shaped the way it is. It is taste, not a spec — the design doc carries the precise shape; this carries the *why* so a later agent makes the same calls for the same reasons.

## The realization

All agent guidance — what we used to call memories, skills, directives, docs, rules, and notes — is the same thing at bottom: a markdown document with frontmatter that dictates **when, where, and how much** of it gets read into an agent. They were never six subsystems. They are one substrate with a kind and a loading policy. The whole design is finding the primitives and the frontmatter that make that one configurable system instead of six parallel ones.

## Two kinds of memory, and only one of them is ours

Knowledge splits first into **episodic** (the record of what happened — the conversation, and any summarization of it) and **semantic** (knowledge held independent of any one episode). Episodic memory belongs to the *system*: it owns conversation storage and any automatic summarization, and an agent does not hand-curate it. This substrate is **semantic memory only**.

Semantic memory has exactly **two** kinds, split on how an agent *uses* the document:

- **knowledge** — anything the agent *consults*: how to do something, how something works, what is true. [was: skills, docs, notes, factual memories — and the procedural/referential line between them, which proved to be about content, not use, and forked no behavior]
- **preference** — how the agent should *behave*: a standing directive, a rule, a correction the agent embodies rather than looks up. [was: directives, rules, behavioral memories]

The load-bearing distinction is **consult vs behave** — it is the only one that changes a default rung, an injection point, or an update rule. The earlier procedural/referential split (skill vs reference) was a distinction in a document's *content*, not in how it is used, so it cost a taxonomy decision and bought nothing; it is folded into `knowledge`.

## Loading is two hooks and a four-rung dial

There are exactly two moments a document can surface into an agent, because there are exactly two injection points: **at boot** (the system prompt / CLI docs) and **on read** (when a related file is read). (The general channel taxonomy these two points sit inside — and the placement reasoning behind them — is [[ai/agent-context/context-placement-channels]]; this doc carries only what is crouter's own design.) Every document independently sets how much of itself surfaces at each, on one monotone ladder:

`none` (invisible; found only by search) → `name` (just its title) → `preview` (the routing line) → `content` (the full body).

Each document sets both rungs **explicitly** — there is no kind-based default, and authoring requires both (enforced by `crtr memory write` on create and by `crtr memory lint`). A default keyed on kind was tried and removed: the right rung is a case-by-case call, never a function of kind, and a default just trains the author to stop thinking. The four rungs read, lowest to highest: `none` for niche docs almost nothing should pull into context; `name` for the common case (uncommon knowledge docs an agent or the user may reach for by name); `preview` for docs important enough that their routing line earns its boot-time token cost every session (preferences usually); `content` for a doc that would be `preview` except its body is already a bullet's worth, so you may as well inline it — rare, and downgraded back to `preview` as it grows.

The **preview** is the document's `when-and-why-to-read` line — one routing sentence, *"When {circumstance}, this {kind} should be read because {payoff}."* — rendered verbatim, never a content paraphrase. That single line is the heart of progressive disclosure: it costs almost nothing in context and tells the agent precisely whether to spend the read.

## Why `short-form` is not a rung — the satisficing rule

A document also carries a `short-form`: an abbreviated version of its content. It is tempting to make that a disclosure rung between preview and content. **It must not be** — agents satisfice on abbreviations (the general failure mode is in [[ai/agent-context/context-placement-channels]], memory-pointers channel). The crouter ruling: `short-form` never enters an agent's context as a loading level. It exists for one purpose: a *human* listing what memories exist (`crtr memory list`) wants the gist of each, not its title alone. Disclosure to an agent is name → preview → the whole thing; there is no "just the summary" rung, by design.

## Conditional loading scales with the work

Visibility is conditioned on the agent's own configuration through an optional `gate` — a predicate (the same matcher pi's frontmatter-rules uses) evaluated against the node's config: kind, mode, orchestration depth, scope, cwd. The default is no gate (always eligible), so the common case stays a flat visibility setting. The power case — *a bigger, scaled-up task looks at more avenues; before a big effort you search more* — falls straight out: `gate: {orchestration.depth: {gte: 2}}` surfaces a document only for substantial orchestration. Loading scaling with the size of the work is not a special mechanism; it is one predicate over node config.

The on-read hook triggers **positionally** by default: a document lives in the `.crouter/memory/` of a directory and fires when a file under that directory is read, with an optional `applies-to` glob for cross-cutting cases. So a code reference lives next to the code it explains, stays out of every boot prompt (`system-prompt: none`), and surfaces its pointer the moment someone touches that code (`file-read: preview`).

## Every directory is a workspace of context

Scope resolves project over user over builtin, and the unit of project scope is **any directory with a `.crouter/`**, not just a repo root. A directory's `.crouter/memory/` dictates the knowledge, behavior, and references of an agent working there. Memory lives where that scope resolver already looks: **user-global at `~/.crouter/memory/`, project at `<dir>/.crouter/memory/`** — out of the canvas home, which now holds only ephemeral per-node memory. Memory joins the workspace, instead of sitting in a machine-global store keyed on the git root.

## Choosing the boot rung — the content bar (human ruling, 2026-06-09)

`content` is reserved for guidance that should be in **every** agent's face regardless of what it is working on — and a content-rung body must be extremely concise and basic: essentially **one bullet point worth of text** that you always want read. The test is two-part — *always relevant* AND *a bullet's worth* — and failing either one means `preview`. A real example of failing the first: "prefer agent-driven over algorithmic" is genuine taste, but it just isn't relevant to most tasks, so inlining it at boot is noise; it routes at `preview`.

Situational guidance — relevant only when doing a certain kind of work — belongs at `preview` no matter how short it is, and anything with longer instructions belongs at `preview` no matter how universal it feels. The routing line is what earns its place at boot; the body is read on demand. Long catalog-style documents whose name already routes well sit at `name`.

And the routing line only works if `when-and-why-to-read` is a **routing statement, not a content paraphrase**: it names the situation the agent is in ("When you are refactoring…") and the payoff of reading ("…because it informs how to perform good refactors"). A reader must be able to decide whether to open the document from that one line alone; restating the document's content there defeats the ladder.

## The hard cut from Agent Skills / `SKILL.md`

crouter's current authoring model is memory docs: `.md` files under `memory/` with substrate frontmatter, read and written through `crtr memory`. Do not reintroduce pi/Claude Agent Skills as a front door for crouter guidance, do not generate `~/.pi/agent/skills/crtr-skills/SKILL.md`, and do not describe `SKILL.md` bundles as the active crouter model. If legacy generated skill bundles exist, crouter should prune its own marker-bearing copies and leave markerless user-owned files alone.

## Raw files are the full-fidelity surface

`crtr memory read` is for loading a memory's body into agent context. The raw markdown file at `path` is the full-fidelity surface for seeing YAML frontmatter and making edits. Follow-up copy should point agents to read the raw file for frontmatter or edits, not present `--frontmatter` as the primary next step.

## The payoff, and the stance

The point of all of this is that an agent can write knowledge and preferences **freely** — as often as a thought is worth keeping — without fear of bloating its context, because it also declares when and how much each should surface. Context stays clean by construction, not by restraint. This is self-improving prompting and progressive disclosure made into storage: the agent keeps learning, and the cost of what it learns is paid only when it is relevant.

This replaces the prior systems outright — a clean cutover, not a back-compatible layer beside them. The old shapes do not survive next to the new one; carrying both would bloat the system and hide which is real. One substrate, one resolver, one CLI.
