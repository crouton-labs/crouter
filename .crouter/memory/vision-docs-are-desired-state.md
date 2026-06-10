---
kind: preference
when-and-why-to-read: When you are writing or editing anything under crouter's
  vision/ directory, this preference should be read because vision docs must
  describe the desired end-state and it tells you what never belongs in one.
short-form: In crouter's vision/ dir, vision docs describe the desired end-state
  (how it should work + why), never current problems/gaps or implementation.
system-prompt-visibility: preview
file-read-visibility: none
---

A vision doc in `crouter/vision/` describes the DESIRED END-STATE — how the system should work and why — in present tense, as the target the code is measured against. It never opens with "## The problem", a current-state audit, "today X does Y wrong", or implementation mechanics. Motivation is the desired principle, not the present deficiency. Invariants are stated plainly so they can be audited.

**Why:** The human rejected `vision/node-agency/vision.md` for being framed around current problems ("you're bloating my vision documents") and asked for a rule file codifying this — `.claude/rules/vision-docs.md` (paths: `**/vision/**/*.md`).

**How to apply:** When writing/editing any `vision/**/*.md`, obey `.claude/rules/vision-docs.md` and `vision/CLAUDE.md`. Audits of vision-vs-code go elsewhere as findings, not into the vision doc. Related: [[prose-no-artificial-linebreaks]].
