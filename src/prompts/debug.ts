/**
 * First user message for a reproduction-only debug handoff.
 *
 * The agent's sole job is ONE failing integration test that reproduces the
 * reported bug. It never fixes the bug. Symmetric with the agent.ts handoff
 * builders: thin prompt, exact submit contract, turn ends after submit.
 */
export function reproHandoffPrompt(issue: string, jobId: string): string {
  return `You were spawned solely to write ONE integration test that fails *because of this bug*:

${issue}

Rules — follow exactly:

- Do NOT fix the bug. Do NOT modify product code to make a test pass. Your only output is a test.
- The test must fail against the current code, and the failure must BE the reported bug — not an import error, a typo, or an unrelated assertion. Run it; paste the real failing output; confirm the failure mode matches the issue.
- Prefer an integration test against real dependencies. Mocking away the broken component is theater and does NOT count as reproduction.
- If you cannot produce a faithful failing test, GIVE UP. Never weaken assertions, hardcode expected values, or fabricate a clean-looking run — a tautological or over-mocked test is worse than none.

Submit exactly one of the following via \`crtr job submit\`, then your turn ends — do not chat:

Reproduced (markdown body on stdin):
\`\`\`bash
crtr job submit ${jobId} <<'MD'
**Reproduces:** yes

**Test path:** <path>

**Test command:** \`<exact cmd>\`

**Failure output:**
\`\`\`
<pasted failing output>
\`\`\`
MD
\`\`\`

Gave up (no faithful repro achievable):
\`\`\`bash
crtr job submit ${jobId} --status failed --reason "<why a faithful repro was not achievable>"
\`\`\`

Begin now.`;
}
