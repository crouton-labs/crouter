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
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Path-derived identity (e.g. `topic` or `area/topic`) → memory/<name>.md at the resolved scope. Updated in place if it already exists, otherwise created.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: [...MEMORY_KINDS], required: true, constraint: 'Document kind.' },
      { kind: 'flag', name: 'when', type: 'string', required: false, constraint: 'Frontmatter whenText — a short string describing when this document should be read.' },
      { kind: 'flag', name: 'why', type: 'string', required: false, constraint: 'Frontmatter whyText — a short string describing why this document matters.' },
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

    // CREATE requires the two prose fields that compose the generated preview
    // routing line — without them every preview renders the degenerate
    // '", read this <kind>. ."'. UPDATE inherits them from the existing doc.
    if (created && (input['when'] === undefined || input['why'] === undefined)) {
      throw usage(
        `creating ${name} requires --when and --why (they compose the preview routing line "{when}, read this ${kind}. {why}.")`,
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
    setIf('when', input['when']);
    setIf('why', input['why']);
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
