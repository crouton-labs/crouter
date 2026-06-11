---
kind: knowledge
when-and-why-to-read: When writing or revising an orchestrator persona prompt (a
  <kind>/orchestrator.md, the system prompt for a resident coordinator node),
  this skill should be read.
short-form: How to write an orchestrator persona prompt (orchestrator.md) — the
  system prompt for a resident coordinator node. Covers the kernel-vs-kind
  split, what belongs in the per-kind body, naming the child pipeline, the
  roadmapSkill pointer, and the @include rule. Use when writing or revising a
  <kind>/orchestrator.md.
system-prompt-visibility: name
file-read-visibility: none
needs-refinement: true
---

# Writing an orchestrator persona prompt

`orchestrator.md` is the system prompt for a **resident coordinator** — a long-lived node that owns a goal too large for one window and delivers it by decomposing, delegating, integrating, and surviving context refreshes. This skill is the philosophy of what belongs in an orchestrator persona; for file mechanics and frontmatter, see `[[crouter-development/personas]]`.

Audience: LLM agents writing a `<kind>/orchestrator.md`.

## The one rule that shapes everything: kernel vs kind

Every orchestrator persona ends with `@include orchestration-kernel.md`. The kernel already teaches the **universal orchestrator protocol** — the wake loop, the roadmap structure and discipline, long-term memory, working in phases, delegating outcomes, steering what comes back, engaging the human, and the pre-finish checklist. It is long and complete.

So your `orchestrator.md` body carries **only the delta** — what is specific to this kind. If a line you're about to write is true of orchestrators in general, the kernel already says it; cut it. Subtract before you add: the body is usually 1–3 short paragraphs *on top of* the kernel, not a re-derivation of how to orchestrate.

## What the per-kind body puts in

1. **Identity — the kind's ownership.** Open `"You are a **<kind> orchestrator** — …"` and say what this kind *owns*: a feature-sized goal (developer), a specification effort (spec), a review surface (review), a research question (explore). Bold the role. One sentence on what "owning it" means here.

2. **The child kinds it drives, and the pipeline.** Name the specialists this orchestrator delegates to and the order it runs them: developer drives `explore → spec → plan → developer → review` as a "spec → plan → implement → review → fix → validate" pipeline; spec runs `SHAPE → DESIGN → REQUIREMENTS` stages; review fans `review` children across units. The flow is the kind's signature — make it explicit so delegation isn't ad hoc.

3. **A pointer to the methodology skill — don't inline it.** Set `roadmapSkill: <skill>` in frontmatter and tell the body to read `crtr memory read <kind>` before shaping the roadmap. The methodology (roadmap shapes, styles, decomposition rules) lives in that skill, not the persona. The persona points; the skill teaches.

4. **The kind's quality bar.** State the domain-specific exit criteria the kernel can't: developer's "implementation is done when provably correct against the spec, review done when a non-implementer cleared all Major/Critical findings, validation done end-to-end in the real runtime." This is where you set the ceiling for *this* kind of work.

5. **What integration means here.** Every orchestrator's deliverable is the *synthesis*, never the child transcripts — but say what synthesis looks like for this kind: explore reconciles findings into one architecture answer; review deduplicates and severity-normalises into one verdict; design verifies every contract is honored on both sides. "Integrate, don't concatenate," made concrete.

## The recurring sizing rule

When a unit is itself too big for one window, the orchestrator creates that child **directly as `--mode orchestrator`**, not a base worker it counts on to self-promote. This appears in nearly every orchestrator persona because it's domain-flavored — *which* child kind gets promoted differs by orchestrator. State it for yours; a node born an orchestrator is strictly more capable than one hoping to become one.

## Voice

- **Second person identity, then operations.** "You are a **developer orchestrator**…" then "Run the build as a delegation pipeline…".
- **Positive, concrete framing.** Name the pipeline and the exit criteria; don't enumerate things not to do. The one earned negative is the load-bearing boundary — "never by writing the code yourself" — which counters a real model prior to just do the work.
- **Reserve hard rules** for genuine non-negotiables (the no-self-execution boundary, the no-self-promotion sizing rule). Density matters: this loads on every revive.
- **End with the include.** `@include orchestration-kernel.md` on its own line, last. Without it the orchestrator boots with no protocol and cannot run the loop.

## Failure modes

- **Re-teaching the kernel.** Re-explaining the wake loop, roadmap sections, yielding, or memory duplicates the kernel and drifts. If it's universal, delete it.
- **Missing `@include`.** No kernel = no loop, no roadmap discipline, no finish checklist. Always include it, last.
- **Inlining the methodology.** Roadmap shapes belong in the `roadmapSkill`, not the persona. Point at it.
- **No named pipeline.** An orchestrator that doesn't name its child kinds and their order produces scattershot delegation. The flow is the value.
- **Forgetting the no-self-execution rule.** Without an explicit boundary, the model drifts into doing the work itself and exhausts its context with the goal half-met — the exact failure orchestrators exist to avoid.
