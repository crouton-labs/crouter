---
name: content-placement
description: Where crouter content belongs — CLI prompts vs builtin skills vs marketplace plugins vs scope-owned skills. Apply when adding documentation, authoring guides, or any agent-facing content to the crouter ecosystem.
paths:
  - "**/src/prompts/**/*.ts"
  - "**/src/commands/**/*.ts"
  - "**/src/builtin-memory/**/*.md"
---

# Content placement in crouter

Four tiers can hold agent-facing content. Picking the wrong tier wastes effort and confuses the agent — it expects format details from the CLI surface, not from a discoverable skill.

## The four tiers

| Tier | Path | Audience | Loaded when |
|---|---|---|---|
| **CLI prompts** | `src/prompts/`, `--help`, command output | Every crtr user | They run a command |
| **Builtin skills** | `src/builtin-memory/` (kind: skill, surfaced via the memory substrate) | Crouter contributors — plugin/marketplace authors | They run `crtr memory read <name>` |
| **Official-marketplace plugins** | `crouter-official-marketplace` repo | Anyone who installs the plugin | They run `crtr memory read <plugin>/<name>` |
| **Scope-owned skills** | `~/.crouter/skills/`, `<project>/.crouter/skills/` | The user who wrote them | Same as above |

## Decision rules

**CLI prompts** when:
- Every user encounters this by running a normal command (`crtr skill new`, `crtr plugin install`, `crtr --help`).
- The content describes *intrinsic CLI behavior* — exit codes, flag semantics, output format, scaffold conventions.
- An agent should already know it after reading `crtr <thing> --help`.
- Examples: SKILL.md format, template workflows, scope resolution, skill identifier syntax.

**Builtin skill** when:
- The content guides *crouter contributors* (plugin authors, marketplace maintainers) — not every user.
- It's a deeper-dive an agent loads on demand, not foundational behavior.
- It would force `crtr --help` past one screen if inlined.
- Examples: plugin.json schema + scope semantics, marketplace auto-bump CI patterns.

**Marketplace plugin** when:
- The content is *adjacent* to crouter but not about crouter itself.
- Examples: Claude Code artifact authoring (claude-authoring), agent design (llm-app-authoring), prompting (prompting-effectively).

**Scope-owned skill** when:
- The content is *personal* — user preferences, project-specific methodology, decisions you don't want to ship.

## Anti-patterns

- **Format reference as a skill** — if `crtr skill template <type>` already emits per-type guidance, don't ship a duplicate `format-reference` skill. The CLI is the index; drift between the two confuses agents.
- **Workflow procedure as a CLI prompt** — if it's a numbered procedure with rollback (a runbook), it's a skill, not `--help` output.
- **Tool-specific knowledge in builtin** — Claude Code skill format goes in `claude-authoring`, not the crouter binary. The crouter binary teaches crouter.
- **Cross-ref skills from CLI prompts unless they're canonical** — a prompt saying "see `crtr skill show foo`" makes that skill a hard dependency. Inline what's actually needed; reserve cross-refs for genuine deep-dive content.
- **Mixed-audience skills** — a skill that's half consumer-facing (use crtr) and half developer-facing (extend crtr) should split. Audience drives placement; conflating them puts content in the wrong tier.

## When the boundary is fuzzy

Ask: *would a fresh `crtr` install with no plugins/marketplaces let an agent do this?*

- Yes → **CLI prompt**.
- No, but every contributor needs it → **builtin skill**.
- Only some users need it → **marketplace plugin**.
- Only the author needs it → **scope-owned skill**.
