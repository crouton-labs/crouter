---
kind: knowledge
when-and-why-to-read: When shaping a design roadmap or producing an
  architecture/interface design, this skill should be read.
short-form: Use when shaping a design roadmap or producing an
  architecture/interface design — covers what a design deliverable is, the
  design-artifact shape, when to go top-down vs bottom-up, and how to decompose
  a large design into composable sub-designs.
system-prompt-visibility: name
file-read-visibility: none
needs-refinement: true
---

## What a design deliverable is — and is not

A design fixes the load-bearing structure before anyone writes code: component boundaries and responsibilities, interface contracts and data models, key flows, and the decisions that close real options with their rationale and rejected alternatives. It answers "what shape does this thing take and why?" with enough precision that a planner can decompose it into tasks without guessing, and an implementer can build against it without re-designing.

A design is NOT requirements — those are testable acceptance criteria that say what the system must do; the design says how it is structured to do it. A design is NOT a task plan — plans break work into ordered implementation steps; the design is the shape that plans execute against. Stay above implementation: no function bodies, no algorithm walkthroughs, no library calls, no ordering of implementation steps. If something could be copied into source code, it belongs in the plan, not the design.

The altitude ceiling: a design stops where implementation detail begins. A planner reading the design should have no design questions left; a coder reading it should still have to make implementation choices.

## The design-artifact shape

Write the design to `context/design-<subject>.md`. Structure it with these sections, in order:

**Context & constraints** — the problem being solved, the non-goals, the constraints that are not negotiable (existing systems, performance envelopes, team conventions). This is the frame everything else hangs on.

**Architecture** — the high-level structure: what major components or layers exist, how they are arranged, what the topology looks like. Lead with a diagram (mermaid `graph TD`, 3–6 nodes) before prose. Keep it at the level a new engineer would use to orient themselves.

**Components & responsibilities** — for each component: one-sentence description of what it owns, a responsibilities table, and explicit boundaries (what it does NOT own). Every responsibility must land in exactly one component; gaps and overlaps here become integration bugs.

**Interfaces & contracts** — how components talk to each other. Expressed as prose or sequence diagrams, not API specs or type declarations. "Component A sends X to Component B when Y" is the right level. Include error cases and who owns recovery.

**Data model** — the key entities, their fields with semantic types ("session ID string", "ISO timestamp"), and their relationships. Tables are the right format. No TypeScript, no SQL — shape and semantics only.

**Key flows** — the 2–4 end-to-end flows that matter most. Walk from trigger to final state, naming which component handles each step and what state changes. This is where seam problems surface; a step whose output doesn't match the next step's expected input is a design gap.

**Decisions** — every non-obvious architectural choice, structured as: decision → choice made → alternatives rejected → rationale. If the decision is obvious, omit it. If it closes a real option, it belongs here. This section is what distinguishes a design from a description.

**Open risks** — unresolved questions and known unknowns that a reviewer or the implementer will need to address. Not a wish list — only things that could affect the design's validity.

## Design styles — when to use each

**Top-down, interface-first**: fix the contracts between components first, then fill in what sits behind each contract. Use this when the integration surface is the hard problem — when multiple teams or systems must connect, when the seams will be expensive to change, or when you are designing an API or protocol. The contract is the design; the implementation fills in around it.

**Bottom-up, primitives-first**: identify and nail the core data structures or algorithms that the design depends on, then build the component model up from them. Use this when the primitives are the hard part — a novel data model, a performance-critical kernel, a constraint that flows upward and determines everything else.

**How much to design up-front**: design enough to unblock parallelism and close the decisions that are expensive to reverse. Don't design what the implementer can decide without risk. A design that specifies too much is as harmful as one that specifies too little — over-specification creates brittleness and deferred rework when reality doesn't match. If a sub-section of the design is genuinely unclear but not on the critical path, name it as open rather than filling it with plausible guesses.

## Decomposing a large design

When a design is too large for one context window or covers genuinely independent surfaces, decompose it along clean seams — by component, by subsystem, or by interaction surface. Each sub-design is a bounded unit: it covers one component or subsystem end-to-end (its own context, architecture, interfaces, data model, flows, and decisions).

Before delegating sub-designs, define the shared interface contracts between them explicitly. These contracts are the seams; they must be written down before sub-design begins so that parallel sub-designs don't invent incompatible assumptions. Capture these contracts in a `context/design-contracts.md` that all sub-design agents receive.

Each sub-design agent gets: the overall architecture diagram, the contracts doc, the scope of its piece, and any constraints from the parent design. It writes to `context/design-<component>.md`.

After sub-designs land, integration is your job: read every sub-design, check that every contract is honored on both sides, that responsibilities don't overlap or gap, that the data models are consistent, and that the key flows compose correctly across component boundaries. Write the integrated design to `context/design-<subject>.md` synthesizing all sub-designs into one coherent artifact — don't just concatenate them. Reconcile any inconsistencies before declaring the design done.
