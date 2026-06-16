---
name: memory-authoring
description: How to author or edit a crouter memory doc — read `crtr memory write -h` first; the read-routing line goes in the `when-and-why-to-read` frontmatter, never the body; prescriptive/descriptive voice only. Apply when creating or editing memory docs or the memory-authoring CLI surface.
paths:
  - "**/.crouter/memory/**/*.md"
  - "**/src/builtin-memory/**/*.md"
  - "**/src/commands/memory/**/*.ts"
---

# Authoring or editing a memory doc

Before you write or change a memory doc, load the canonical workflow: **`crtr memory write -h`** — it carries the substrate frontmatter contract (`kind`, `when-and-why-to-read`, the two visibility rungs, gate) and the routing craft that decides who sees the doc and at what context cost. It is required reading for edits too, not just new docs.

The rules that get missed most:

- **The read-routing line belongs in the `when-and-why-to-read` frontmatter, never the body.** It is the only text an agent reads before choosing to load the doc; by the time anyone reads the body they have already picked it. A body line that says "reach for this when…" is wasted — front-load the trigger into `when-and-why-to-read` and keep the body to the workflow or knowledge itself.
- **Prescriptive or descriptive, never speculative.** State what to do or what is true. No open questions, debates, "things to consider", or hedging (`may`, `consider whether`, `it depends`). If you cannot state the answer, go find it or cut the line.
- **Agent Skills / `SKILL.md` are legacy surfaces, not crouter's authoring model.** New crouter guidance is a `.md` memory document under `memory/`, authored and validated through `crtr memory`.

Run `crtr memory write -h` for the full routing methodology, and `crtr memory lint` to validate frontmatter — do not reconstruct them from this pointer.
