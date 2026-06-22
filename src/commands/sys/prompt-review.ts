import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { InputError, readStdinRaw } from '../../core/io.js';
import { workspaceRoot } from '../../core/artifact.js';
import { getNode } from '../../core/canvas/index.js';
import { availableKinds, kindWhenToUse, subPersonasFor } from '../../core/personas/index.js';
import { resolvePromptReview, type PromptReviewConfig, type PromptReviewData, type PromptSource } from '../../core/personas/resolve.js';

interface PromptReviewList {
  kinds: { kind: string; whenToUse: string }[];
  modes: ['base', 'orchestrator'];
  lifecycles: ['terminal', 'resident'];
  subPersonas: Record<string, { kind: string; whenToUse: string }[]>;
}

interface PromptReviewExportInput {
  config: PromptReviewConfig;
  comments: {
    layerId: string;
    label: string;
    sourcePath: string | null;
    scope: string;
    anchor: string | null;
    body: string;
  }[];
  sources: PromptSource[];
}

function resolveLifecycle(mode: 'base' | 'orchestrator', lifecycle?: 'terminal' | 'resident'): 'terminal' | 'resident' {
  if (lifecycle !== undefined) return lifecycle;
  return mode === 'orchestrator' ? 'resident' : 'terminal';
}

function readJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new InputError({
      error: 'invalid_json',
      message: `stdin is not valid JSON: ${String(err)}`,
      field: 'stdin',
      next: 'Pass the comments deck JSON on stdin.',
    });
  }
}

