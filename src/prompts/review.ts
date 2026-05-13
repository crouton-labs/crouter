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
  return `You are reviewing a spec document. Verify it is complete and ready for
planning.

**Spec to review:** ${specPath}

Read the spec end-to-end first.

## What to check

| Category | What to look for |
|----------|------------------|
| Completeness | TODOs, placeholders, "TBD", incomplete sections |
| Consistency | Internal contradictions, conflicting requirements |
| Clarity | Requirements ambiguous enough to cause someone to build the wrong thing |
| Scope | Focused enough for a single plan |
| YAGNI | Unrequested features, over-engineering |

For specs with non-trivial component interaction, also walk the primary
flow from trigger to final state and check whether preconditions, state
transitions, failure handling, and handoffs between components are
actually specified. This is the highest-signal check when there are
seams to fall between — skip it for self-contained specs.

For larger specs touching established patterns, optionally spawn a Task
agent (\`general-purpose\`, \`sonnet\`) to cross-check the spec's design
against \`CLAUDE.md\` / \`.claude/rules/*.md\` and the files it references,
looking for contradictions with project conventions. Skip for small specs.

## Calibration

Approve unless an implementer or planner would be led astray. Real issues:
missing requirements, contradictory design, unspecified failure modes on
critical paths, requirements ambiguous enough to be built two ways. Not
issues: wording preferences, "I'd have organized this differently",
sections less detailed than others.

## Output

## Spec Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [Section]: [specific issue] — [why it matters for planning]

**Recommendations (advisory, do not block approval):**
- [suggestions]

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

  return `You are reviewing a plan document. Verify it is complete and ready for
implementation.

${inputs}

## What to check

| Category | What to look for |
|----------|------------------|
| Completeness | TODOs, placeholders, incomplete tasks, missing steps |
${specPath === null ? '' : '| Spec alignment | Plan covers spec requirements, no major scope creep, no unjustified divergence from the spec\'s design |\n'}| Resolved decisions | No "if X then Y" branches, no "investigate whether…", no deferred choices |
| Buildability | Could an engineer follow this without getting stuck or re-deciding things? |
| Quality smells | Timelines, "for now" shortcuts, magic values, fallbacks, missing type definitions where the plan creates a new contract |

For medium+ plans that claim parallelizable tasks, also check that tasks
own disjoint files (or call out unavoidable overlap) and that shared
types/APIs between tasks have their contracts specified.

For large plans${specPath === null ? '' : ', or when spec coverage feels uncertain'}, you may
optionally spawn one Task agent (\`general-purpose\`, \`sonnet\`) to
cross-check ${specPath === null ? 'coverage of the plan\'s own stated phases against its task list' : `spec requirements at \`${specPath}\` against plan tasks`}.
Skip for small plans.

## Calibration

Approve unless an implementer would build the wrong thing, get stuck, or
ship something that violates the plan's quality bar. Minor wording,
stylistic preferences, and "nice to have" reorganizations are NOT issues.

## Output

## Plan Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [Task / Section]: [specific issue] — [why it matters for implementation]

**Recommendations (advisory, do not block approval):**
- [suggestions]

${SUBMIT_INSTRUCTIONS}`;
}
