---
name: spec
type: playbook
description: Use when running a specification effort, shaping a spec roadmap, or deciding how to stage design and requirements work. Covers the three-stage shape→design→requirements methodology, when to delegate design to a child node, the isolation principle behind the design/requirements split, and what a finished spec contains.
---

## The Three Stages

A specification effort runs in exactly this order: **SHAPE** → **DESIGN** → **REQUIREMENTS**. Do not collapse them, skip ahead, or run them in parallel. Each stage has a gate; the next stage starts only when that gate is met.

### Stage 1 — Shape

Shape is the only stage that is genuinely interactive. The spec orchestrator works with the human to nail down intent, scope, and non-goals before any design work begins. The deliverable is not an artifact — it is a shared mental model sufficient to write a sharp design brief.

Run an inquiry loop: name the most important ambiguity, form a provisional take, offer 2–4 concrete options, get a decision. Track these turns carefully. The shape stage is done when: (1) 3–7 named components or functional areas are identified, (2) the user's intent can be restated without correction, and (3) no unresolved contradictions remain between the user's goal and the existing codebase. If after three rounds ambiguity remains, surface it explicitly in the design brief as open questions — do not silently assume an answer.

Gate: human confirms readiness to proceed to design.

### Stage 2 — Design

Design produces the blueprint: components and their topology, end-to-end flows, files and directories affected, locked decisions, and open questions resolved. The altitude is infra/services — no function signatures, no algorithm descriptions, no implementation ordering. Design answers "what shape does this take?" — planning answers "how is it built?"

Small or simple design work (one surface, clear scope, few components) can be done by a single `design`-kind child node. Large or complex design work — multi-surface features, multiple interacting subsystems, significant architectural choices — must be delegated to a **design orchestrator** (a `design`-kind node created directly with `--mode orchestrator`), which decomposes the design internally and returns a finished artifact. The trigger for spawning a design orchestrator rather than a base design node: if the design effort has more than one distinct phase or more than ~5 interacting components, use an orchestrator.

Gate: human approves the rendered design artifact.

### Stage 3 — Requirements

Requirements are derived from the finished, approved design. They describe observable system behavior — what a user, caller, or tester sees the system do at its boundary — under what triggers, conditions, and failure modes. Each requirement is written in EARS format (WHEN/WHILE/IF/WHERE + SHALL). Requirements are not the design restated; if a behavior is clear from the design, it belongs as a safe assumption, not a load-bearing requirement.

Delegate requirements writing to a terminal `spec` agent (base lifecycle). Pass it the rendered design text only. Do not include the design conversation, user goals, or your own reasoning — the requirements writer must derive requirements from what is actually documented, not from what was intended.

Gate: human reviews and approves all load-bearing requirements; no `rejected` or unresolved `draft` items remain.

---

## The Design/Requirements Split — Why Isolation Matters

Requirements written by the same context that argued out the design carry that context's blind spots. If the design left a behavior ambiguous and the design author filled it in mentally, requirements derived from that same mental state will encode the assumption without surfacing it for review. Written by a fresh context against the rendered design document alone, ambiguous points surface as gaps in `agentNotes` rather than silently-inherited assumptions.

The isolation is structural, not stylistic. The requirements writer receives: the rendered design text and an output path. Nothing else. No user goal, no exploration findings, no conversation history. If something the user "intended" is not written in the design, it does not appear in the requirements — and that absence becomes visible, which is the desired outcome.

---

## The Yield-Between-Runs Rule

After the design is approved, the spec orchestrator runs `crtr node yield` before starting requirements work. This is mandatory, not optional.

Why: the design conversation fills context with reasoning about tradeoffs, rejected alternatives, and design intent. That context biases delegation — it causes the orchestrator to frame the requirements task with assumptions from the design discussion. After yielding, the orchestrator revives fresh against `context/roadmap.md`, which records the finished design artifact path. It reads the design artifact cold and delegates the requirements work from that clean window, anchored on the rendered design rather than on the design conversation.

The roadmap must record the design artifact path and the current stage before yielding. On revive, the first action is to read `context/roadmap.md`, confirm the design is landed, and delegate requirements work.

---

## Roadmap Shape for a Spec Effort

When shaping the roadmap at the start, structure it as follows. The goal section states what is being specified and for whom. Scope assumptions record what is in scope and what is not — a non-goal stated here propagates to every child without restating it. `## Strategy / phases` holds exactly three phases: Shape (gate: human sign-off), Design (gate: design artifact approved), Requirements (gate: all requirements approved). The current phase carries a one-line status of where it stands; completed phases are deleted, not summarized.

After yield-and-revive, `## Strategy / phases` plus `## Active context` must let the fresh orchestrator orient in one pass without reading any child reports: the current phase's status line names what's in flight and which gate it's waiting on, and `## Active context` lists the design artifact and any other live context-file paths. Human-confirmed decisions and design detail fold into those context files, not the roadmap.

---

## Delegating Design: Base Node vs. Orchestrator

Spawn a base `design` node (terminal) when: the design surface is bounded, one component or subsystem, no multi-phase structure required. The node produces `context/design.md` and `context/design.json` and returns.

Spawn a `design` orchestrator (resident) when: the feature spans multiple subsystems, has distinct implementation phases that need separate design treatment, or the design effort is itself likely to fill one context window before it's finished. Create it directly as an orchestrator — `crtr node new --kind design --mode orchestrator` — rather than spawning a base design node and counting on it to promote itself once it discovers the surface is too big; self-promotion is unreliable, and a node born an orchestrator is strictly more capable than one hoping to become one. Pass it the shape brief as its goal; it owns the decomposition and integration internally and reports a finished design artifact when done.

In either case, the spec orchestrator waits for the design to land and the human to approve it before proceeding.

---

## What a Finished Spec Contains

A finished spec is precise enough that a planner can produce an implementation task breakdown without guessing intent. It contains:

- **Behavior** — what the system does at its external boundary, organized by functional area, written in EARS format.
- **Non-goals** — what is explicitly out of scope, so planners and implementers don't expand into it.
- **Interfaces / inputs / outputs** — the data shapes and interaction contracts (at semantic-type level, not TypeScript declarations).
- **Edge cases** — the failure modes, boundary conditions, and unusual states that must be handled, surfaced explicitly rather than left to the implementer to discover.
- **Acceptance criteria** — per-requirement, testable conditions: "given input X, observe output Y" or "given state X, observe behavior Y."

A spec that requires the reader to infer intent, assume behavior, or resolve design questions is not finished. If those gaps remain at the end of Stage 3, surface them explicitly as open questions before pushing final.