function parseBool(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === true || value === false) return value;
  if (typeof value !== 'string') {
    throw new InputError({ error: 'invalid_field', message: `${field} must be true or false`, field, next: `Use true or false for ${field}.` });
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new InputError({ error: 'invalid_field', message: `${field} must be true or false`, field, next: `Use true or false for ${field}.` });
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function normaliseKindList(): { kind: string; whenToUse: string }[] {
  return availableKinds().map((kind) => ({ kind, whenToUse: kindWhenToUse(kind) }));
}

function normaliseSubPersonaList(kind: string): { kind: string; whenToUse: string }[] {
  return subPersonasFor(kind).map((sub) => ({ kind: sub.kind, whenToUse: sub.whenToUse }));
}

function reviewList(): PromptReviewList {
  const kinds = normaliseKindList();
  const subPersonas: Record<string, { kind: string; whenToUse: string }[]> = {};
  for (const { kind } of kinds) subPersonas[kind] = normaliseSubPersonaList(kind);
  return {
    kinds,
    modes: ['base', 'orchestrator'],
    lifecycles: ['terminal', 'resident'],
    subPersonas,
  };
}

function promptReviewPath(): string {
  const dir = workspaceRoot();
  const reviewsDir = join(dir, 'prompt-reviews');
  mkdirSync(reviewsDir, { recursive: true });
  return join(reviewsDir, `${new Date().toISOString()}.md`);
}

function renderExportDeck(deck: PromptReviewExportInput): string {
  const lines: string[] = [];
  lines.push(`# Prompt review — ${deck.config.kind}/${deck.config.mode}`);
  lines.push('');
  lines.push('## Config');
  lines.push(`- timestamp: ${new Date().toISOString()}`);
  lines.push(`- kind: ${deck.config.kind}`);
  lines.push(`- mode: ${deck.config.mode}`);
  lines.push(`- lifecycle: ${deck.config.lifecycle}`);
  lines.push(`- hasManager: ${String(deck.config.hasManager)}`);
  lines.push(`- node: ${deck.config.node ?? '(none)'}`);
  lines.push('');
  lines.push('## Comments');
  if (deck.comments.length === 0) {
    lines.push('- none');
  } else {
    for (const comment of deck.comments) {
      lines.push(`### ${comment.label} (${comment.layerId})`);
      lines.push(`- source: \`${comment.sourcePath ?? '(generated)'}\` (${comment.scope})`);
      if (comment.anchor !== null) {
        lines.push('> ' + comment.anchor.split('\n').join('\n> '));
      }
      lines.push(comment.body);
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
  }
  lines.push('');
  lines.push('## Prompt sources (edit these)');
  const seen = new Set<string>();
  for (const source of deck.sources) {
    const key = `${source.scope}:${source.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${source.label} — \`${source.path}\` (${source.scope})`);
  }
  lines.push('');
  lines.push('These are review comments on an assembled system prompt; edit the listed source files to address them.');
  return lines.join('\n') + '\n';
}

function exportReview(deck: PromptReviewExportInput): { path: string } {
  const path = promptReviewPath();
  writeFileSync(path, renderExportDeck(deck), 'utf8');
  return { path };
}

function resolveDeck(input: Record<string, unknown>): PromptReviewData {
  const kind = input['kind'] as string | undefined;
  const mode = (input['mode'] as 'base' | 'orchestrator' | undefined) ?? 'base';
  const lifecycle = resolveLifecycle(mode, input['lifecycle'] as 'terminal' | 'resident' | undefined);
  const hasManager = parseBool(input['hasManager'], 'hasManager', true);
  const node = optionalString(input['node']);

  if (kind === undefined || kind.trim() === '') {
    throw new InputError({ error: 'missing_parameter', message: 'kind is required', field: 'kind', next: 'Pass --kind <kind> or use --list.' });
  }

  return resolvePromptReview(kind, mode, {
    lifecycle,
    hasManager,
  }, node ?? undefined);
}

export const promptReviewLeaf = defineLeaf({
  name: 'prompt-review',
  description: 'inspect an assembled prompt and export review notes',
  whenToUse: 'you want to inspect a composed persona prompt for a kind/mode combo, compare the space around it, or export review notes back to source files',
  help: {
    name: 'sys prompt-review',
    summary: 'inspect an assembled prompt and export review notes',
    params: [
      { kind: 'positional', name: 'action', type: 'string', required: false, constraint: 'Optional subcommand: export. Omit for the assembled prompt contract.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'Persona kind to inspect. Required unless --list or export.' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode. Default: base.' },
      { kind: 'flag', name: 'lifecycle', type: 'enum', choices: ['terminal', 'resident'], required: false, constraint: 'Lifecycle axis. Default: base -> terminal, orchestrator -> resident.' },
      { kind: 'flag', name: 'has-manager', type: 'string', required: false, default: 'true', constraint: 'Whether the node reports to a manager. Use true or false. Default: true.' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Optional node id. When the node exists, runtime substrate layers are appended.' },
      { kind: 'flag', name: 'list', type: 'bool', required: false, constraint: 'List the available kinds, modes, lifecycles, and sub-personas.' },
    ],
    output: [
      { name: 'config', type: 'object', required: false, constraint: 'Resolved config: {kind, mode, lifecycle, hasManager, node}.' },
      { name: 'layers', type: 'object[]', required: false, constraint: 'Ordered prompt layers, including excluded alternatives and provenance.' },
      { name: 'assembled', type: 'string', required: false, constraint: 'The assembled prompt string.' },
      { name: 'total', type: 'object', required: false, constraint: 'Approximate token/char totals for included layers.' },
      { name: 'sources', type: 'object[]', required: false, constraint: 'De-duplicated source files referenced by the prompt.' },
      { name: 'kinds', type: 'object[]', required: false, constraint: 'Available kinds for --list.' },
      { name: 'modes', type: 'string[]', required: false, constraint: 'Mode choices for --list.' },
      { name: 'lifecycles', type: 'string[]', required: false, constraint: 'Lifecycle choices for --list.' },
      { name: 'subPersonas', type: 'object', required: false, constraint: 'Available sub-personas keyed by kind for --list.' },
      { name: 'path', type: 'string', required: false, constraint: 'Written markdown path for export.' },
    ],
    outputKind: 'object',
    effects: ['Read-only inspection, or writes a review markdown file under the per-cwd crouter root.'],
  },
  run: async (input) => {
    const action = input['action'] as string | undefined;
    const isList = input['list'] === true;
    const hasManager = parseBool(input['hasManager'], 'hasManager', true);

    if (action !== undefined && action !== 'export') {
      throw new InputError({ error: 'unknown_action', message: `unknown action: ${action}`, field: 'action', next: 'Use `export` or omit the positional action.' });
    }

    if (action === 'export') {
      const raw = await readStdinRaw();
      const deck = readJson<PromptReviewExportInput>(raw);
      return exportReview(deck) as unknown as Record<string, unknown>;
    }

    if (isList) return reviewList() as unknown as Record<string, unknown>;

    const deck = resolveDeck({ ...input, hasManager });
    return deck as unknown as Record<string, unknown>;
  },
});
