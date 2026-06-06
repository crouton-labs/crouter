---
name: skill-authoring
description: How to author or edit a crtr skill — read `crtr skill author guide` first; when-to-use goes in the frontmatter description, never the body; ~150-line budget; prescriptive/descriptive voice only. Apply when creating or editing any SKILL.md or the skill-authoring CLI surface.
paths:
  - "**/SKILL.md"
  - "**/src/prompts/skill.ts"
  - "**/src/commands/skill/**/*.ts"
---

# Authoring or editing a skill

Before you write or change a SKILL.md, load the canonical workflow: **`crtr skill author guide`** (no `--type` for the template picker, then `--type <t>` for that type's skeleton). It is required reading for edits too, not just new skills — the format and voice rules govern every change, and this rule is only a pointer to it.

The rules that get missed most:

- **When-to-reach-for-this belongs in the frontmatter `description`, never the body.** The `description` is the only text an agent reads before choosing to load the skill; by the time anyone reads the body they have already picked it. A body line that says "reach for this when…" is wasted — the reader cannot act on it. Front-load "Use when…" in the description and keep the body to the workflow or knowledge itself.
- **Prescriptive or descriptive, never speculative.** State what to do or what is true. No open questions, debates, "things to consider", or hedging (`may`, `consider whether`, `it depends`). If you cannot state the answer, go find it or cut the line.
- **~150-line budget per SKILL.md.** Spill deeper material into sibling files; the entry file stays lean.

Run `crtr skill author guide` for the full methodology, the per-type skeleton, and the scaffold command — do not reconstruct them from this pointer.
