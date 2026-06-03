// Descriptor types and renderers for the -h layer of the crtr CLI.
// Pure functions — no side effects, no commander, no process.exit.
// Rendering matches reference.md shapes exactly:
//   root L11-32, branch L43-58, leaf L65-189.

// ---------------------------------------------------------------------------
// Descriptor interfaces
// ---------------------------------------------------------------------------

export interface Field {
  name: string;
  type: string;
  required: boolean;
  /** Inline semantic constraint — bounds, enum, "must reference an active plan",
   *  token caps. Lives here, never in a separate Preconditions section. */
  constraint: string;
}

// ---------------------------------------------------------------------------
// New argv-model input parameter schema (for leaves with inputModel: 'argv')
// ---------------------------------------------------------------------------

/** Positional argument — at most one per leaf. */
export interface PositionalParam {
  kind: 'positional';
  name: string;
  /** Display hint only; always parsed as string. */
  type?: 'string' | 'path';
  required: boolean;
  constraint: string;
}

/** Long-form flag (`--name`). */
export interface FlagParam {
  kind: 'flag';
  name: string;
  /** 'bool' flags take no value — presence = true. */
  type: 'string' | 'int' | 'bool' | 'path' | 'enum';
  /** Required only when type is 'enum'. */
  choices?: string[];
  required: boolean;
  constraint: string;
  default?: string | number | boolean;
  /** When true, the flag may appear multiple times; values accumulate into an
   *  array. TODO: no current leaf needs this — implement when first leaf migrates. */
  repeatable?: boolean;
}

/** Raw stdin content blob (piped text, not parsed as JSON). */
export interface StdinParam {
  kind: 'stdin';
  name: string;
  required: boolean;
  constraint: string;
}

/** --context-file PATH: reads and JSON-parses the file at PATH. */
export interface ContextFileParam {
  kind: 'context-file';
  name: string;
  required: boolean;
  constraint: string;
  /** Optional description of the expected JSON shape. */
  shape?: string;
}

export type InputParam = PositionalParam | FlagParam | StdinParam | ContextFileParam;

/** A subtree's self-description at the parent (root) level. Each subtree owns
 *  the content that represents it one level up: its vocabulary line, its
 *  selection rubric, and any bounded block it contributes to the parent's -h.
 *  defineRoot assembles the root help from these — root never hardcodes a
 *  subtree's representation. See cli-design "Each node owns its parent-level
 *  representation". */
export interface RootEntry {
  /** One-line vocabulary desc — what this subtree is. Rendered first in the
   *  subtree's <name> block at root. */
  concept: string;
  /** Operations summary (verb list). Carried for completeness; the root block
   *  leads with concept + rubric, so this is available but not rendered. */
  desc: string;
  /** The selection rubric — `use when X` in the subtree's <name> block. */
  useWhen: string;
  /** Optional bounded block this subtree contributes to its <name> block at
   *  root. Returns a complete self-named state element (build it with
   *  stateBlock), e.g. `<skills count="42">…</skills>`. Aggregate, never an
   *  unbounded enumeration on a cold path. Soft-fails to omission on
   *  null/throw. */
  dynamicState?: () => string | null;
}

export interface RootHelp {
  tagline: string;
  /** One entry per listed subtree. Each renders as its own <name> XML block at
   *  root, carrying the subtree's concept, selection rubric, and any nested
   *  runtime-state block. Assembled from subtrees' RootEntry by defineRoot;
   *  root hardcodes none of it. */
  commands: {
    name: string;
    concept: string;
    desc: string;
    useWhen: string;
    dynamicState?: () => string | null;
  }[];
  globals: { name: string; desc: string }[];
}

export interface BranchHelp {
  name: string;
  summary: string;
  /** Local lifecycle/model line that extends the parent definition. */
  model?: string;
  /** Bounded runtime aggregate as a complete self-named state element (build
   *  it with stateBlock), e.g. `<skills count="42">…</skills>`. Renderer
   *  soft-fails to omission if this returns null or throws. */
  dynamicState?: () => string | null;
  children: { name: string; desc: string; useWhen: string }[];
}

