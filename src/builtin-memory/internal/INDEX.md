---
kind: knowledge
when-and-why-to-read: When you hit a question about how the crtr runtime itself works — how nodes and the canvas behave, where state lives on disk, or how the primitives compose into real systems — this index should be read because it routes you to the runtime's own operational documentation, so you act from the canonical model instead of inferring it from command help.
short-form: internal/ is the runtime's self-documentation — operational guides to nodes/canvas and the storage tiers, plus worked example compositions. Open it when you need to understand how crtr works.
system-prompt-visibility: preview
file-read-visibility: none
---

# internal/ — how the crtr runtime works

This directory is the runtime's **self-documentation**: operational references covering how crtr behaves, so any agent operating under it can route to the canonical model rather than reconstruct it from scattered `-h` output. It ships with crtr.

Open this dir whenever a task turns on understanding the runtime itself. Contents:

- **nodes-and-canvas** — the agent-runtime model: nodes on the canvas graph, spawn/delegate, the push/feed spine, lifecycle (mode + lifecycle axes), and revive (manual + daemon auto-revive).
- **storage-tiers** — where every kind of state lives: the three tiers (scope root, per-cwd crouter root, canvas home) and their durability/ownership contracts.
- **examples/** — worked compositions of the primitives into complete systems (the analogue of pi's `examples/` dir), e.g. the iMessage assistant node.

Adjacent, outside this dir: authoring memory documents (kind, rungs, gates, routing line, the asked-to-remember workflow) is owned by `crtr memory write -h` — the authoring guide lives on the help-gate so it surfaces exactly when you write; making a persona (a custom `--kind`) is owned by the builtin **crouter-development/personas** knowledge doc.

The individual files surface at `name` (their titles route; open the one the situation calls for); this index surfaces at `preview` so the dir announces when to come looking.
