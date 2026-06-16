---
kind: knowledge
when-and-why-to-read: When shaping a planning roadmap, deciding plan structure,
  or fanning out plan-review specialists before declaring a plan ready, this
  knowledge should be read.
short-form: Use when shaping a planning roadmap, deciding plan structure, or
  fanning out plan-review specialists before declaring a plan ready.
system-prompt-visibility: name
file-read-visibility: none
gate:
  kind:
    imatches: '^plan($|/)'
needs-refinement: true
---

# Planning Playbook

## Plan Shapes and the Decomposition Decision

Every planning effort produces either a flat plan or a decomposed plan (index + part-plans). Choosing the wrong shape wastes a cycle — a flat plan that is too large forces an implementer to hold too much at once; a decomposed plan for something small adds overhead for no gain.

**Use a flat plan** when the work is a single coherent domain, involves fewer than ~6 files, and can be written at consistent task granularity without exceeding roughly 150–200 lines. A flat plan has an overview, ordered phases, and a verification section. No sub-plans. One file.

**Use a decomposed plan** when the change spans multiple domains (e.g., data layer, API surface, UI), involves 6+ files, or would require a master plan that cannot be written at consistent granularity without ballooning. In this case: produce an index plan (the navigable master) and delegate each domain slice to a `plan`-kind child node, giving each child its slice scope, the relevant portion of the spec, and its place in the dependency graph. A slice that itself decomposes further — multiple sub-domains, more than one window's worth of planning — goes to a `plan` sub-orchestrator created directly (`crtr node new --kind plan --mode orchestrator`), not a base child relied on to promote itself. The index plan is the synthesis artifact — it lists all sub-plans by path, defines phases and their dependencies, and contains a task table the implementation orchestrator can execute directly. Detail lives in sub-plans; the master is not allowed to carry it.

**The decomposition trigger is domain boundary, not size alone.** Three backend files and three frontend files are two domains even if the total count is modest — plan them separately and synthesize, because the integration seam is where bugs live and one agent reading both halves won't catch them as cleanly as two agents each going deep.

After collecting part-plans from children, synthesize before declaring done: resolve file ownership conflicts (two sub-plans naming the same file means you decide the sequence), align naming across all parts, fill integration gaps at domain boundaries, and ensure the task table in the index accurately reflects dependencies exposed only by reading all sub-plans together.

## What a Good Task Looks Like

A task is the atomic unit a single implementation node picks up and executes in one context window. Write tasks so that any implementation agent can pick one up cold and know exactly what to do.

A good task has: a file path (or a small list of paths it exclusively owns), an explicit statement of what changes in that file, a list of its hard dependencies (which other tasks must land first), and a clear output — what type, what function signature, what export the next task can assume exists. If a task requires a type defined by a sibling task in the same phase, that dependency is explicit in the task row.

A good task is **parallel-safe**: its files are not owned by another task in the same phase. If two tasks must touch the same file, serialize them across phases and say so. A task that shares files without serialization is a merge conflict waiting to happen.

A good task is **bounded**: an implementation agent should be able to finish it in one context window without needing to re-read the entire plan. If a task description runs longer than a short paragraph, the task is too large — split it.

## Plan-Review Specialist Roster

Before declaring any plan ready for implementation, fan out the following reviewers as `review`-kind child nodes in parallel. Each reviewer checks one lens; running them together catches what no single pass can. Do not proceed to the implementation phase until all reviewer findings are folded back in — deferred findings become implementation bugs.

### Requirements Coverage
**What it checks:** Every requirement and design constraint maps to a concrete plan task; nothing is invented; nothing is missed. Specifically: API routes, data model fields, UI states (loading, empty, error), error handling, and edge cases called out in the spec all have explicit plan tasks.
**Spawn task template:** "Review the plan at `<path>` against requirements `<req-path>` and design `<design-path>`. Check that every requirement and design constraint has a concrete, actionable plan section. Classify each as Covered / Partial / Missing. Flag blocking gaps only."

### Pattern Consistency
**What it checks:** The plan honours the codebase's established architecture, module structure, naming conventions, error-handling utilities, API response shapes, and frontend patterns. Deviations that would confuse an implementer or create inconsistency are flagged.
**Spawn task template:** "Review the plan at `<path>` for pattern consistency against the codebase. Check architecture conventions, naming, error handling, API shapes, and frontend patterns. Read source files in the areas the plan touches; do not review in isolation. Flag deviations that contradict established patterns."

### Code Smells / Design
**What it checks:** Nullability mismatches between plan and data source, type conflicts across sub-plans, hidden N+1 queries, over-fetching, missing error boundaries in batch operations, leaky abstractions that couple unrelated concerns, file-ownership conflicts when multiple sub-plans name the same file.
**Spawn task template:** "Review the plan at `<path>` for design problems: nullability mismatches, N+1 queries, type conflicts between parts, over-fetching, missing error boundaries, leaky abstractions. Read existing code in target areas. Report concrete issues only — no style or speculation."

### Security
**What it checks:** Input validation gaps (missing length limits, type constraints, enum checks), injection surfaces (raw SQL, shell, path traversal), missing auth/authz guards, data exposure in planned responses, and race conditions or TOCTOU bugs in planned state mutations. Only flags risks with a concrete exploit path in the plan.
**Spawn task template:** "Review the plan at `<path>` for security risks. Check input validation, injection surfaces, auth/authz coverage, data exposure, and race conditions. Only flag risks with a concrete exploit path — no theoretical concerns."

### Architecture Fit
**What it checks:** The plan's proposed boundaries — new files, new modules, new abstractions — fit the system's existing decomposition. A new service that duplicates an existing one, a new abstraction layer that cuts across established boundaries, or a module proposed in the wrong layer are all findings.
**Spawn task template:** "Review the plan at `<path>` for architecture fit against the existing system. Check whether proposed file locations, module boundaries, and abstractions align with how the codebase is currently decomposed. Flag new units that duplicate existing ones or violate established layer boundaries."

## Folding Findings Back In

After all reviewers report, collect their findings, triage by severity, and revise the plan before advancing. Critical and High findings must be resolved — either fix the plan or document in the task that the implementer must handle a specific constraint. Medium findings are addressed where straightforward; explicitly carried as a note in the relevant task when they are implementation-time concerns rather than plan-shape concerns. Do not dismiss findings without a reason.

A plan that passes all five lenses with no unresolved Critical or High findings is ready to hand to an implementation orchestrator.
