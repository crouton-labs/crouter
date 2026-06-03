// Registration kit for the agent-first crtr CLI.
// Hand-rolled path walker — no commander. Rationale: the spec requires flags
// and positional args on input (argv model). Commander's abstraction is more
// complexity than a plain array walk for this interface contract.
// A plain array walk + a small flag parser is ~120 lines and has no surprising
// edge cases.

import { renderRoot, renderBranch, renderLeafArgv } from './help.js';
import type { RootHelp, RootEntry, BranchHelp, LeafHelp, InputParam, FlagParam } from './help.js';
import { readStdinRaw, emit, handle, setJsonOutput, isJsonOutput } from './io.js';
import { renderResult } from './render.js';
import { CrtrError } from './errors.js';
import { ExitCode } from '../types.js';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Opt-in flag that surfaces a node as an editor slash command (a pi prompt
 *  template / Claude Code command). When set, the bootstrap auto-writes a
 *  markdown template named `<name>.md` to the host's command dirs on each crtr
 *  run, so `/name` becomes available. The body is thin — it points the agent at
 *  the live `crtr` workflow so the CLI stays the source of truth. */
export interface SlashSpec {
  /** Command name → `/<name>` and the template filename. */
  name: string;
  /** Frontmatter description shown in the autocomplete dropdown. */
  description: string;
  /** Optional autocomplete hint, e.g. `<url>` or `[topic]`. */
  argumentHint?: string;
  /** Markdown body (no frontmatter). Bootstrap wraps it with frontmatter + a
   *  version marker. Use `$ARGUMENTS` for the invocation's free text. */
  body: string;
}

export interface LeafDef {
  kind: 'leaf';
  name: string;
  help: LeafHelp;
  /** Opt into editor slash-command exposure (see SlashSpec). */
  slash?: SlashSpec;
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /** Optional bespoke renderer: turn the result into instruction-shaped
   *  XML+markdown the agent acts on. Omit to fall back to the schema-driven
   *  generic renderer. Ignored when `--json` is set. */
  render?: (result: Record<string, unknown>) => string;
}

export interface BranchDef {
  kind: 'branch';
  name: string;
  help: BranchHelp;
  /** How this subtree represents itself one level up. Present on top-level
   *  subtrees (assembled into root -h by defineRoot); omitted on nested
   *  branches, whose parent representation is the branch's own children list. */
  rootEntry?: RootEntry;
  /** Opt into editor slash-command exposure (see SlashSpec). */
  slash?: SlashSpec;
  children: (LeafDef | BranchDef)[];
}

