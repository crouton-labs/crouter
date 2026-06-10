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

// ---------------------------------------------------------------------------
// Subcommand visibility tier
// ---------------------------------------------------------------------------

/** How prominently a subcommand surfaces in ancestor (parent / root) -h
 *  listings. Set per child in the parent branch's `help.children`. Default
 *  'normal'.
 *   - hidden    — never listed anywhere, not even in this branch's own -h.
 *                 You must already know it exists to invoke it.
 *   - normal    — listed in this branch's own -h only (the default).
 *   - common    — ALSO promoted into the parent's -h, as a bare qualified name.
 *   - important — ALSO promoted into the parent's -h, name + shortform desc. */
export type SubTier = 'hidden' | 'normal' | 'common' | 'important';

/** A child's assembled parent-level listing entry — computed by defineBranch
 *  from each child def's own self-description (`description`/`whenToUse`/`tier`).
 *  renderBranch consumes this; it is never authored by hand and there is no
 *  parent-side copy of a child's description (principle 16: each node owns its
 *  representation one level up). */
export interface ListingChild {
  name: string;
  /** Short description for this child's <subcommand> row. */
  description: string;
  /** Selection rubric — plainly states when to reach for this command. Expansive
   *  with a variety of examples for judgment-heavy commands; concise for
   *  genuinely single-purpose ones. Rendered verbatim (no prefix). */
  whenToUse: string;
  /** Visibility tier in ancestor listings (see SubTier). 'hidden' children are
   *  dropped from every listing. */
  tier: SubTier;
  /** How many non-hidden subcommands this child itself owns — drives the
   *  `subcommands="N"` attribute when a branch child is listed without
   *  expansion. Absent for leaves and childless branches. */
  subCount?: number;
}

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
   *  stateBlock), e.g. `<kinds count="7">…</kinds>`. Aggregate, never an
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
  commands: RootCommand[];
  globals: { name: string; desc: string }[];
}

/** A single command block at root. Most fields come from the subtree's
 *  RootEntry; `subcommands`/`otherSubcommandCount` are computed by defineRoot
 *  from the subtree's children tiers. */
export interface RootCommand {
  name: string;
  concept: string;
  desc: string;
  useWhen: string;
  dynamicState?: () => string | null;
  /** Promoted subcommands surfaced inline under this command at root, in
   *  declaration order. `desc` is present only for 'important' tier; 'common'
   *  tier carries the bare qualified path. */
  subcommands?: { path: string; desc?: string }[];
  /** How many of this command's other (non-hidden, not-promoted) direct
   *  subcommands are not shown. Drives the "[+N (other) subcommands]" line. */
  otherSubcommandCount?: number;
}

