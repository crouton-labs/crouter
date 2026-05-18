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

export interface RootHelp {
  tagline: string;
  /** Vocabulary block — rendered before subtrees. */
  concepts: { name: string; desc: string }[];
  subtrees: { name: string; desc: string; useWhen: string }[];
  globals: { name: string; desc: string }[];
}

export interface BranchHelp {
  name: string;
  summary: string;
  /** Local lifecycle/model line that extends the parent definition. */
  model?: string;
  /** Bounded runtime aggregate, e.g. "Current: 2 draft, 1 active".
   *  Renderer soft-fails to omission if this returns null or throws. */
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
  'I/O contract: flags and positional args on input, JSON on stdout (JSONL for streams).\n' +
  'Exit 0 on success, non-zero on failure. Schemas appear at leaf -h.';

export function renderRoot(h: RootHelp): string {
  const lines: string[] = [];

  lines.push(`${h.tagline}`);
  lines.push('');

  // Concepts block
  lines.push('Concepts');
  const cNameW = maxLen(h.concepts.map((c) => c.name));
  for (const c of h.concepts) {
    lines.push(`  ${pad(c.name, cNameW)}  ${c.desc}`);
  }
  lines.push('');

  // Subtrees block
  lines.push('Subtrees');
  const sNameW = maxLen(h.subtrees.map((s) => s.name));
  // Align desc column so "| use when X" starts at a consistent offset
  const sDescW = maxLen(h.subtrees.map((s) => s.desc));
  for (const s of h.subtrees) {
    lines.push(`  ${pad(s.name, sNameW)}  ${pad(s.desc, sDescW)}  | use when ${s.useWhen}`);
  }
  lines.push('');

  // Globals block
  lines.push('Globals');
  const gNameW = maxLen(h.globals.map((g) => g.name));
  for (const g of h.globals) {
    lines.push(`  ${pad(g.name, gNameW)}  ${g.desc}`);
  }
  lines.push('');

  lines.push(IO_CONTRACT);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderBranch
// ---------------------------------------------------------------------------

export function renderBranch(h: BranchHelp): string {
  const lines: string[] = [];

  lines.push(`${h.name}: ${h.summary}.`);

  if (h.model !== undefined) {
    lines.push(h.model);
  }

  // Dynamic state — soft-fail to omission. Rendered as its own block,
  // blank-line separated from the summary, so a multi-line runtime
  // aggregate (e.g. the loaded-skills catalog) reads cleanly.
  if (h.dynamicState !== undefined) {
    let state: string | null = null;
    try {
      state = h.dynamicState();
    } catch {
      // soft-fail: omit the block
    }
    if (state !== null && state !== '') {
      lines.push('');
      lines.push(state);
    }
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

  const outputLabel =
    h.outputKind === 'jsonl' ? 'Output (stdout, JSONL)' : 'Output (stdout, JSON)';
  lines.push(outputLabel);
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