export interface RootDef {
  kind: 'root';
  help: RootHelp;
  subtrees: BranchDef[];
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function defineLeaf(opts: {
  name: string;
  help: LeafHelp;
  slash?: SlashSpec;
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  render?: (result: Record<string, unknown>) => string;
}): LeafDef {
  return {
    kind: 'leaf',
    name: opts.name,
    help: opts.help,
    slash: opts.slash,
    run: opts.run,
    render: opts.render,
  };
}

export function defineBranch(opts: {
  name: string;
  help: BranchHelp;
  rootEntry?: RootEntry;
  slash?: SlashSpec;
  children: (LeafDef | BranchDef)[];
}): BranchDef {
  return {
    kind: 'branch',
    name: opts.name,
    help: opts.help,
    rootEntry: opts.rootEntry,
    slash: opts.slash,
    children: opts.children,
  };
}

/** Walk the whole tree and collect every node's SlashSpec (depth-first). Used
 *  by the bootstrap to discover which commands opted into slash exposure. */
export function collectSlashSpecs(root: RootDef): SlashSpec[] {
  const out: SlashSpec[] = [];
  const visit = (node: BranchDef | LeafDef): void => {
    if (node.slash !== undefined) out.push(node.slash);
    if (node.kind === 'branch') for (const c of node.children) visit(c);
  };
  for (const s of root.subtrees) visit(s);
  return out;
}

/** Assemble root -h from the subtrees themselves. Root owns only the tagline
 *  and globals; every subtree's concept line, selection rubric, and dynamic
 *  block come from its own RootEntry. A subtree without a rootEntry does not
 *  appear in root -h — declaring the parent-level representation is how a
 *  subtree opts into being listed. */
export function defineRoot(opts: {
  tagline: string;
  globals: { name: string; desc: string }[];
  subtrees: BranchDef[];
}): RootDef {
  // Each listed subtree becomes one <name> block at root, assembled straight
  // from its RootEntry. Root composes nothing and hardcodes nothing: add a
  // subtree with a rootEntry and it surfaces; its concept, rubric, state tag,
  // and dynamic block all travel with it.
  const commands = opts.subtrees
    .filter((s) => s.rootEntry !== undefined)
    .map((s) => ({
      name: s.name,
      concept: s.rootEntry!.concept,
      desc: s.rootEntry!.desc,
      useWhen: s.rootEntry!.useWhen,
      dynamicState: s.rootEntry!.dynamicState,
    }));

  const help: RootHelp = {
    tagline: opts.tagline,
    commands,
    globals: opts.globals,
  };
  return { kind: 'root', help, subtrees: opts.subtrees };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type AnyNode = RootDef | BranchDef | LeafDef;

/** Validate and return child names for an unknown-path error. */
function childNames(node: AnyNode): string[] {
  if (node.kind === 'root') return node.subtrees.map((s) => s.name);
  if (node.kind === 'branch') return node.children.map((c) => c.name);
  return [];
}

/** Walk argv tokens to the deepest matched node.
 *  Returns { node, path, remaining } where path is the sequence of matched node
 *  names from root (excluding root itself) and remaining are unconsumed tokens.
 *  -h / --help tokens are NOT consumed here — the caller checks for them. */
export function walk(
  root: RootDef,
  tokens: string[],
): { node: AnyNode; path: string[]; remaining: string[] } {
  let current: AnyNode = root;
  const path: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // Stop consuming on -h / --help — leave them for caller to detect
    if (token === '-h' || token === '--help') break;
    if (current.kind === 'root') {
      const nextNode: BranchDef | undefined = current.subtrees.find((s) => s.name === token);
      if (nextNode === undefined) break;
      current = nextNode;
      path.push(nextNode.name);
      i++;
    } else if (current.kind === 'branch') {
      const nextNode: LeafDef | BranchDef | undefined = current.children.find((c) => c.name === token);
      if (nextNode === undefined) break;
      current = nextNode;
      path.push(nextNode.name);
      i++;
    } else {
      // leaf — cannot descend further
      break;
    }
  }
  return { node: current, path, remaining: tokens.slice(i) };
}

function renderNode(node: AnyNode): string {
  if (node.kind === 'root') return renderRoot(node.help);
  if (node.kind === 'branch') return renderBranch(node.help);
  return renderLeafArgv(node.help);
}

function helpRequested(remaining: string[]): boolean {
  return remaining.some((t) => t === '-h' || t === '--help');
}

/** Build a structured unknown-path error. Names valid children of the deepest
 *  matched node and names the entry command per the spec. The entry command is
 *  the full path to the matched node (not just its local name), so the recovery
 *  hint is a command that actually exists. No fuzzy matching. */
export function unknownPathError(node: AnyNode, path: string[], bad: string): CrtrError {
  const valid = childNames(node);
  const validStr = valid.length > 0 ? valid.join(', ') : '(none)';
  const entryCmd = path.length > 0 ? `crtr ${path.join(' ')} -h` : 'crtr -h';
  return new CrtrError(
    'unknown_path',
    `unknown subcommand: ${bad}`,
    ExitCode.USAGE,
    {
      received: bad,
      next: `Valid children: ${validStr}. Run \`${entryCmd}\` for the full list.`,
    },
  );
}

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

function parseArgvError(code: string, message: string, received?: string, field?: string, next?: string): CrtrError {
  return new CrtrError(code, message, ExitCode.USAGE, {
    received,
    field,
    next: next !== undefined ? next : 'Run the command with -h to see the parameter schema.',
  });
}

/** Convert kebab-case flag name to camelCase key. e.g. context-file → contextFile */
function flagNameToKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Parse remaining argv tokens against the leaf's InputParam schema.
 *  Returns a plain object whose keys are camelCase parameter names. */
export async function parseArgv(
  params: InputParam[],
  tokens: string[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  // Index params by kind for quick lookup
  const positionalParam = params.find((p) => p.kind === 'positional');
  const stdinParam = params.find((p) => p.kind === 'stdin');
  const contextFileParam = params.find((p) => p.kind === 'context-file');
  const flagParams = params.filter((p): p is FlagParam => p.kind === 'flag');
  const flagsByName = new Map<string, FlagParam>(flagParams.map((f) => [f.name, f]));

  // Apply defaults for bool flags
  for (const f of flagParams) {
    if (f.type === 'bool') {
      result[flagNameToKey(f.name)] = f.default !== undefined ? f.default : false;
    } else if (f.default !== undefined) {
      result[flagNameToKey(f.name)] = f.default;
    }
  }

  let positionalValue: string | undefined;
  let forcedPositional = false; // true after bare --
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '--' && !forcedPositional) {
      forcedPositional = true;
      i++;
      continue;
    }

    if (!forcedPositional && token.startsWith('--')) {
      // Flag: --name or --name=value
      const eqIdx = token.indexOf('=');
      let flagName: string;
      let inlineValue: string | undefined;

      if (eqIdx !== -1) {
        flagName = token.slice(2, eqIdx);
        inlineValue = token.slice(eqIdx + 1);
      } else {
        flagName = token.slice(2);
      }

      // --context-file is handled specially regardless of declared schema
      if (flagName === 'context-file') {
        if (contextFileParam === undefined) {
          throw parseArgvError('unknown_flag', `unknown flag: --context-file`, '--context-file',
            undefined, 'This leaf does not accept --context-file.');
        }
        const pathVal = inlineValue !== undefined ? inlineValue : tokens[++i];
        if (pathVal === undefined) {
          throw parseArgvError('missing_parameter', '--context-file requires a PATH argument',
            '--context-file', 'context-file');
        }
        let fileContent: string;
        try {
          fileContent = readFileSync(pathVal, 'utf8');
        } catch (err) {
          throw parseArgvError('invalid_type', `--context-file: cannot read file: ${pathVal}`,
            pathVal, 'context-file', 'Provide a readable file path.');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(fileContent);
        } catch {
          throw parseArgvError('invalid_type', `--context-file: file is not valid JSON: ${pathVal}`,
            pathVal, 'context-file', 'Ensure the file contains a valid JSON object.');
        }
        result[flagNameToKey(contextFileParam.name)] = parsed;
        i++;
        continue;
      }

      const flagDef = flagsByName.get(flagName);
      if (flagDef === undefined) {
        throw parseArgvError('unknown_flag', `unknown flag: --${flagName}`, `--${flagName}`,
          undefined, 'Use --<flag-name> for declared flags only. Run -h for the schema.');
      }

      const key = flagNameToKey(flagName);

      if (flagDef.type === 'bool') {
        if (inlineValue !== undefined) {
          throw parseArgvError('invalid_type', `boolean flag --${flagName} takes no value`,
            `--${flagName}=${inlineValue}`, flagName,
            `Use --${flagName} (presence = true) with no value.`);
        }
        result[key] = true;
        i++;
        continue;
      }

      const rawVal = inlineValue !== undefined ? inlineValue : tokens[++i];
      if (rawVal === undefined || rawVal.startsWith('--')) {
        throw parseArgvError('missing_parameter', `--${flagName} requires a value`,
          `--${flagName}`, flagName);
      }

      if (flagDef.type === 'int') {
        const n = Number(rawVal);
        if (!Number.isInteger(n)) {
          throw parseArgvError('invalid_type', `--${flagName} must be an integer`,
            rawVal, flagName, `Provide an integer value for --${flagName}.`);
        }
        result[key] = n;
      } else if (flagDef.type === 'enum') {
        const choices = flagDef.choices;
        if (choices !== undefined && !choices.includes(rawVal)) {
          throw parseArgvError('invalid_type',
            `--${flagName} must be one of: ${choices.join(', ')}`,
            rawVal, flagName, `Retry with one of: ${choices.join(', ')}.`);
        }
        result[key] = rawVal;
      } else {
        // string or path
        result[key] = rawVal;
      }
      i++;
      continue;
    }

    // Positional (or token after --)
    if (positionalValue !== undefined) {
      throw parseArgvError('bad_invocation',
        `unexpected extra positional argument: ${token}`,
        tokens.join(' '), undefined,
        'Use --flag for parameters; only one positional allowed.');
    }
    // A bare positional is accepted when the leaf declares a positional param,
    // OR when it declares a stdin param (the positional supplies the stdin
    // value as an ergonomic alternative to piping). Otherwise it's an error.
    if (positionalParam === undefined && stdinParam === undefined) {
      throw parseArgvError('bad_invocation',
        `this leaf takes no positional arguments: ${token}`,
        token, undefined,
        'Use --flag for parameters. Run -h for the schema.');
    }
    positionalValue = token;
    i++;
  }

