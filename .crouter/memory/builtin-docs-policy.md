---
kind: preference
when-and-why-to-read: When you are adding an agent-facing crtr surface, or
  deciding where a piece of crouter documentation belongs, this preference
  should be read because it carries the CTO's standing placement policy.
short-form: "CTO doc policy: authoring guidance goes in -h (forced read);
  builtin memory is for dev-mode/multi-topic docs; docs ship with surface-adding
  changes; everyone can become a contributor."
system-prompt-visibility: preview
file-read-visibility: none
---

# Builtin docs policy — docs are a product surface

Core philosophy (CTO ruling, 2026-06-10): **everyone can become a contributor** — any user's agent should be able to flip from using crtr to extending crouter. Builtin docs (shipped via `src/builtin-memory/`) serve both operational correctness (agents drive the runtime from the canonical model, not scattered guesses) and generativity (agents can build personas, views, plugins, examples). Dev-mode docs absolutely ship builtin too — slightly less surface-level, never hidden at project scope.

## The two doc types

- **User-mode authoring guides** teach an agent to write a good artifact for itself or its user (a memory, a persona, a view). They must NOT explain inner workings — only how to author well.
- **Dev-mode docs** (`internal/`, `examples/`, and optionally deeper-nested *why* dirs) explain how crouter works at a lower level — and why it is built that way — so when a user complains about crouter's behavior or wants it changed, the agent reaches the mechanism fast.

## Placement bar: -h first

Authoring guidance belongs on the **forced path**: the relevant `crtr <command> -h`. The help-gate guarantees the agent reads it at exactly the right moment, and it costs zero ambient context when not needed. A standalone builtin memory doc earns its place only when (a) it is dev-mode material (references/examples), or (b) the content is genuinely multiple topics/files worth — too big for one -h.

## Docs ship with the change — and most changes need none

A change that adds a new agent-facing CLI surface ships its doc updates in the same pass, like tests. But these docs are architectural logic and higher-level abstractions, never file-by-file explanations — brittle docs that need updating on every refactor are wrong. A change that adds no surface almost certainly needs no doc change.