export interface BranchHelp {
  name: string;
  /** The command's own description — rendered as the `description` attribute of
   *  its <command> card at its own -h. */
  summary: string;
  /** Local model prose orienting the agent to what the subtree contains and how
   *  the children differ as a group — never a per-child restatement (each
   *  child's purpose lives in its own listing row). */
  model?: string;
  /** Bounded runtime aggregate as a complete self-named state element (build
   *  it with stateBlock), e.g. `<kinds count="7">…</kinds>`. Renderer
   *  soft-fails to omission if this returns null or throws. */
  dynamicState?: () => string | null;
  /** Parent-level listing assembled by defineBranch from the actual child defs.
   *  renderBranch reads this; never author it by hand. */
  listing?: ListingChild[];
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
  /** Bounded runtime aggregate as a complete self-named state element (build it
   *  with stateBlock), e.g. `<kinds count="7">…</kinds>`. Lazily evaluated at
   *  render time so it reflects the caller's cwd/project scope; appended after
   *  the schema. Renderer soft-fails to omission if it returns null or throws.
   *  Mirrors BranchHelp.dynamicState. */
  dynamicState?: () => string | null;
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
// contract, never to guess, AND reads a command's contract before invoking it.
// Lives in the root guide, outside any leaf -h.
const CAPABILITY_DISCOVERY =
  'Before running a crtr command whose exact contract (args, flags, effects) ' +
  "you haven't verified this session, run `-h` on it and read the schema first " +
  '— a reliable read beats a guess that wastes a turn or triggers an unintended ' +
  "effect. Same when the user names a capability you don't fully recognize: " +
  '`-h` it before acting.';

/** Lines for a command's subcommand affordance at root: any promoted
 *  (common/important) subcommands, then a remainder line naming how many other
 *  subcommands exist behind `crtr <name> -h`. Returns [] when the command has
 *  no listable subcommands at all. */
function rootSubcommandLines(c: RootCommand): string[] {
  const promoted = c.subcommands ?? [];
  const other = c.otherSubcommandCount ?? 0;
  if (promoted.length === 0 && other === 0) return [];

  const out: string[] = [];
  if (promoted.length > 0) {
    const labelW = maxLen(promoted.map((s) => s.path));
    for (const s of promoted) {
      // important → padded name + shortform desc; common → bare name.
      out.push(
        s.desc !== undefined && s.desc !== ''
          ? `  ${pad(s.path, labelW)}  ${s.desc}`
          : `  ${s.path}`,
      );
    }
  }
  if (other > 0) {
    const word = promoted.length > 0 ? 'other subcommand' : 'subcommand';
    out.push(`  [+${other} ${word}${other === 1 ? '' : 's'} — \`crtr ${c.name} -h\`]`);
  }
  return out;
}

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
    // The command's subcommand surface: promoted (common/important) children
    // inline, plus a "[+N other subcommands]" pointer to its own -h. Sits
    // between the selection rubric and any live state block.
    for (const l of rootSubcommandLines(c)) lines.push(l);
    // dynamicState returns a complete self-named element (e.g.
    // <kinds count="7">…</kinds>) — emit it as-is, nested in the command.
    const state = evalDynamic(c.dynamicState);
    if (state !== null) lines.push(state);
    lines.push('</command>');
    lines.push('');
  }

  // Globals block (footer) — rendered only when globals exist, so an empty
  // list never leaves a bare "Globals" header. -h itself is not a global: the
  // capability-discovery rule below teaches -h usage with its reasoning, so no
  // per-command CTA or standalone "-h: print help" stub is needed.
  if (h.globals.length > 0) {
    lines.push('Globals');
    const gNameW = maxLen(h.globals.map((g) => g.name));
    for (const g of h.globals) {
      lines.push(`  ${pad(g.name, gNameW)}  ${g.desc}`);
    }
    lines.push('');
  }

  lines.push(IO_CONTRACT);
  lines.push('');
  lines.push(CAPABILITY_DISCOVERY);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderBranch
// ---------------------------------------------------------------------------

/** Escape a value for a rendered XML attribute. Output is light XML around
 *  markdown read as prose by a model, not parsed — so we only guard the
 *  double-quote that would visually break the attribute, swapping it for a
 *  single quote rather than emitting noisy entities. */
function attr(s: string): string {
  return s.replace(/"/g, "'");
}

export function renderBranch(h: BranchHelp): string {
  const lines: string[] = [];

  // The branch renders as one <command> card: its own description in the
  // opening attribute, then orientation prose / live state, then one
  // self-closing <subcommand> per child. Each child's description + whenToUse
  // are assembled by defineBranch from the child's own self-description, so the
  // parent never restates what a child is — the child owns its representation.
  lines.push(`<command name="${h.name}" description="${attr(h.summary)}">`);

  const branchState = evalDynamic(h.dynamicState);
  if (branchState !== null) lines.push(branchState);
  if (h.model !== undefined) lines.push(h.model);

  for (const c of h.listing ?? []) {
    if (c.tier === 'hidden') continue;
    const subs = c.subCount !== undefined && c.subCount > 0 ? ` subcommands="${c.subCount}"` : '';
    // whenToUse plainly states when to reach for this child, rendered verbatim —
    // expansive with examples for judgment-heavy commands, concise for
    // single-purpose ones. It does not restate "read my -h"; the
    // capability-discovery rule in the root footer already teaches that.
    lines.push(
      `<subcommand name="${c.name}" description="${attr(c.description)}" whenToUse="${attr(
        c.whenToUse,
      )}"${subs}/>`,
    );
  }

  lines.push('</command>');
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

  // Optional bounded runtime-state block (e.g. the live <kinds> list), appended
  // after the schema. Soft-fails to omission on null/throw, mirroring renderBranch.
  const state = evalDynamic(h.dynamicState);
  if (state !== null) {
    lines.push('');
    lines.push(state);
  }

  return lines.join('\n');
}
