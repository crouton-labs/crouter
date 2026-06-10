import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { parseFrontmatterGeneric } from '../../core/frontmatter.js';
import { readText, writeText, pathExists } from '../../core/fs-utils.js';
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  VISIBILITY_RUNGS,
  resolveWriteTarget,
  memoryFilePath,
  coerceGate,
  coerceAppliesTo,
  serializeMemoryDoc,
} from './shared.js';

export const writeLeaf = defineLeaf({
  name: 'write',
  description: 'create or update a memory document',
  whenToUse:
    'you are recording a new skill, reference, or preference — or revising one that already exists. Writes memory/<name>.md at the resolved scope from the frontmatter flags plus a body piped on stdin. Identity is path-derived: if <name> already exists at the scope it is updated in place, otherwise it is created.',
  help: {
    name: 'memory write',
    summary: 'create or update memory/<name>.md at the resolved scope from frontmatter flags + a stdin body',
    guide:
      'The body is the easy part; the craft is ROUTING — every frontmatter flag decides who sees this doc, when, and at what context cost. Each rung up is paid by every future agent at every boot or read, forever, so default each rung DOWN.\n\n' +
      'Pick the kind. skill = how to DO something (a repeatable procedure/playbook); reference = what is TRUE or how something WORKS (a fact about the user, a system\u2019s behavior, code docs); preference = how to BEHAVE (a directive, a standing correction). The test that splits the close pair: does it DIRECT behavior ("always lint after authoring" \u2192 preference) or INFORM the world-model ("Silas likes chicken", "the daemon never reloads dist/" \u2192 reference)? A correction yields a preference, a learned fact a reference, a repeatable procedure a skill.\n\n' +
      'Set the rungs (none < name < preview < content). Kind sets sensible defaults, so the common case needs no visibility flags at all: skill \u2192 name at boot; preference \u2192 preview at boot; reference \u2192 preview on-read, nothing at boot. Reserve `content` (full body injected) for guidance that is BOTH always-relevant AND ~one bullet long \u2014 fail either test and it is `preview`. Situational guidance is `preview` no matter how short; long guidance is `preview` no matter how universal it feels.\n\n' +
      'Choose the hook \u2014 boot vs file-read. There are exactly two moments a doc can surface. Behavior and procedure (preferences, skills) are relevant whatever file is open \u2192 surface at boot. Knowledge about code (references) belongs NEXT TO the code: put the file in that directory\u2019s .crouter/memory/ and it fires positionally when files there are read, costing nothing at boot. The exception that matters: a reference about a PERSON or PROCESS has no code directory to anchor to, so on-read triggering is meaningless \u2014 set --system-prompt-visibility preview so its routing line surfaces at boot instead.\n\n' +
      'Write the routing line (--when-and-why-to-read) FIRST, before storing anything: "When <circumstance the agent is in>, this <kind> should be read because <what the read buys>." The test: can a stranger mid-task decide from that one line alone whether to spend the read? If you cannot name the concrete situation that triggers it, you do not yet understand the memory \u2014 ask the user ONE sharp question instead of improvising. ("Remember I like chicken" routes cleanly \u2192 food/meal decisions; "be careful with the API" does not \u2192 which API, careful how, against what failure?)\n\n' +
      'Find before write. `crtr memory find <topic>` first; grow ONE doc per recurring circumstance rather than minting near-duplicates \u2014 extend `food-preferences`, do not create `likes-chicken`. Group related docs with path names (area/topic). Do not store what is already recorded (code structure, git history, CLAUDE.md) or what only matters to this conversation.\n\n' +
      'Body: write for a STRANGER \u2014 a future session that shares none of this conversation. State current truth, not the history of getting there (no "as discussed"). Keep the reasoning behind a rule and cut everything else; dense beats complete, since every line costs a mid-task reader.\n\n' +
      'Gate (--gate, optional): a predicate making the doc eligible only for nodes whose own config matches (e.g. `{ mode: orchestrator }` or `{ orchestration.depth: { gte: 2 } }`); a failing gate hides it from both hooks but it stays findable by search. Default is no gate \u2014 most docs want exactly that. After authoring, validate with `crtr memory lint`.',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Path-derived identity (e.g. `topic` or `area/topic`) → memory/<name>.md at the resolved scope. Updated in place if it already exists, otherwise created.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: [...MEMORY_KINDS], required: true, constraint: 'Document kind.' },
      { kind: 'flag', name: 'when-and-why-to-read', type: 'string', required: false, constraint: 'The read-routing line, authored as ONE sentence: "When <circumstance>, this <kind> should be read <because <payoff>>." It states WHEN to read this doc and WHY the read is worth it — read-routing, NEVER a justification of why the content should be obeyed. Rendered verbatim as the preview. Required when creating.' },
      { kind: 'flag', name: 'short-form', type: 'string', required: false, constraint: 'Frontmatter short-form — a very abbreviated version of the content, the hook shown in `crtr memory list`.' },
      { kind: 'flag', name: 'system-prompt-visibility', type: 'enum', choices: [...VISIBILITY_RUNGS], required: false, constraint: 'Rung controlling how much of this document auto-loads into the system prompt / CLI help.' },
      { kind: 'flag', name: 'file-read-visibility', type: 'enum', choices: [...VISIBILITY_RUNGS], required: false, constraint: 'Rung controlling how much of this document surfaces when it is read off disk.' },
      { kind: 'flag', name: 'gate', type: 'string', required: false, constraint: 'Frontmatter gate — expression/condition that determines when this document applies.' },
      { kind: 'flag', name: 'applies-to', type: 'string', required: false, constraint: 'Frontmatter applies-to — glob/path scope the document applies to.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: [...MEMORY_SCOPES], required: false, constraint: 'Target scope. Default: project when inside a project, else user.' },
      { kind: 'stdin', name: 'body', required: true, constraint: 'Document body (markdown, no frontmatter). Piped on stdin, or passed as the bare positional after <name>.' },
    ],
    output: [
      { name: 'name', type: 'string', required: true, constraint: 'The path-derived document name written.' },
      { name: 'kind', type: 'string', required: true, constraint: 'Kind recorded in frontmatter.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope the document was written to: user or project.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the written document.' },
      { name: 'created', type: 'boolean', required: true, constraint: 'true when a new document was created, false when an existing one was updated in place.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands — read it back or list the inventory.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates or overwrites memory/<name>.md at the resolved scope with the given frontmatter fields + stdin body.',
    ],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const kind = input['kind'] as string;
    const scopeArg = input['scope'] as string | undefined;
    const body = (input['body'] as string) ?? '';

    const { scope, memoryDir } = resolveWriteTarget(scopeArg);
    const path = memoryFilePath(memoryDir, name);
    const created = !pathExists(path);

    // CREATE requires the read-routing line that becomes the preview — without
    // it every preview renders empty. UPDATE inherits it from the existing doc.
    if (created && input['whenAndWhyToRead'] === undefined) {
      throw usage(
        `creating ${name} requires --when-and-why-to-read: one read-routing sentence "When <circumstance>, this ${kind} should be read <because <payoff>>." (rendered verbatim as the preview).`,
      );
    }

    // In-place update: start from the existing frontmatter (preserving fields
    // not passed this time), then overlay the provided ones. Create: start clean.
    const frontmatter: Record<string, unknown> = created
      ? {}
      : { ...(parseFrontmatterGeneric(readText(path)).data ?? {}) };

    // kind is required, always set. Optionals only overlay when provided so an
    // update never erases a field the caller did not mention.
    frontmatter['kind'] = kind;
    const setIf = (key: string, value: unknown): void => {
      if (value !== undefined) frontmatter[key] = value;
    };
    setIf('when-and-why-to-read', input['whenAndWhyToRead']);
    setIf('short-form', input['shortForm']);
    setIf('system-prompt-visibility', input['systemPromptVisibility']);
    setIf('file-read-visibility', input['fileReadVisibility']);
    if (input['gate'] !== undefined) frontmatter['gate'] = coerceGate(input['gate'] as string);
    if (input['appliesTo'] !== undefined) {
      frontmatter['applies-to'] = coerceAppliesTo(input['appliesTo'] as string);
    }

    writeText(path, serializeMemoryDoc(frontmatter, body));

    return {
      name,
      kind,
      scope,
      path,
      created,
      follow_up: `Read it back with \`crtr memory read ${name}\`, or browse the inventory with \`crtr memory list\`.`,
    };
  },
});
