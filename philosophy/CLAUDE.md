# philosophy/ — core design principles, and the reasoning behind them

This directory holds the **design philosophy** for crouter: the principles and
mental model that the product is built on, and *why* — written in product/UX and
first-principles terms rather than code.

It is NOT a task tracker, a changelog, or implementation docs. It is the durable
statement of intent that code is measured against. When the code and a philosophy
doc disagree, that gap is a deviation to explain or fix — the principle is the
reference, not a record of current behavior.

Crouter is built **principle-driven**: every directive traces back to a belief
about how agents should work, and those beliefs live here so the *why* is never
lost behind the *what*. See `principle-driven-development/` for that meta-principle.

## What goes here
- Core design principles: the beliefs and mental model the product is built on.
- Product/UX intent: how an interaction should feel and what invariants a reader relies on.
- Reasoning: the *why* behind a design — the tradeoffs and the goal it serves.

## What does NOT go here
- How the code currently works (that's the per-dir `CLAUDE.md` under `src/`).
- Implementation plans, specs, or TODOs (those are crtr nodes / specs).
- Audits of philosophy-vs-reality (write those as findings; link the principle they test).

## Layout
Two shapes live here, each one doc focused on one thing:
- `<area>/philosophy.md` — the philosophy of one internal model or cross-cutting principle.
  - `node-agency/` — the node operating model: each node fully owns its goal,
    chooses its own rigor, and decomposes / cycles / reviews rather than settling.
  - `wakeups/` — what stirs a dormant node: waiting is free, and one inbox channel
    serves both event and time triggers.
  - `self-knowledge/` — an agent understands its own context: how it works, why it
    woke, and what it is doing.
  - `principle-driven-development/` — the meta-principle: build from beliefs, and
    keep distilling those beliefs from real work.
- `ux/<surface>/philosophy.md` — the philosophy of one user-facing surface.
  - `ux/chat-surface/` — the tmux focus/pane experience: how nodes appear,
    hot-swap, and stay live off-screen.

Keep each `philosophy.md` focused on one surface, model, or principle. State
invariants plainly so they can be audited against the code.