  // Assign positional
  if (positionalValue !== undefined && positionalParam !== undefined) {
    result[flagNameToKey(positionalParam.name)] = positionalValue;
  }

  // Resolve stdin if declared. A positional token (when there's no dedicated
  // positional param to claim it) satisfies the stdin param directly, so
  // `crtr node new "Say hi"` works as well as piping on stdin.
  if (stdinParam !== undefined) {
    if (positionalValue !== undefined && positionalParam === undefined) {
      result[flagNameToKey(stdinParam.name)] = positionalValue;
    } else {
      const raw = await readStdinRaw();
      if (raw.trim() === '' && stdinParam.required) {
        throw parseArgvError('missing_parameter',
          `stdin is required for this leaf`,
          '', stdinParam.name,
          'Pipe the required content on stdin, or pass it as a positional argument.');
      }
      result[flagNameToKey(stdinParam.name)] = raw;
    }
  }

  // Validate required params
  for (const p of params) {
    const key = flagNameToKey(p.kind === 'context-file' ? p.name : p.name);
    if (p.required && (result[key] === undefined || result[key] === null)) {
      const display = p.kind === 'positional'
        ? `positional ${p.name.toUpperCase()}`
        : p.kind === 'flag'
        ? `--${p.name}`
        : p.kind === 'context-file'
        ? `--context-file`
        : 'stdin';
      throw parseArgvError('missing_parameter',
        `required parameter is missing: ${display}`,
        undefined, p.name,
        `Provide ${display}. Run -h for the schema.`);
    }
  }

