// `crtr agent plan` subtree — plan new / show / list handlers.
export const PLAN_NEW_GUIDE = `## Planning workflow

Build and save an implementation plan: a map another agent can execute without
re-discovering context. Work through these phases before saving.

### Phase 1: Understand

Build a full picture of the request and the code. Search for reusable
functions, patterns, and existing implementations before proposing new ones.

Launch up to 3 Explore subagents IN PARALLEL (single message, multiple tool
calls). Use 1 agent for isolated, small-scope tasks; use more when scope is
uncertain or multiple subsystems are involved. Give each a distinct focus so
they don't duplicate work.

### Phase 2: Design

Design the implementation from Phase 1 findings. Default to launching at least
1 Plan agent to validate your understanding and surface alternatives. Skip only
for trivially small tasks (typo fixes, single-line renames). Use up to 3 agents
for large refactors or architectural changes.

In the Plan agent prompt: include file paths, code-path traces, requirements,
and constraints from Phase 1. Request a detailed implementation plan.

### Phase 3: Review findings

Read the critical files identified by agents. Confirm the plan aligns with the
user's request. Use AskUserQuestion ONLY to clarify requirements or choose
between approaches — never to ask "is this okay?" or "should I proceed?".

### Phase 4: Compose the plan body

Quality bar — every item below is cheap to satisfy and saves the implementer
from re-deciding:

- Every decision pinned. No "if X then Y" branches, no "investigate whether…",
  no deferred choices. If you don't know, find out or ask now.
- No timelines, no fallbacks, no magic values, no "for now" shortcuts.
- Where the plan creates a new interface, schema, or contract, write the actual
  shape, not "design a Foo type."

Required sections:

  # Plan: <one-line title>

  ## Context
  <why this change is being made — the problem, what prompted it, intended outcome>

  ## Recommended approach
  <your chosen approach only. Concise enough to scan, detailed enough to execute.>

  ## Files to modify / create
  - \`path/to/file.ts\` — <what changes>

  ## Existing utilities to reuse
  - \`functionName\` from \`path/to/file.ts:LL\` — <why it fits>

  ## Verification
  <how to test end-to-end — run the code, run tests, etc.>

For plans touching 4+ files across distinct concerns, structure parallel tasks:

  ## Tasks
  - **Task 1**: <name>
    - Files: \`a.ts\`, \`b.ts\` (disjoint from other tasks)
    - Depends on: (none) | Task N
    - Integration: <shared types/APIs with exact shape>
    - Changes: <bullets>

Skip the Tasks structure for small plans; it's noise when there's no
parallelism to unlock.

### Phase 5: Save

Run \`crtr agent plan new\`:

  echo '<plan markdown>' | crtr agent plan new <kebab-case-name> [--spec <spec-name>]

- NAME: short kebab-case slug. Nested names become subdirectories
  (e.g. \`auth/jwt-refresh\`).
- Pipe the full plan markdown composed in Phase 4 on stdin.
- \`--spec\` (optional): name of the spec this plan implements. Enables alignment
  check by the reviewer.

Output: \`{path, follow_up}\`. The \`follow_up\` field names the exact next call
— run it.

### Phase 6: Oversize check

If \`follow_up\` contains an oversize advisory (plan exceeds 200 lines), split
into a short index plan plus nested part plans, each under the threshold.
Re-save. The implementer executes parts one at a time; long monolithic plans
are under-decomposed.

### Phase 7: Done

After the reviewer approves the plan, your turn ends. Do not summarize in chat.
For a human gate, optionally put the plan in front of a person with \`crtr
human review\` (anchored comments) and gate the handoff with \`crtr human
approve\`. This complements — it does not replace — \`crtr agent new reviewer\`.
If the user is ready to build, ask once whether to hand off; if yes, run:
\`crtr agent new implementer\` with the plan path.`;

export const PLAN_SHOW_GUIDE = '';

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { saveArtifact, readArtifact, listArtifacts, OVERSIZE_WARN_LINES } from '../core/artifact.js';
import { paginate } from '../core/pagination.js';

