---
name: crouter-development/skills
type: playbook
description: How to author a crtr skill — SKILL.md format, frontmatter, naming, nested skills, template types. Use when creating a new skill (plugin-owned or scope-owned) or auditing an existing one.
keywords: [skill, SKILL.md, frontmatter, authoring, template]
---

# Authoring crtr skills

A **skill** is a directory; `SKILL.md` is its entry file — the same role `index.html` plays for a web dir. The dir IS the skill: siblings (`reference.md`, scripts, examples) ride along, nested subdirs are themselves skills.

Audience: LLM agents loading this to create or audit a skill. Decision-first.

## Minimum viable skill

**Plugin-owned:**
```
<plugin-root>/skills/<name>/SKILL.md
```

**Scope-owned** (no plugin, just your project or user scope):
```
~/.crouter/skills/<name>/SKILL.md              # user scope
<project>/.crouter/skills/<name>/SKILL.md      # project scope
```

```markdown
---
name: <name>
type: <type>
description: <one sentence — used by the agent to decide whether to load this>
keywords: [optional, list]
---

# Title

Body in markdown. This is what `crtr skill show <name>` prints.
```

Drop the directory in place; `crtr skill list` picks it up. No build, no registry.

## Template types

Pick the type matching what the agent *does* after reading.

| Type | Agent action | Source of truth | Example |
|---|---|---|---|
| `playbook` | Decides — applies judgment ("when X, do Y because Z") | The skill itself | this skill, cli-design |
| `primer` | Navigates — learns architectural facts about a codebase | Code in repo | crtr-internals |
| `reference` | Looks up — stable external facts | Docs/specs/protocols | semver-rules |
| `runbook` | Executes — numbered procedure with rollback | The skill (steps fixed) | deploy-plugin |
| `freeform` | None of the above | Varies | catch-all |

### Picking the type

- Agent needs to make a *judgment call*? → `playbook`. Lead with rules; show examples; state the *why* so edge cases resolve themselves.
- Agent needs to *navigate code* that drifts over time? → `primer`. Point at `file:line`. Don't transcribe code; explain the *shape*.
- Agent needs *stable facts* (semver, HTTP codes, protocol fields)? → `reference`. Tables, terse, no methodology.
- Agent needs to *run a procedure* with known steps and failure modes? → `runbook`. Numbered. Include rollback per step.
- None of the above → `freeform`. Try harder first — the other four catch ~95% of cases.

### Anti-patterns by type

- `playbook` that's mostly code listings → split code to siblings; keep judgment in SKILL.md.
- `primer` that duplicates code it points to → just point; don't transcribe.
- `reference` that contains methodology → split methodology into a `playbook` sibling.
- `runbook` with no decision points → it's a script; ship a script.

## The `name` rule

`name:` MUST equal the skill's path under `skills/`. For `skills/cli-design/SKILL.md`, `name: cli-design`. For `skills/web/frontend/design-website/SKILL.md`, `name: web/frontend/design-website` — slashes and all.

`crtr skill new <plugin>:<name>` (or `crtr skill new <name>` for scope-owned) scaffolds this correctly. `crtr doctor` flags drift.

## Nested skills

Nesting is directory nesting. No `parent:` field, no registry. The path IS the hierarchy.

```
skills/
├── prompting-effectively/SKILL.md         # flat
├── cli-design/                            # flat with sibling assets
│   ├── SKILL.md
│   └── reference.md
└── web/
    └── frontend/
        └── design-website/SKILL.md        # name: web/frontend/design-website
```

Resolve nested with `crtr skill show web/frontend/design-website`.

Intermediate dirs (`web/`, `web/frontend/`) can be purely organizational — no SKILL.md required at each level. Add one only if you want a primer for the whole nest.

## Assets and references

Anything sibling to `SKILL.md` is part of the skill. The `cli-design` shape — `SKILL.md` for prose, `reference.md` for tables you don't want inline — is canonical. Scripts, example configs, screenshots all live as siblings. Reference from `SKILL.md` with relative paths.

Don't use a top-level `assets/` dir; the dir IS the skill, and grouping per skill keeps moves atomic.

## Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must equal path under `skills/`. Slashes for nested. |
| `type` | yes | One of: `playbook` `primer` `reference` `runbook` `freeform`. |
| `description` | yes | One sentence. Front-load the trigger ("Use when…"). The agent decides whether to load based on this. |
| `keywords` | no | Array of strings. Improves `crtr skill grep` and search. |

Descriptions: active and specific. "Guide to X" is weak; "Use when doing X — covers Y and Z" is strong.

## The authoring loop

```bash
# 1. Scaffold — plugin-owned or scope-owned
crtr skill new <plugin>:my-skill --type playbook --description "Use when …"
crtr skill new my-skill --type playbook --description "Use when …"  # scope-owned

# 2. Find and edit
crtr skill path <plugin>:my-skill                # absolute path
$EDITOR $(crtr skill path <plugin>:my-skill)

# 3. Validate
crtr doctor

# 4. Preview as the agent sees it (includes auto-appended neighbors)
crtr skill show my-skill
```

## Cross-skill links

- Sibling and nested skills in the same plugin/scope auto-append in a `<neighbors>` XML block inside the `<skill>` wrapper. Don't hand-roll these.
- `## Related` in the body is for **cross-plugin or distant** references only — not siblings.
- Cross-plugin refs: `` `<plugin>/<name>` ``. Scope-direct: `` `<scope>:<name>` ``.
- Suppress neighbors: `crtr skill show <name> --no-neighbors`.

If `## Related` would only list siblings, delete the section.

## What goes in the body

Skills are reference + methodology for an agent. Good skills:
- Lead with trigger conditions and a one-paragraph summary so the agent can decide whether to read further.
- Use greppable headings (`## When to use`, `## Common pitfalls`).
- Show concrete invocations — code blocks beat prose.
- Link sibling assets: `see [reference.md](./reference.md)`.

Bad skills:
- Tell the agent what it already knows ("markdown uses `#` for headings").
- Bury triggers under five paragraphs of motivation.
- Pile related-but-distinct topics into one skill — split into nested sub-skills.

Budget ~150 lines for `SKILL.md` bodies. If a section exceeds 20 lines without teaching judgment, move it to a sibling file.

## Validation

`crtr doctor` checks every skill:
- Frontmatter parses as YAML.
- `name` matches the directory path.
- `SKILL.md` exists and is non-empty.
- Referenced sibling files exist (best-effort from markdown links).
- `type` is present and in the enum (fails if not).

A skill failing doctor still loads — doctor is advisory — but `crtr skill list --json` flags it.

## Collisions

Skill names need only be unique *within a plugin*. Two plugins shipping the same name collide; resolution order (project plugin → user plugin → project marketplace → user marketplace → builtin) picks one, and `crtr` exits `4` for ambiguous lookups when explicitness is required. Disambiguate with `<plugin>:<skill>`: `crtr skill show crtr:crouter-development/skills`.
