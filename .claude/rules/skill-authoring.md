---
name: skill-authoring
description: How to author or edit a crtr skill — read `crtr memory write -h` first; the read-routing line goes in the `when-and-why-to-read` frontmatter, never the body; ~150-line budget; prescriptive/descriptive voice only. Apply when creating or editing any SKILL.md or the memory-authoring CLI surface.
paths:
  - "**/SKILL.md"
  - "**/src/commands/memory/**/*.ts"
---

# Authoring or editing a skill

Before you write or change a skill, load the canonical workflow: **`crtr memory write -h`** — it carries the substrate frontmatter contract (`kind`, `when-and-why-to-read`, the two visibility rungs, gate) and the routing craft that decides who sees the doc and at what context cost. It is required reading for edits too, not just new docs.

The rules that get missed most:

- **The read-routing line belongs in the `when-and-why-to-read` frontmatter, never the body.** It is the only text an agent reads before choosing to load the doc; by the time anyone reads the body they have already picked it. A body line that says "reach for this when…" is wasted — front-load the trigger into `when-and-why-to-read` and keep the body to the workflow or knowledge itself.
- **Prescriptive or descriptive, never speculative.** State what to do or what is true. No open questions, debates, "things to consider", or hedging (`may`, `consider whether`, `it depends`). If you cannot state the answer, go find it or cut the line.
- **~150-line budget per SKILL.md.** Spill deeper material into sibling files; the entry file stays lean.

Run `crtr memory write -h` for the full routing methodology, and `crtr memory lint` to validate frontmatter — do not reconstruct them from this pointer.
