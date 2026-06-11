---
kind: reference
when-and-why-to-read: When you are about to design, defend, or change anything about how crouter's document substrate behaves — what loads when, the frontmatter contract, the disclosure rungs, or how agents store knowledge — this index should be read because it tells you the taste/ dir holds the CTO's standing rulings on those calls, so you make the decision the way it was already decided rather than re-litigating it.
short-form: taste/ holds the durable design rulings (the "why") behind crouter's document substrate — open it before changing substrate behavior so a past decision isn't re-made differently.
system-prompt-visibility: preview
file-read-visibility: none
---

# taste/ — standing design rulings for the substrate

This directory holds **taste references**: durable records of *why* the substrate is shaped the way it is, captured at the moment a decision was made so a later agent makes the same call for the same reason instead of re-deciding it. They are not specs (the design doc carries the precise shape) and not how-tos (`internal/` covers operation) — they are the reasoning the CTO wants preserved.

Open this dir when a task touches **how agent knowledge loads or is authored**: the frontmatter contract, the four-rung disclosure ladder, what earns a boot rung, the meaning of the routing line, or any proposal that would add a parallel mechanism beside the one substrate.

Contents:

- **document-substrate** — the foundational ruling: all agent guidance is one substrate of markdown files whose frontmatter dictates when/where/how much loads; three kinds, two hooks, four rungs, per-directory scope, and the content-bar for boot rungs.
- **why-field-means-why-to-read** — the ruling that the routing line's `when-and-why-to-read` is for *read-routing* (the payoff of opening), never for justifying the content.
- **surface-parity** — the ruling that a change in a node's attached TUI owes the crouter-web operator view too (near-parity), and often a friendlier studio-view treatment, because all three are views of the one broker host.
- **broker-is-the-host** — the headless broker is the one host; tmux panes and the web UI are all just attached views of it. Shipped as a hard cut (the in-pane path is deleted; `--headless` flag gone) — carries the load-bearing one-writer-per-`.jsonl` invariant.
- **inline-ui-placement** — first principles for where crtr TUI content belongs (bottom is now / top is history, locality, inline-by-default, terse self-clearing feedback); the attach viewer is the reference surface governing web too.

Individual taste files surface at `name` only — their titles route, and you open the one the situation calls for. This index surfaces at `preview` so the dir announces when to come looking.
