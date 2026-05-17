// Registration kit for the agent-first crtr CLI.
// Hand-rolled path walker — no commander. Rationale: the spec forbids flags
// (only -h/-help is recognized) and all input flows through stdin JSON. Commander's
// value is flag parsing, which is explicitly absent here; keeping it would require
// fully disabling its help+option system while adding its boot overhead for nothing.
// A plain array walk is ~30 lines and has no surprising edge cases.

import { renderRoot, renderBranch, renderLeaf } from './help.js';
import type { RootHelp, BranchHelp, LeafHelp } from './help.js';
import { readInput, emit, handle } from './io.js';
import { CrtrError } from './errors.js';
import { ExitCode } from '../types.js';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export interface LeafDef {
  kind: 'leaf';
  name: string;
  help: LeafHelp;
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
}

export interface BranchDef {
  kind: 'branch';
  name: string;
  help: BranchHelp;
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
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
}): LeafDef {
  return { kind: 'leaf', name: opts.name, help: opts.help, run: opts.run };
}

export function defineBranch(opts: {
  name: string;
  help: BranchHelp;
  children: (LeafDef | BranchDef)[];
}): BranchDef {
  return { kind: 'branch', name: opts.name, help: opts.help, children: opts.children };
}

export function defineRoot(opts: {
  help: RootHelp;
  subtrees: BranchDef[];
}): RootDef {
  return { kind: 'root', help: opts.help, subtrees: opts.subtrees };
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
 *  Returns { node, remaining } where remaining are unconsumed tokens.
 *  -h / --help tokens are NOT consumed here — the caller checks for them. */
function walk(
  root: RootDef,
  tokens: string[],
): { node: AnyNode; remaining: string[] } {
  let current: AnyNode = root;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // Stop consuming on -h / --help — leave them for caller to detect
    if (token === '-h' || token === '--help') break;
    if (current.kind === 'root') {
      const nextNode: BranchDef | undefined = current.subtrees.find((s) => s.name === token);
      if (nextNode === undefined) break;
      current = nextNode;
      i++;
    } else if (current.kind === 'branch') {
      const nextNode: LeafDef | BranchDef | undefined = current.children.find((c) => c.name === token);
      if (nextNode === undefined) break;
      current = nextNode;
      i++;
    } else {
      // leaf — cannot descend further
      break;
    }
  }
  return { node: current, remaining: tokens.slice(i) };
}

function renderNode(node: AnyNode): string {
  if (node.kind === 'root') return renderRoot(node.help);
  if (node.kind === 'branch') return renderBranch(node.help);
  return renderLeaf(node.help);
}

function helpRequested(remaining: string[]): boolean {
  return remaining.some((t) => t === '-h' || t === '--help');
}

/** Build a structured unknown-path error. Names valid children of the deepest
 *  matched node and names the entry command per the spec. No fuzzy matching. */
function unknownPathError(node: AnyNode, bad: string): CrtrError {
  const valid = childNames(node);
  const validStr = valid.length > 0 ? valid.join(', ') : '(none)';
  const entryCmd =
    node.kind === 'root'
      ? 'crtr -h'
      : node.kind === 'branch'
      ? `crtr ${node.name} -h`
      : 'crtr -h';
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

/** A leaf takes no positional/path tokens — every parameter is a stdin JSON
 *  field. A trailing token means a malformed call; surface it, never ignore it. */
function leafExtraTokenError(leaf: LeafDef, bad: string): CrtrError {
  return new CrtrError(
    'unknown_path',
    `\`${leaf.help.name}\` takes no positional arguments: ${bad}`,
    ExitCode.USAGE,
    {
      received: bad,
      next: `This leaf reads parameters only from a JSON object on stdin. Drop the trailing token and pipe input; run \`crtr ${leaf.help.name} -h\` for the schema.`,
    },
  );
}

export async function runCli(root: RootDef, argv: string[]): Promise<void> {
  // argv is process.argv — strip node binary + script path
  const tokens = argv.slice(2);

  // Bare root invocation or -h at root
  if (tokens.length === 0 || (tokens.length === 1 && (tokens[0] === '-h' || tokens[0] === '--help'))) {
    process.stdout.write(renderRoot(root.help) + '\n');
    process.exit(ExitCode.SUCCESS);
  }

  const { node, remaining } = walk(root, tokens);

  try {
    // Help anywhere in remaining tokens → print node help and exit
    if (helpRequested(remaining)) {
      process.stdout.write(renderNode(node) + '\n');
      process.exit(ExitCode.SUCCESS);
    }

    // Bare branch or bare root (no -h, but no leaf selected) → help surface
    if (node.kind === 'root' || node.kind === 'branch') {
      if (remaining.length > 0) {
        // There are unconsumed tokens that weren't recognized → unknown path
        throw unknownPathError(node, remaining[0]);
      }
      // No remaining → bare branch, print help
      process.stdout.write(renderNode(node) + '\n');
      process.exit(ExitCode.SUCCESS);
    }

    // Leaf with trailing non-help tokens → malformed call, never silently ignore
    if (remaining.length > 0) {
      throw leafExtraTokenError(node, remaining[0]);
    }

    // Leaf: execute
    const input = await readInput();
    const result = await node.run(input);
    if (result !== undefined && result !== null) {
      emit(result);
    }
    // JSONL leaves call emitLine themselves and return void — nothing to emit here
  } catch (e) {
    handle(e);
  }
}