export interface LeafHelp {
  name: string;
  summary: string;
  /** Optional long-form workflow prose rendered immediately after the summary
   *  line. Only plan new / spec new carry this; it precedes the schema. */
  guide?: string;
  params?: InputParam[];
  /** Note appended when there is no input (replaces the Input block). */
  inputNote?: string;
  output: Field[];
  outputKind: 'object' | 'jsonl';
  /** Every persistent change the command makes to the world. For read-only
   *  leaves use exactly: ["None. Read-only."] */
  effects: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a self-named runtime-state element: `<tag attr="v">body</tag>`. The
 *  subtree that owns the state authors it through this, so the tag name and any
 *  scalar metadata (e.g. a count) travel with the data and render identically
 *  at every level the block appears. The tag name carries the label, so the
 *  body never repeats it. Attribute values are controlled (counts, short
 *  tokens) and not escaped. */
export function stateBlock(
  tag: string,
  attrs: Record<string, string | number>,
  body: string,
): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  return `<${tag}${a}>\n${body}\n</${tag}>`;
}

/** Evaluate a dynamicState hook, soft-failing to null on throw or empty. */
function evalDynamic(fn?: () => string | null): string | null {
  if (fn === undefined) return null;
  try {
    const s = fn();
    return s !== null && s !== '' ? s : null;
  } catch {
    return null;
  }
}

/** Return the longest string length in an array of names. */
function maxLen(names: string[]): number {
  let max = 0;
  for (const n of names) {
    if (n.length > max) max = n.length;
  }
  return max;
}

/** Pad a string to the given width with trailing spaces. */
function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

// ---------------------------------------------------------------------------
// renderRoot
// ---------------------------------------------------------------------------

const IO_CONTRACT =
  'I/O contract: flags and positional args on input; stdout is agent-ready markdown/XML you\n' +
  'act on directly — read it as a continuation of your prompt, don\'t parse it as data.\n' +
  'Exit 0 on success, non-zero on failure. Schemas appear at leaf -h.';

// Behavioral instruction (not a schema) — engrained in the appended system
// prompt so the model treats unfamiliar capabilities as a cue to discover the
// contract, never to guess. Lives in the root guide, outside any leaf -h.
const CAPABILITY_DISCOVERY =
  "If the user mentions or implies a crtr capability you don't fully understand, " +
  'do not guess or assume it is unsupported — run `-h` on the relevant command ' +
  '(append it anywhere along the path) to read the contract before acting.';

