---
kind: reference
when-and-why-to-read: When authoring or reviewing substrate frontmatter, help
  text, or prompting guidance for memory documents, this reference should be read
  because the CTO ruled the routing line's purpose is read-routing, not
  justification — misreading it produces useless previews.
short-form: "why = 'why READ this doc', never 'why obey it'. Fields merged into
  one routing sentence: 'When <circumstance>, this <kind> should be read
  <optional because>'."
---

CTO ruling (2026-06-10), during the substrate work:

The `why` frontmatter field was being misread (by authors and by our own help docs) as "why this guidance should be obeyed" — a justification of the content. That is wrong. Its only job is **why an agent should spend the read** — the payoff of opening the document. The routing line exists to let a reader decide whether to read, nothing more.

Because two fields (`when` + `why`) invited that misreading and added a seam where authors restate content, the CTO directed merging them into ONE field — `whenAndWhyToRead` (adapt casing to frontmatter house style) — authored as a single routing sentence:

> "When <circumstance>, this <kind> should be read <optional: because <payoff>>."

Implications:
- Fewer fields; the generated preview becomes the field essentially verbatim instead of a composed template.
- All help docs / prompting for the field must teach the read-routing semantics explicitly.
- This is a hard cut (see [[prefers-hard-cuts]], [[cto-rejects-fallback-hedges]]): migrate every existing doc's frontmatter, enforce the new shape with `crtr memory lint`, never support both shapes at runtime.