export function registerPlan(): BranchDef {
  const planNew = defineLeaf({
    name: 'new',
    help: {
      name: 'agent plan new',
      summary: 'draft a plan from intent and optional spec alignment',
      guide: PLAN_NEW_GUIDE,
      params: [
        {
          kind: 'positional',
          name: 'name',
          type: 'string',
          required: true,
          constraint: 'Kebab-case slug used as the artifact filename. No spaces; use hyphens.',
        },
        {
          kind: 'stdin',
          name: 'body',
          required: true,
          constraint: "Full planning prose. Treated as the planner's north star; not parsed further.",
        },
        {
          kind: 'flag',
          name: 'spec',
          type: 'string',
          required: false,
          constraint: 'Name of the spec this plan implements. Enables alignment check on write. Must reference an existing spec artifact.',
        },
      ],
      output: [
        {
          name: 'path',
          type: 'string',
          required: true,
          constraint: 'Absolute path to the written plan artifact.',
        },
        {
          name: 'follow_up',
          type: 'string',
          required: true,
          constraint: 'Recommended next call (reviewer spawn via `crtr agent new reviewer`).',
        },
      ],
      outputKind: 'object',
      effects: [
        'Writes a plan artifact to the plans artifact directory.',
        'If `--spec` is provided, records the spec alignment reference in the artifact frontmatter.',
      ],
    },
    run: async (input) => {
      const name = input['name'] as string;
      const body = input['body'] as string;
      const spec = input['spec'] as string | undefined;

      const meta: Record<string, string> = {};
      if (spec !== undefined) meta['spec'] = spec;

      const { path, oversize, lineCount } = saveArtifact('plans', name, body, meta);

      let follow_up =
        `Review it: crtr agent new reviewer ${path} --kind plan (returns {job_id}), then crtr job read result <job_id> --wait.`;

      follow_up +=
        ` Optional human gate (complements, does not replace the agent reviewer): crtr human review --file ${path} for anchored comments, then gate handoff with crtr human approve --title "Approve this plan?".`;

      if (oversize) {
        follow_up +=
          ` OVERSIZE ADVISORY: this plan is ${lineCount} lines (> ${OVERSIZE_WARN_LINES}). Split into a short index plan plus nested part plans before reviewing.`;
      }

      return { path, follow_up };
    },
  });

  const planShow = defineLeaf({
    name: 'show',
    help: {
      name: 'agent plan show',
      summary: 'read a plan artifact by name',
      params: [
        {
          kind: 'positional',
          name: 'name',
          type: 'string',
          required: true,
          constraint: 'Exact artifact name (no path extension). Use `plan list` to enumerate.',
        },
      ],
      output: [
        {
          name: 'name',
          type: 'string',
          required: true,
          constraint: 'Artifact name as stored.',
        },
        {
          name: 'path',
          type: 'string',
          required: true,
          constraint: 'Absolute path to the artifact file.',
        },
        {
          name: 'body',
          type: 'string',
          required: true,
          constraint: 'Full plan body text.',
        },
        {
          name: 'spec',
          type: 'string | null',
          required: true,
          constraint: 'Associated spec name, or null if none.',
        },
      ],
      outputKind: 'object',
      effects: ['None. Read-only.'],
    },
    run: async (input) => {
      const name = input['name'] as string;
      const record = readArtifact('plans', name);
      return { name: record.name, path: record.path, body: record.body, spec: record.spec };
    },
  });

  const planList = defineLeaf({
    name: 'list',
    help: {
      name: 'agent plan list',
      summary: 'paginated list of plan artifacts, sorted ascending by name',
      params: [
        {
          kind: 'flag',
          name: 'scope',
          type: 'enum',
          choices: ['user', 'project', 'all'],
          required: false,
          constraint: 'Filter by scope. Omit to list all.',
        },
        {
          kind: 'flag',
          name: 'limit',
          type: 'int',
          required: false,
          default: 20,
          constraint: 'Default 20, max 100.',
        },
        {
          kind: 'flag',
          name: 'cursor',
          type: 'string',
          required: false,
          constraint: "Opaque token from a previous response's next_cursor. Omit on first call.",
        },
      ],
      output: [
        {
          name: 'items',
          type: 'object[]',
          required: true,
          constraint: 'Each: {name, path, updated_at}. Sorted ascending by name.',
        },
        {
          name: 'next_cursor',
          type: 'string | null',
          required: true,
          constraint: 'Pass on the next call to continue. null means no more items.',
        },
        {
          name: 'total',
          type: 'integer | null',
          required: true,
          constraint: 'Total plans matching the query. Exact when cheap; null on large/filtered sets — do not retry to force it.',
        },
      ],
      outputKind: 'object',
      effects: ['None. Read-only.'],
    },
    run: async (input) => {
      const limit = (input['limit'] as number | undefined) ?? 20;
      const cursor = input['cursor'] as string | undefined;

      const all = listArtifacts('plans');
      const result = paginate(all, { limit, cursor }, {
        defaultLimit: 20,
        maxLimit: 100,
        keyOf: (item) => item.name,
        total: 'count',
      });

      return {
        items: result.items,
        next_cursor: result.next_cursor,
        total: result.total,
      };
    },
  });

  return defineBranch({
    name: 'plan',
    help: {
      name: 'agent plan',
      summary: 'create and read plan artifacts',
      model: 'Lifecycle: draft -> active -> handed-off.',
      children: [
        { name: 'new', desc: 'draft a plan from intent', useWhen: 'starting fresh work or decomposing a spec' },
        { name: 'show', desc: 'read a plan by name', useWhen: 'reasoning about an existing plan' },
        { name: 'list', desc: 'enumerate plans', useWhen: 'discovering what plans exist' },
      ],
    },
    children: [planNew, planShow, planList],
  });
}
