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
  input?: Field[];
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
  'I/O contract: JSON on stdin, JSON on stdout (JSONL for streams).\n' +
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

  // Dynamic state — soft-fail to omission
  if (h.dynamicState !== undefined) {
    let state: string | null = null;
    try {
      state = h.dynamicState();
    } catch {
      // soft-fail: omit the line
    }
    if (state !== null) {
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
// renderLeaf
// ---------------------------------------------------------------------------

export function renderLeaf(h: LeafHelp): string {
  const lines: string[] = [];

  lines.push(`${h.name}: ${h.summary}.`);

  // Optional long-form guide (plan new / spec new only)
  if (h.guide !== undefined) {
    lines.push('');
    lines.push(h.guide);
  }

  lines.push('');

  // Input block
  if (h.input !== undefined && h.input.length > 0) {
    lines.push('Input (stdin, JSON)');
    const nameW = maxLen(h.input.map((f) => f.name));
    for (const f of h.input) {
      const req = f.required ? 'required' : 'optional';
      lines.push(`  ${pad(f.name, nameW)}  ${f.type}, ${req}. ${f.constraint}`);
    }
  } else {
    const note =
      h.inputNote !== undefined ? h.inputNote : 'No input fields. Omit stdin or send {}.';
    lines.push(note);
  }

  lines.push('');

  // Output block
  const outputLabel =
    h.outputKind === 'jsonl' ? 'Output (stdout, JSONL)' : 'Output (stdout, JSON)';
  lines.push(outputLabel);
  const outNameW = maxLen(h.output.map((f) => f.name));
  for (const f of h.output) {
    lines.push(`  ${pad(f.name, outNameW)}  ${f.type}. ${f.constraint}`);
  }

  lines.push('');

  // Effects block
  lines.push('Effects');
  for (const e of h.effects) {
    lines.push(`  ${e}`);
  }

  return lines.join('\n');
}