export function renderRoot(h: RootHelp): string {
  const lines: string[] = [];

  lines.push(`${h.tagline}`);
  lines.push('');

  // Each subtree is one <command name="…"> block. The uniform wrapper states
  // "this is a command you invoke as `crtr <name>`" — so the model reads them
  // by one rule, and a nested state element (which is never a <command>) can't
  // be mistaken for a sibling command. Inside: the concept (what it is), the
  // selection rubric (when to pick it), then any self-named state element
  // grouped with the command it belongs to. Once injected into a system prompt,
  // each block reads as one self-contained concern domain. Header (tagline) and
  // footer (Globals + I/O contract + capability-discovery rule) are the only
  // non-command areas. Two levels of nesting: <command> → <state>.
  for (const c of h.commands) {
    lines.push(`<command name="${c.name}">`);
    lines.push(c.concept);
    lines.push(`use when ${c.useWhen}`);
    // dynamicState returns a complete self-named element (e.g.
    // <skills count="42">…</skills>) — emit it as-is, nested in the command.
    const state = evalDynamic(c.dynamicState);
    if (state !== null) lines.push(state);
    lines.push('</command>');
    lines.push('');
  }

  // Globals block (footer)
  lines.push('Globals');
  const gNameW = maxLen(h.globals.map((g) => g.name));
  for (const g of h.globals) {
    lines.push(`  ${pad(g.name, gNameW)}  ${g.desc}`);
  }
  lines.push('');

  lines.push(IO_CONTRACT);
  lines.push('');
  lines.push(CAPABILITY_DISCOVERY);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderBranch
// ---------------------------------------------------------------------------

export function renderBranch(h: BranchHelp): string {
  const lines: string[] = [];

  lines.push(`${h.name}: ${h.summary}.`);

  // Dynamic content leads — the live aggregate (e.g. the <skills> catalog)
  // renders right after the name, before the hardcoded model prose, so current
  // state is read first. The subtree authors the whole element, so the same
  // self-named block appears identically at root and at `skill -h`.
  const branchState = evalDynamic(h.dynamicState);
  if (branchState !== null) {
    // dynamicState returns a complete self-named element — emit as-is.
    lines.push('');
    lines.push(branchState);
  }

  if (h.model !== undefined) {
    lines.push('');
    lines.push(h.model);
  }

  lines.push('');
  lines.push('Branches');

  const nameW = maxLen(h.children.map((c) => c.name));
  const descW = maxLen(h.children.map((c) => c.desc));
  for (const c of h.children) {
    lines.push(`  ${pad(c.name, nameW)}  ${pad(c.desc, descW)}  | use when ${c.useWhen}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderLeafArgv
// ---------------------------------------------------------------------------

/** Build the display label for a param entry (left column). */
function paramLabel(p: InputParam): string {
  if (p.kind === 'positional') return p.name.toUpperCase();
  if (p.kind === 'stdin') return 'stdin';
  if (p.kind === 'context-file') return '--context-file PATH';
  // flag
  const f = p as FlagParam;
  if (f.type === 'bool') return `--${f.name}`;
  return `--${f.name} ${f.name.toUpperCase().replace(/-/g, '_')}`;
}

/** Build the description line for a param entry (right column). */
function paramDesc(p: InputParam): string {
  const req = p.required ? 'required' : 'optional';
  if (p.kind === 'positional') return `positional, ${req}. ${p.constraint}`;
  if (p.kind === 'stdin') return `${req}. ${p.constraint}`;
  if (p.kind === 'context-file') {
    const shape = (p as ContextFileParam).shape !== undefined
      ? ` Shape: ${(p as ContextFileParam).shape}`
      : '';
    return `${req}. Path to a JSON file.${shape} ${p.constraint}`.trim();
  }
  // flag
  const f = p as FlagParam;
  if (f.type === 'bool') return `optional boolean. Presence means true. ${f.constraint}`.trim();
  const dflt = f.default !== undefined ? ` Default: ${String(f.default)}.` : '';
  const choices = f.type === 'enum' && f.choices !== undefined
    ? ` One of: ${f.choices.join(', ')}.`
    : '';
  return `${f.type}, ${req}.${choices}${dflt} ${f.constraint}`.trim();
}

export function renderLeafArgv(h: LeafHelp): string {
  const lines: string[] = [];

  lines.push(`${h.name}: ${h.summary}.`);

  if (h.guide !== undefined) {
    lines.push('');
    lines.push(h.guide);
  }

  lines.push('');

  const params = h.params ?? [];
  if (params.length > 0) {
    lines.push('Input');
    const labels = params.map(paramLabel);
    const colW = maxLen(labels);
    for (let i = 0; i < params.length; i++) {
      lines.push(`  ${pad(labels[i], colW)}  ${paramDesc(params[i])}`);
    }
  } else {
    lines.push(h.inputNote !== undefined ? h.inputNote : 'No input parameters.');
  }

  lines.push('');

  // The result is rendered as instruction-shaped XML+markdown; these fields are
  // the information it carries, in order, not a literal JSON shape.
  lines.push('Output (fields carried in the rendered result)');
  const outNameW = maxLen(h.output.map((f) => f.name));
  for (const f of h.output) {
    lines.push(`  ${pad(f.name, outNameW)}  ${f.type}. ${f.constraint}`);
  }

  lines.push('');

  lines.push('Effects');
  for (const e of h.effects) {
    lines.push(`  ${e}`);
  }

  return lines.join('\n');
}
