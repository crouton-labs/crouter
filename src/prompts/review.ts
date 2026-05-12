const SUBMIT_INSTRUCTIONS = `## Delivering your review

When your review is complete, run a single Bash command to submit it back to
the parent agent:

\`\`\`bash
crtr agent submit "$(cat <<'EOF'
<your full review markdown here, using the Output Format below>
EOF
)"
\`\`\`

The pane will close automatically once your review is delivered. Do NOT
summarize or chat after submission — \`crtr agent submit\` IS the response.

If you cannot complete the review (file missing, totally malformed, etc.),
still call \`crtr agent submit\` with a brief explanation of why.`;

export function specReviewPrompt(specPath: string): string {
  return `You are reviewing a spec document. Verify it is complete and ready for planning.

**Spec to review:** ${specPath}

## What to Check

| Category | What to Look For |
|----------|------------------|
| Completeness | TODOs, placeholders, "TBD", incomplete sections |
| Consistency | Internal contradictions, conflicting requirements |
| Clarity | Requirements ambiguous enough to cause someone to build the wrong thing |
| Scope | Focused enough for a single plan — not covering multiple independent subsystems |
| YAGNI | Unrequested features, over-engineering |

## Calibration

**Only flag issues that would cause real problems during implementation planning.**
A missing section, a contradiction, or a requirement so ambiguous it could be
interpreted two different ways — those are issues. Minor wording improvements,
stylistic preferences, and "sections less detailed than others" are not.

Approve unless there are serious gaps that would lead to a flawed plan.

## Output Format

## Spec Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [Section X]: [specific issue] - [why it matters for planning]

**Recommendations (advisory, do not block approval):**
- [suggestions for improvement]

${SUBMIT_INSTRUCTIONS}`;
}

export function planReviewPrompt(planPath: string, specPath: string | null): string {
  const inputs =
    specPath === null
      ? `**Plan to review:** ${planPath}

No spec was provided for cross-reference — evaluate the plan on its own
merits (internal completeness, task decomposition, buildability). Skip the
"Spec Alignment" check.`
      : `**Plan to review:** ${planPath}
**Spec for reference:** ${specPath}

Read the plan first, then the spec, then evaluate alignment and the other
criteria below.`;

  return `You are reviewing a plan document. Verify it is complete and ready for implementation.

${inputs}

## What to Check

| Category | What to Look For |
|----------|------------------|
| Completeness | TODOs, placeholders, incomplete tasks, missing steps |
| Spec Alignment | Plan covers spec requirements, no major scope creep |
| Task Decomposition | Tasks have clear boundaries, steps are actionable |
| Buildability | Could an engineer follow this plan without getting stuck? |

## Calibration

**Only flag issues that would cause real problems during implementation.**
An implementer building the wrong thing or getting stuck is an issue.
Minor wording, stylistic preferences, and "nice to have" suggestions are not.

Approve unless there are serious gaps — missing requirements from the spec,
contradictory steps, placeholder content, or tasks so vague they can't be acted on.

## Output Format

## Plan Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [Task X, Step Y]: [specific issue] - [why it matters for implementation]

**Recommendations (advisory, do not block approval):**
- [suggestions for improvement]

${SUBMIT_INSTRUCTIONS}`;
}