  return result;
}

export async function runCli(root: RootDef, argv: string[]): Promise<void> {
  // argv is process.argv — strip node binary + script path. `--json` is a
  // global: pull it out anywhere it appears so the rest of argv parses against
  // the leaf schema unchanged, and switch stdout from rendered prose to raw
  // JSON. It is intentionally undocumented — the default prose output is the
  // agent contract; --json exists only for programmatic/tooling consumers.
  const rawTokens = argv.slice(2);
  const tokens = rawTokens.filter((t) => t !== '--json');
  if (tokens.length !== rawTokens.length) setJsonOutput(true);

  // Bare root invocation or -h at root
  if (tokens.length === 0 || (tokens.length === 1 && (tokens[0] === '-h' || tokens[0] === '--help'))) {
    process.stdout.write(renderRoot(root.help) + '\n');
    process.exit(ExitCode.SUCCESS);
  }

  const { node, path, remaining } = walk(root, tokens);

  try {
    // Help anywhere in remaining tokens → print node help and exit
    if (helpRequested(remaining)) {
      process.stdout.write(renderNode(node) + '\n');
      process.exit(ExitCode.SUCCESS);
    }

    // Bare branch or bare root (no -h, but no leaf selected) → help surface
    if (node.kind === 'root' || node.kind === 'branch') {
      if (remaining.length > 0) {
        throw unknownPathError(node, path, remaining[0]);
      }
      process.stdout.write(renderNode(node) + '\n');
      process.exit(ExitCode.SUCCESS);
    }

    // Leaf dispatch — argv input model only
    const params = node.help.params !== undefined ? node.help.params : [];
    const input = await parseArgv(params, remaining);

    const result = await node.run(input);
    if (result !== undefined && result !== null) {
      if (isJsonOutput()) {
        emit(result);
      } else {
        const text = node.render !== undefined ? node.render(result) : renderResult(result, node.help);
        process.stdout.write(text + '\n');
      }
    }
    // JSONL leaves call emitLine themselves and return void
  } catch (e) {
    handle(e);
  }
}
