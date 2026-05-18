// `crtr flow spec` subtree — spec new / show / list handlers.
export const SPEC_NEW_GUIDE = `## Spec workflow

Build and save a design + requirements spec: a document describing what to
build, the shape of the solution, and the behaviors it must satisfy. A spec is
upstream of a plan — it captures decisions, not implementation steps.

Anti-pattern: do not fish for clarifications upfront. Draft a concrete spec
first based on your investigation, then iterate. A specific draft the user can
react to converges faster than a list of questions in a vacuum.

### Phase 1: Shape

Build a comprehensive picture of the problem and the relevant code. Surface
existing patterns, constraints, and prior decisions.

Launch up to 3 Explore subagents IN PARALLEL (single message, multiple tool
calls). Use 1 agent for narrow, well-scoped problems; use more when the spec
touches several subsystems or you need to compare existing implementations.
Quality over quantity — 3 agents maximum.

After exploration, draft a high-level design: the shape of the solution, new or
changed pieces, the boundaries.

### Phase 2: Requirements

Translate the shape into concrete behavioral requirements. Each requirement
must be:

- Testable — has a clear pass/fail condition.
- Behavior-focused — describes what the system does, not how.
- Scoped — covers one observable behavior.

Group requirements by capability. Plain English is fine. For conditional or
stateful behaviors, EARS templates sharpen phrasing:
\`When <trigger>, the system shall <behavior>\` or
\`If <condition>, then the system shall <response>\`.

For larger / multi-component designs, walk the design end-to-end: at each step
from trigger to final state, verify preconditions, state, failure handling, and
handoffs between components are specified. Skip this for small self-contained
specs.

### Phase 3: Deepen

Read the critical files identified during Phase 1. Reconcile requirements
against the shape — if a requirement reveals a gap in the design, refine the
design before saving.

Use AskUserQuestion ONLY to clarify requirements or choose between approaches.
Never use it to ask "is this spec okay?" or "should I save?".

### Phase 4: Compose the spec body

Required sections:

  # Spec: <one-line title>

  ## Context
  <the problem this spec addresses, what motivates it, and the intended outcome.
  Include relevant constraints — user goals, stakeholders, deadlines.>

  ## Design
  <the shape of the solution. Components, data flow, key decisions and why they
  were chosen. Reference existing code with \`file_path:line_number\`.>

  ## Requirements
  <grouped behavioral requirements. Each one testable. Plain English is fine.>

  ### <Capability A>
  - <one observable behavior>

  ### <Capability B>
  - ...

  ## Out of scope
  <things explicitly NOT covered, so the next reader knows where the edges are.>

  ## Open questions
  <anything you could not resolve. Empty if all decisions are pinned.>

### Phase 5: Save

Run \`crtr flow spec new\`:

  echo '<spec markdown>' | crtr flow spec new <kebab-case-name>

- NAME: short kebab-case slug. Nested names become subdirectories
  (e.g. \`auth/refresh-tokens\`).
- Pipe the full spec markdown composed in Phase 4 on stdin.

Output: \`{path, follow_up}\`. The \`follow_up\` field names the exact next call
— run it.

### Phase 6: Done

After the reviewer approves the spec, your turn ends. Do not summarize in chat.
For a human gate, optionally run \`crtr human review\` on the spec for anchored
comments and \`crtr human approve\` to gate the handoff — this complements, not
replaces, \`crtr job start reviewer\`.
If the user is ready to plan, ask once whether to hand off; if yes, follow the
\`follow_up\` instructions from the save output.`;

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { saveArtifact, readArtifact, listArtifacts, OVERSIZE_WARN_LINES } from '../core/artifact.js';
import { paginate } from '../core/pagination.js';

export function registerSpec(): BranchDef {
  const specNew = defineLeaf({
    name: 'new',
    help: {
      name: 'spec new',
      summary: 'draft a specification artifact from intent',
      guide: SPEC_NEW_GUIDE,
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
          constraint: 'Full specification prose. Treated as ground truth for downstream planning.',
        },
      ],
      output: [
        {
          name: 'path',
          type: 'string',
          required: true,
          constraint: 'Absolute path to the written spec artifact.',
        },
        {
          name: 'follow_up',
          type: 'string',
          required: true,
          constraint: 'Recommended next call (planner job start).',
        },
      ],
      outputKind: 'object',
      effects: ['Writes a spec artifact to the specs artifact directory.'],
    },
    run: async (input) => {
      const name = input['name'] as string;
      const body = input['body'] as string;

      const { path, oversize, lineCount } = saveArtifact('specs', name, body);

      let follow_up =
        `Plan it: crtr job start planner --artifact-path ${path} (returns {job_id}), then crtr job read result <job_id> --wait.`;

      follow_up +=
        ` Optional human gate before planning (complements, does not replace \`crtr job start reviewer\`): crtr human review --file ${path} for anchored comments, then gate with crtr human approve --title "Approve this spec?".`;

      if (oversize) {
        follow_up +=
          ` OVERSIZE ADVISORY: this spec is ${lineCount} lines (> ${OVERSIZE_WARN_LINES}). Split into focused sub-specs before planning.`;
      }

      return { path, follow_up };
    },
  });

  const specShow = defineLeaf({
    name: 'show',
    help: {
      name: 'spec show',
      summary: 'read a spec artifact by name',
      params: [
        {
          kind: 'positional',
          name: 'name',
          type: 'string',
          required: true,
          constraint: 'Exact artifact name (no path extension). Use `spec list` to enumerate.',
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
          constraint: 'Full spec body text.',
        },
      ],
      outputKind: 'object',
      effects: ['None. Read-only.'],
    },
    run: async (input) => {
      const name = input['name'] as string;
      const record = readArtifact('specs', name);
      return { name: record.name, path: record.path, body: record.body };
    },
  });

  const specList = defineLeaf({
    name: 'list',
    help: {
      name: 'spec list',
      summary: 'paginated list of spec artifacts, sorted ascending by name',
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
          constraint: 'Total specs matching the query. Exact when cheap; null on large/filtered sets — do not retry to force it.',
        },
      ],
      outputKind: 'object',
      effects: ['None. Read-only.'],
    },
    run: async (input) => {
      const limit = (input['limit'] as number | undefined) ?? 20;
      const cursor = input['cursor'] as string | undefined;

      const all = listArtifacts('specs');
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
    name: 'spec',
    help: {
      name: 'spec',
      summary: 'create and read specification artifacts',
      model: 'Lifecycle: draft -> approved. Approved specs drive plan creation.',
      children: [
        { name: 'new', desc: 'draft a spec from intent', useWhen: 'capturing requirements before planning' },
        { name: 'show', desc: 'read a spec by name', useWhen: 'reasoning about an existing spec' },
        { name: 'list', desc: 'enumerate specs', useWhen: 'discovering what specs exist' },
      ],
    },
    children: [specNew, specShow, specList],
  });
}
