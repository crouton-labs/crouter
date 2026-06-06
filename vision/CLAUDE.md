# vision/ — product description, philosophy, and reasoning

This directory holds the **product vision** for crouter: what the experience is
*supposed* to feel like and *why*, written in product/UX terms rather than code.

It is NOT a task tracker, a changelog, or implementation docs. It is the durable
statement of intent that code is measured against. When the code and a vision doc
disagree, that gap is a deviation to explain or fix — the vision doc is the
reference, not a record of current behavior.

## What goes here
- Product philosophy: the principles and mental model behind a surface.
- UX intent: how an interaction should feel and what invariants the user relies on.
- Reasoning: the *why* behind a design — the tradeoffs and the goal it serves.

## What does NOT go here
- How the code currently works (that's the per-dir `CLAUDE.md` under `src/`).
- Implementation plans, specs, or TODOs (those are crtr nodes / specs).
- Audits of vision-vs-reality (write those as findings; link the vision they test).

## Layout
- `ux/<surface>/vision.md` — the vision for one user-facing surface.
  - `ux/chat-surface/` — the tmux focus/pane experience: how nodes appear,
    hot-swap, and stay live off-screen.
- `<area>/vision.md` — the vision for one internal model (not a user-facing surface).
  - `node-agency/` — the node operating model: each node fully owns its goal,
    chooses its own rigor, and decomposes / cycles / reviews rather than settling.

Keep each `vision.md` focused on one surface or model. State invariants plainly so
they can be audited against the code.
