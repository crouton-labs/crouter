// Shared constants + helpers for the `crtr memory` command family (task B2).
// The leaf handlers (list/read/find/write) consume the resolver, substrate
// schema, scope, and skill-resolver modules and build their documented output
// objects on top of the small helpers here. Nothing in this file forks on kind
// or re-implements the schema/gate/resolver — it only composes them.

import { join } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { Scope } from '../../types.js';
import { usage } from '../../core/errors.js';
import {
  scopeMemoryDir,
  projectScopeRoot,
  ensureProjectScopeRoot,
} from '../../core/scope.js';

// The three memory kinds — procedural (skill), referential (reference),
// preferential (preference). Used as the `--kind` enum choices everywhere.
export const MEMORY_KINDS = ['skill', 'reference', 'preference'] as const;

// Visibility rungs — how much of a document surfaces (none → name → preview →
// content). Shared by --system-prompt-visibility and --file-read-visibility.
export const VISIBILITY_RUNGS = ['none', 'name', 'preview', 'content'] as const;

// Scope choices for filtering / targeting (builtin is read-only, not writable).
export const MEMORY_SCOPES = ['user', 'project'] as const;

/** Scope sort weight matching resolution precedence (project > user > builtin).
 *  Used by `list` for its "scope then kind then name" ordering. */
export function scopeRank(scope: Scope): number {
  return scope === 'project' ? 0 : scope === 'user' ? 1 : 2;
}

/** Resolve the write target scope + its memory dir. Default: project when a
 *  project scope exists for the cwd, else user. An explicit `--scope project`
 *  with no project scope yet scaffolds one (ensureProjectScopeRoot). User scope
 *  always resolves. Returns the absolute `<root>/memory` dir to write under. */
export function resolveWriteTarget(scopeArg: string | undefined): {
  scope: Scope;
  memoryDir: string;
} {
  let scope: Scope;
  if (scopeArg === 'user' || scopeArg === 'project') {
    scope = scopeArg;
  } else if (scopeArg !== undefined) {
    throw usage(`invalid --scope: ${scopeArg} (expected user|project)`);
  } else {
    scope = projectScopeRoot() !== null ? 'project' : 'user';
  }

  let memoryDir = scopeMemoryDir(scope);
  if (!memoryDir && scope === 'project') {
    // Explicit --scope project with no project root yet → scaffold it.
    memoryDir = join(ensureProjectScopeRoot(), 'memory');
  }
  if (!memoryDir) throw usage(`no ${scope} scope available for writing memory documents`);
  return { scope, memoryDir };
}

/** Map a path-derived name (`topic` or `area/topic`) to its file path under a
 *  memory dir, guarding against traversal/absolute escapes. */
export function memoryFilePath(memoryDir: string, name: string): string {
  const segments = name.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw usage('memory document name required');
  if (segments.some((s) => s === '.' || s === '..')) {
    throw usage(`invalid memory document name: ${name}`);
  }
  return join(memoryDir, ...segments) + '.md';
}

/** Coerce a `--gate` string into a predicate tree. The gate field MUST be a
 *  YAML/JSON object (the field→matcher map the schema expects). Throws a usage
 *  error when the input fails to parse or does not parse to a non-null,
 *  non-array object — a scalar or array gate silently makes a doc never-eligible
 *  (the matcher engine ignores non-object predicates), so passing one is always
 *  a mistake and must be caught at authoring time rather than stored. */
function parseYamlObject(raw: string): Record<string, unknown> | string {
  const parsed = yamlParse(raw) as unknown;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return `expected an object, got ${JSON.stringify(parsed)}`;
}

export function coerceGate(raw: string): Record<string, unknown> {
  const result = parseYamlObject(raw);
  if (typeof result === 'string') {
    throw usage(
      `--gate must be a YAML/JSON object (field→matcher map): ${result}. ` +
        `Example: --gate '{kind: design}' or --gate '{orchestration.depth: {gte: 2}}'`,
    );
  }
  return result;
}

/** Coerce a `--applies-to` string to the schema's glob form: a comma-separated
 *  list becomes an array, a single glob stays a string. */
export function coerceAppliesTo(raw: string): unknown {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return raw;
  return parts.length === 1 ? parts[0] : parts;
}

// Canonical frontmatter field order for a substrate document. Known fields come
// first in this order; any preserved-on-update extras append after.
const FRONTMATTER_ORDER = [
  'kind',
  'when',
  'why',
  'short-form',
  'system-prompt-visibility',
  'file-read-visibility',
  'gate',
  'applies-to',
];

/** Serialize a substrate frontmatter record + body into a complete `.md`
 *  document. Frontmatter is emitted as a `---` fenced YAML block (the `yaml`
 *  package — the same one the parser uses — so nested gate maps and applies-to
 *  arrays round-trip), in canonical field order with preserved extras last. The
 *  skill-shaped `serializeFrontmatter` in core can only represent
 *  name/description/type/keywords, so it cannot carry the substrate fields —
 *  hence this focused serializer. */
export function serializeMemoryDoc(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_ORDER) {
    if (frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  for (const key of Object.keys(frontmatter)) {
    if (!(key in ordered) && frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  const yamlText = yamlStringify(ordered).replace(/\n+$/, '');
  const cleanBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}
