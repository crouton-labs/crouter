---
kind: knowledge
when-and-why-to-read: When writing or revising a base persona prompt (a
  <kind>/PERSONA.md, the system prompt for a single-window worker node), this
  knowledge should be read.
short-form: How to write a base persona prompt (the mode=base PERSONA.md) — the
  system prompt for a single-window worker node. Covers what a base persona is
  for, what to put in it, the identity/deliverable/boundary/report shape, and
  the voice to use. Use when writing or revising a <kind>/PERSONA.md.
system-prompt-visibility: name
file-read-visibility: none
needs-refinement: true
---

# Writing a base persona prompt

`PERSONA.md` (mode=base) is the system prompt for a **terminal worker** — a node that does one job in one context window and finishes. Its whole purpose is to make a focused specialist that produces a deliverable and reports it. This knowledge doc is the philosophy of what belongs in a base persona; for file mechanics and frontmatter, see `[[crouter-development/personas]]`.

Audience: LLM agents writing a `<kind>/PERSONA.md`.

## What a base persona is for

A base worker **does the work itself and ends.** It is not a manager. The persona points a fresh, capable model at one kind of task and makes it produce the right artifact without supervision. Everything in the body serves that: who it is, what good output looks like, what's out of bounds, and how it hands the result back.

A base persona is a **system prompt**, not a task. Write the durable role — the identity and standards that hold for *every* task of this kind — and let the spawn-time prompt carry the specific task. Never bake one task's details into the persona.

## The four things to put in it

In order. Most base personas are 1–3 short paragraphs total.

1. **Identity — one line, second person.** Open `"You are a <role> agent."` This is a system-prompt identity declaration; `"You are X"` is correct here (it would be wrong in a task prompt). Name the role sharply — "fast codebase exploration agent", "code review agent" — so the model knows which hat it wears.

2. **The deliverable and its shape.** State *what good output is*, not a step-by-step procedure. Name the artifact and its structure: design names its sections, review names its severity tiers, explore demands `file:line` citations. You set the target the model steers toward — describe the target, not a checklist of moves to reach it. Fix the *what*; delegate the *how* to the model's judgment.

3. **The boundaries that keep it in its lane.** One or two constraints that carve this kind out from its neighbors: explore is "read-only — do not modify"; design and plan "do not implement"; developer "throw errors early, no silent fallbacks". These earn their negative framing because the model has a real prior toward crossing the line — a design agent *will* start writing code if you don't fence it off. Keep them to genuine lane boundaries; don't pile on don'ts the model wouldn't trip over anyway.

4. **The report.** Close by stating the deliverable is reported via `crtr push final` — the one runtime rule worth reinforcing in the body, because stopping without it is the most common worker failure. Everything else in the protocol (delegating, the feed, escalating) is already prepended by `runtime-base.md`; do not re-teach it.

## Keep it shallow

A base worker may spawn a helper or two for a targeted sub-task, but most of the work must be its own. If a kind's job routinely needs broad fan-out, it isn't a base worker — it's an orchestrator (`[[crouter-development/personas/orchestrator-prompt]]`). The base persona should make a do-er, not a delegator; say so explicitly when the kind is tempting to over-delegate (developer: "keep the delegation shallow").

## Voice

- **Second person + imperative.** "You are X." "Answer the question." "Do not modify files." Direct instruction for a direct worker.
- **Positive framing for standards.** Describe the output you want, not a list of failures to avoid — "quote concrete `file:line` references" beats "don't be vague".
- **Reserve hard rules.** CAPS / MUST only for the genuine non-negotiable — usually the finish rule and the lane boundary. If everything is critical, nothing is.
- **Density.** This loads as the system prompt on *every* spawn of the kind. No preamble, no fluff — every line is the identity, the deliverable, a boundary, or the report.

## Failure modes

- **Procedure instead of target.** A numbered how-to ages badly and fights the model's judgment. State the deliverable's shape; let it choose the path.
- **Restating runtime-base.** Re-teaching delegation/feed/escalation duplicates the prepended protocol and drifts out of sync. Reference only `push final`, as the deliverable.
- **Task leakage.** Specifics of one task baked into the persona make every future spawn wear yesterday's job. Keep the body to the durable role.
- **No report close.** A base persona that never names `crtr push final` produces workers that go quiet and get re-prompted. Always close on the deliverable.
- **A manager in worker's clothing.** If the body spends more ink on delegation than on doing, you've written an orchestrator — split it.
