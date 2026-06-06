---
name: vision-docs
description: How to write a vision doc in this repo — state the desired end-state (how the system should work and why), never current problems or implementation. Apply when creating or editing any vision/**/*.md.
paths:
  - "**/vision/**/*.md"
---

# Writing vision docs

A vision doc is the durable statement of intent for one surface or model: how it *should* work and *why*. It is the reference the code is measured against, not a record of how the code behaves now.

## The core discipline

**Describe the desired end-state, in the present tense, as the target.** Write how the system *should* work as though it already does — that is the bar the code is held to. Express motivation as the desired principle, never as the present deficiency: do not open with "## The problem", "Today X does Y wrong", or "the gap is…". The reader should come away knowing the intended model, not a catalogue of what is missing.

When code and the vision disagree, that gap is a deviation to fix or explain — but the deviation is written elsewhere, as a finding that links the vision it tests, never inside the vision doc itself.

## What belongs

- **Product philosophy** — the principles and mental model behind the surface.
- **Behavioral / UX intent** — how an interaction should feel and the invariants the reader relies on.
- **Reasoning** — the *why*: the tradeoffs the design serves and the goal behind them.
- **Invariants**, stated plainly and labelled (Invariant A, B, …), so each can be audited against the code.

## What does not belong

- Implementation, code mechanics, file or function names, "how it currently works" — that lives in the per-dir `src/**/CLAUDE.md`.
- Task tracking, changelogs, specs, TODOs, or migration plans.
- Audits of vision-versus-reality — those are findings, written elsewhere.

## Form

- **Positive framing throughout.** "What good feels like" and "Anti-goals (the broken feel)" sections are encouraged: they describe the target experience and its failure modes in experiential terms, not an audit of current code.
- **One vision per surface or model.** Keep it focused; it gets *sharper and shorter* as it matures, never accumulating.
- **No artificial linebreaks inside a paragraph or list item** — one line each, and let the editor soft-wrap.

This rule is the authoring discipline that auto-loads when you edit a vision doc; `vision/CLAUDE.md` is the directory's own index and layout note. They say compatible things — keep them consistent.
