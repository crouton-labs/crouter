---
name: crouter-development/personas
type: playbook
description: How to define a custom node kind (persona) for crtr — base/orchestrator files, the frontmatter contract, scope resolution and overrides, and how to write the prose. Use when adding a new `--kind`, overriding a builtin agent, or debugging persona resolution.
keywords: [persona, node kind, --kind, orchestrator, base, system prompt]
---

# Authoring crtr personas (custom node kinds)

A **persona** is what `--kind` resolves to: the markdown that becomes a node's system prompt plus the launch knobs (model/tools/extensions/lifecycle). Defining one adds a new spawnable agent type to the canvas.

Audience: LLM agents creating or overriding a crtr node kind.

## When to add a kind (vs reuse a builtin)

Builtins cover the common shapes: `explore spec design plan developer review general`.

- **Reuse a builtin** when the work fits one. Don't fork `developer` to tweak one sentence.
- **Add a kind** for a recurring specialist with its own deliverable + reporting contract that no builtin matches — e.g. `researcher`, `migration`, `release`.
- **Override a builtin** by creating a same-named dir at user/project scope — it *shadows* the builtin (precedence below), it doesn't edit the shipped file.

Never edit `src/builtin-personas/` for a local need — that ships to everyone. Override at scope instead.

## Layout

```
<root>/personas/
├── <kind>/
│   ├── base.md               # worker persona (mode=base)
│   └── orchestrator.md       # orchestrator persona (mode=orchestrator) — optional
├── orchestration-kernel.md   # shared; @include-d by orchestrator files
└── runtime-base.md           # shared; prepended to EVERY persona automatically
```

A kind exists once `<kind>/` holds a `base.md` **or** `orchestrator.md`. `crtr node new --kind <x>` validates against the discovered set and errors with the valid list — your fast existence check.

## Scope + precedence

Resolution is **project > user > builtin**, resolved per file:

| Scope | Path |
|---|---|
| project | `<project>/.crouter/personas/<kind>/` — checked into the repo |
| user | `~/.crouter/personas/<kind>/` — personal, all your projects |
| builtin | ships with the CLI |

Personas are **scope-root content, not plugin content** — they don't ship via plugins or marketplaces (the loader only searches `<scope>/personas/`). To share a kind, commit it to a repo's `.crouter/personas/` (project) or copy it into `~/.crouter/personas/` (user).

## The two files

**`base.md`** — the worker. Second person. State scope → method → deliverable, and end by reporting via `crtr push final`. Default lifecycle `terminal` (finishes in one window). → how to write one: `[[crouter-development/personas/base-prompt]]`.

**`orchestrator.md`** — the owner that delegates to children and never does the work itself. Name the child kinds it drives and set per-phase exit criteria. **Must end with `@include orchestration-kernel.md`** — the loader inlines it; without it the orchestrator boots with no fan-out protocol. Default lifecycle `resident`. → how to write one: `[[crouter-development/personas/orchestrator-prompt]]`.

If a kind has only `base.md`, `--mode orchestrator` composes `base.md body + kernel` and forces `resident` — so write `orchestrator.md` only when the worker and owner prose genuinely differ.

## Frontmatter contract

YAML frontmatter on either file supplies launch knobs; the body is the system prompt.

| Field | Type | Effect |
|---|---|---|
| `lifecycle` | `terminal`\|`resident` | terminal = finishes + reaps; resident = interactive/long-lived. Defaults: base→terminal, orchestrator→resident. |
| `model` | string | pi model override (normalized). Omit to inherit the default. |
| `tools` | string[] | pi tool allowlist. Omit for all tools. |
| `extensions` | string[] | pi extensions, **added after** the always-on canvas extensions. |
| `skills` | string[] | skills attached at launch. |
| `roadmapSkill` | string | orchestrator only — a skill whose body is injected as roadmap-shaping guidance when the node runs as an orchestrator. |

`resolve()` never throws: a missing/empty persona falls back to `"You are a <kind> agent…"` defaults, so a node always boots. `runtime-base.md` (the push/finish/delegate/feed/ask protocol) is prepended to every persona — **don't restate it in the body.**

## @include

`@include <filename>` inlines another persona-root file, resolved through the same project>user>builtin chain. Used for `orchestration-kernel.md`; drop an `orchestration-kernel.md` at user/project scope to change orchestrator protocol fleet-wide.

## Dev loop

```bash
mkdir -p ~/.crouter/personas/researcher
$EDITOR ~/.crouter/personas/researcher/base.md         # frontmatter + prose
crtr node new --kind researcher "map the auth flow"    # spawn; a bad --kind prints the valid kinds
```

No scaffold command — create the dir + files by hand. Copy a builtin (`explore/base.md`, `developer/orchestrator.md`) as a starting template.

## Failure modes

- **Orchestrator with no `@include orchestration-kernel.md`** — boots without the fan-out protocol; can't delegate. Always include it.
- **Restating runtime-base** — the push/finish/delegate protocol is already prepended. Duplicating it wastes context and drifts out of sync.
- **`lifecycle: resident` on a worker `base.md`** — the node never finishes. Reserve `resident` for interactive/long-lived kinds.
- **Editing `src/builtin-personas/` for a local need** — ships to everyone. Override at user/project scope.
- **Kind not listed after creating the dir** — neither `base.md` nor `orchestrator.md` is present, or the filename is wrong. The dir alone doesn't register a kind.

## Related

`[[crouter-development/plugins]]` packages *skills* for distribution — personas are distributed differently (committed to a scope's `personas/`), so a kind is never part of a plugin.
