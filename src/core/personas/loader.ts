/**
 * Persona file loader.
 *
 * Discovers and parses persona markdown files with YAML frontmatter.
 * Resolution order (highest → lowest precedence): project > user > builtin.
 *
 * Layout on disk:
 *   <root>/personas/<kind>/PERSONA.md
 *   <root>/personas/<kind>/orchestrator.md
 *   <root>/personas/orchestration-kernel.md
 *   <root>/personas/<kind>/<...>/PERSONA.md   (nested sub-personas)
 *
 * The builtin root is src/builtin-personas (or dist/builtin-personas in the
 * compiled build), resolved relative to this module — mirrors the pattern used
 * for STOPHOOK_PATH in spawn.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatterGeneric } from '../frontmatter.js';
import { userScopeRoot, findProjectScopeRoot } from '../scope.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// Builtin root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the builtin-personas directory from the location of this compiled
 * or source module. Works from both `dist/core/personas/loader.js` and
 * `src/core/personas/loader.ts` (tsx dev runs).
 */
function builtinPersonasRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/core/personas or src/core/personas
  const coreDir = dirname(here); // dist/core or src/core
  const pkgDir = dirname(coreDir); // dist/ or src/

  const distPath = join(pkgDir, 'builtin-personas');
  const srcPath = join(dirname(pkgDir), 'src', 'builtin-personas');

  // Prefer the path that exists; fall back to the dist-sibling (which may not
  // exist yet if the package is being run pre-build, but that is the caller's
  // problem).
  if (existsSync(distPath)) return distPath;
  if (existsSync(srcPath)) return srcPath;
  return distPath;
}

// ---------------------------------------------------------------------------
// Scope roots for personas
// ---------------------------------------------------------------------------

/** Returns the ordered list of roots to search, highest precedence first. */
interface PersonaSearchRoot {
  scope: Scope;
  root: string;
}

function personaSearchRoots(): PersonaSearchRoot[] {
  const roots: PersonaSearchRoot[] = [];

  const projectRoot = findProjectScopeRoot();
  if (projectRoot) roots.push({ scope: 'project', root: join(projectRoot, 'personas') });

  roots.push({ scope: 'user', root: join(userScopeRoot(), 'personas') });
  roots.push({ scope: 'builtin', root: builtinPersonasRoot() });

  return roots;
}

// ---------------------------------------------------------------------------
// Frontmatter scalar coercion
// ---------------------------------------------------------------------------

/** Coerce a frontmatter scalar to its string form, matching the legacy
 *  hand-rolled parser (which stringified every scalar). Strings pass through;
 *  number/boolean coerce via String(); null/undefined and non-scalars
 *  (objects/arrays) are dropped (→ null). The `yaml` package returns native
 *  scalar types, so without this a `typeof === 'string'` guard would silently
 *  DROP a numeric/boolean frontmatter value (e.g. blanking a menu line) where
 *  the old parser kept its stringified form. */
function scalarToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

// ---------------------------------------------------------------------------
// File resolution helpers
// ---------------------------------------------------------------------------

/**
 * Find the first existing file across the scope roots.
 * `relativePath` is relative to each root (e.g. 'general/PERSONA.md').
 */
export interface ResolvedPersonaSource {
  path: string;
  scope: Scope;
}

function resolveFileMeta(relativePath: string): ResolvedPersonaSource | null {
  for (const { scope, root } of personaSearchRoots()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return { path: candidate, scope };
  }
  return null;
}

function resolveFile(relativePath: string): string | null {
  return resolveFileMeta(relativePath)?.path ?? null;
}

// ---------------------------------------------------------------------------
// @include inlining
// ---------------------------------------------------------------------------

const INCLUDE_RE = /^@include\s+(\S+)\s*$/m;

/**
 * Inline any `@include <filename>` directive found in `body`.
 * The included file is looked up via the same scope-resolution chain; if it
 * cannot be found, the directive line is replaced with an empty string rather
 * than throwing — callers that need the kernel should use `loadKernel()`
 * directly and can assert it themselves.
 */
function inlineIncludes(body: string): string {
  return body.replace(INCLUDE_RE, (_match, filename: string) => {
    const path = resolveFile(filename as string);
    if (!path) return '';
    const src = readFileSync(path, 'utf8');
    // The kernel file has no frontmatter, but run through the parser just in
    // case someone added one in a user/project override.
    const { body: kernelBody } = parseFrontmatterGeneric(src);
    return kernelBody.trim();
  });
}

export function loadScopedText(relativePath: string): { text: string; sourcePath: string; scope: Scope } | null {
  const meta = resolveFileMeta(relativePath);
  if (!meta) return null;
  const src = readFileSync(meta.path, 'utf8');
  const { body } = parseFrontmatterGeneric(src);
  return { text: body.trim(), sourcePath: meta.path, scope: meta.scope };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The role-body filename for every kind/sub-persona (replaces legacy base.md). */
const PERSONA_FILE = 'PERSONA.md';

export interface LoadedPersona {
  /** Raw, uncoerced frontmatter key/value record (null when no frontmatter). */
  frontmatter: Record<string, unknown> | null;
  /** Body text with any @include directives inlined. */
  body: string;
}

export interface LoadedPersonaSource extends LoadedPersona {
  /** Raw body text before @include expansion. */
  rawBody: string;
  /** Absolute source path. */
  sourcePath: string;
  /** Scope the file was resolved from. */
  scope: Scope;
  /** Relative source path within the scope root, e.g. `personas/developer/PERSONA.md`. */
  source: string;
}

/**
 * Load and parse a persona file for the given `kind` and `mode`.
 *
 * Returns `null` when no file is found in any scope (project/user/builtin).
 * On success, `@include` directives in the body are resolved and inlined.
 */
export function loadPersona(kind: string, mode: 'base' | 'orchestrator'): LoadedPersona | null {
  const source = loadPersonaSource(kind, mode);
  if (!source) return null;
  return { frontmatter: source.frontmatter, body: source.body };
}

/** Load a persona file together with its provenance. */
export function loadPersonaSource(kind: string, mode: 'base' | 'orchestrator'): LoadedPersonaSource | null {
  const relativePath = mode === 'orchestrator' ? `${kind}/orchestrator.md` : `${kind}/PERSONA.md`;
  const file = resolveFileMeta(relativePath);
  if (!file) return null;

  const src = readFileSync(file.path, 'utf8');
  const { data, body } = parseFrontmatterGeneric(src);
  return {
    frontmatter: data,
    rawBody: body.trim(),
    body: inlineIncludes(body).trim(),
    sourcePath: file.path,
    scope: file.scope,
    source: `personas/${relativePath}`,
  };
}

/**
 * Load the raw text of the orchestration kernel (no frontmatter, body only).
 * Returns an empty string if the kernel file cannot be found.
 */
export function loadKernel(): string {
  const file = loadKernelSource();
  return file?.text ?? '';
}

export function loadKernelSource(): { text: string; sourcePath: string; scope: Scope } | null {
  return loadScopedText('orchestration-kernel.md');
}

/**
 * Load the base runtime prompt — the node operating protocol prepended to
 * EVERY persona (delegate/ask/promote). Returns '' if not found. The
 * lifecycle/spine-specific sections (finish vs. dormant, report-up vs. silent)
 * live in their own fragments, loaded below.
 */
export function loadRuntimeBase(): string {
  return loadRuntimeBaseSource()?.text ?? '';
}

export function loadRuntimeBaseSource(): { text: string; sourcePath: string; scope: Scope } | null {
  return loadScopedText('runtime-base.md');
}

/**
 * Load the waiting fragment — the cross-kind "waiting is a way to end a turn"
 * operating posture (arm a wake + go dormant instead of busy-looping or
 * finishing-to-stop). Spliced into every node's baked prompt immediately after
 * the lifecycle fragment (resolve.ts). Returns '' if the fragment is missing.
 */
export function loadWaitingFragment(): string {
  return loadWaitingFragmentSource()?.text ?? '';
}

export function loadWaitingFragmentSource(): { text: string; sourcePath: string; scope: Scope } | null {
  return loadScopedText('waiting.md');
}

/**
 * Load the lifecycle fragment — the "how you end" contract, keyed on the node's
 * lifecycle axis: `terminal` (drive to done + `push final`) or `resident`
 * (dormant/wake, never forced to submit). Single source for both the baked-in
 * system prompt (resolve) and the transition guidance (runtime/persona.ts).
 * Returns '' if the fragment file cannot be found.
 */
export function loadLifecycleFragment(lifecycle: 'terminal' | 'resident'): string {
  return loadLifecycleFragmentSource(lifecycle)?.text ?? '';
}

export function loadLifecycleFragmentSource(
  lifecycle: 'terminal' | 'resident',
): { text: string; sourcePath: string; scope: Scope } | null {
  return loadScopedText(`lifecycle/${lifecycle}.md`);
}

/**
 * Load the spine fragment — the "who you report to" contract, keyed on whether
 * the node has a manager (anyone it reports up to). `has-manager` teaches the
 * `push update`/`push urgent`/escalate verbs; `no-manager` (a top-of-spine root)
 * omits the push family entirely — it answers to the human directly.
 * Returns '' if the fragment file cannot be found.
 */
export function loadSpineFragment(hasManager: boolean): string {
  return loadSpineFragmentSource(hasManager)?.text ?? '';
}

export function loadSpineFragmentSource(
  hasManager: boolean,
): { text: string; sourcePath: string; scope: Scope } | null {
  return loadScopedText(`spine/${hasManager ? 'has-manager' : 'no-manager'}.md`);
}

/**
 * Enumerate the kinds with at least one persona file (PERSONA.md or
 * orchestrator.md) across all scope roots (project/user/builtin). Used to
 * validate a requested `--kind` and to list the valid choices. Only the
 * IMMEDIATE children of each root count — nested sub-personas never pollute
 * the global kind list (see subPersonasFor).
 */
export function availableKinds(): string[] {
  const kinds = new Set<string>();
  for (const { root } of personaSearchRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, PERSONA_FILE)) || existsSync(join(dir, 'orchestrator.md'))) {
        kinds.add(entry.name);
      }
    }
  }
  return [...kinds].sort();
}

/**
 * The one-line "when to use this node type" gloss for `kind`, read from its
 * `<kind>/PERSONA.md` `whenToUse` frontmatter (resolved project > user >
 * builtin). Returns '' when the kind has no PERSONA.md or no `whenToUse`.
 * Drives the dynamic kind list in `node new -h` / `node promote -h`.
 */
export function kindWhenToUse(kind: string): string {
  const filePath = resolveFile(`${kind}/${PERSONA_FILE}`);
  if (!filePath) return '';
  const { data } = parseFrontmatterGeneric(readFileSync(filePath, 'utf8'));
  return scalarToString(data?.['whenToUse']) ?? '';
}

export interface SubPersona {
  /** Full kind string to spawn, e.g. 'plan/reviewers/security'. */
  kind: string;
  /** Leaf name, e.g. 'security'. */
  name: string;
  /** One-line "when to use", from the sub-persona PERSONA.md `whenToUse` frontmatter (or ''). */
  whenToUse: string;
}

/** Recursively yield every dir under `dir` (inclusive) that holds a PERSONA.md,
 *  with `relKind` = the dir's path relative to the scope root (slash-joined).
 *  Dirs WITHOUT a PERSONA.md (e.g. a `reviewers/` grouping namespace) are
 *  transparent — they yield nothing themselves but are still descended into,
 *  so `plan/reviewers/security` keeps that exact kind string. */
function* walkPersonaDirs(dir: string, relParts: string[]): Generator<{ relKind: string; file: string }> {
  const file = join(dir, PERSONA_FILE);
  if (existsSync(file)) yield { relKind: relParts.join('/'), file };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* walkPersonaDirs(join(dir, entry.name), [...relParts, entry.name]);
  }
}

/** Parse a sub-persona's `availableTo` frontmatter into its availability set.
 *  Returns the wildcard sentinel `'*'` for `"*"`/`"all"` (scalar or in an
 *  array), an explicit list of kind strings when present, else the default
 *  `[topKind]` (the top-level ancestor kind). */
function parseAvailableTo(data: Record<string, unknown> | null, topKind: string): string[] | '*' {
  const isWild = (s: string): boolean => {
    const t = s.trim().toLowerCase();
    return t === '*' || t === 'all';
  };
  const v = data ? data['availableTo'] : undefined;
  if (v === undefined) return [topKind];
  const scalar = scalarToString(v);
  if (scalar !== null) return isWild(scalar) ? '*' : [scalar];
  if (Array.isArray(v)) {
    const arr = v.map(scalarToString).filter((x): x is string => x !== null);
    if (arr.some(isWild)) return '*';
    return arr.length > 0 ? arr : [topKind];
  }
  return [topKind];
}

/**
 * Enumerate the sub-personas AVAILABLE TO `kind` — the nested specialist
 * personas (e.g. `plan/reviewers/security`) a `kind` node may spawn, surfaced
 * in its composed prompt (resolve.ts) and nowhere else.
 *
 * A sub-persona is any descendant dir (ANY depth) under a top-level kind dir
 * that holds a PERSONA.md, EXCLUDING the top-level PERSONA.md itself. Its
 * availability is its `availableTo` frontmatter: an explicit list of kind
 * strings, or the wildcard `"*"`/`"all"` (visible to every kind); absent, it
 * defaults to its own top-level ancestor kind. So the five `plan/reviewers/*`
 * (no `availableTo`) are visible only to `plan`, while a sub-persona under
 * `developer/` can declare `availableTo: [plan]` to surface in plan's menu —
 * which is why ALL top-level kinds' descendants are scanned, not just `<kind>/`.
 *
 * Sub-personas are intentionally NOT global kinds: `availableKinds()` scans only
 * the immediate children of each root, so a nested sub-persona never leaks into
 * the global list; it is reachable only by its full kind string. Precedence is
 * project > user > builtin keyed on the FULL kind string — the highest root that
 * defines a given kind string wins (and owns its `availableTo`).
 */
export function subPersonasFor(kind: string): SubPersona[] {
  const seen = new Set<string>(); // full kind strings already resolved (higher root won)
  const out: SubPersona[] = [];
  for (const { root } of personaSearchRoots()) {
    if (!existsSync(root)) continue;
    for (const top of readdirSync(root, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      const topKind = top.name;
      for (const { relKind, file } of walkPersonaDirs(join(root, topKind), [topKind])) {
        if (relKind === topKind) continue; // the top-level PERSONA.md is the kind itself, not a sub-persona
        if (seen.has(relKind)) continue; // a higher root already resolved this kind string
        seen.add(relKind);
        const { data } = parseFrontmatterGeneric(readFileSync(file, 'utf8'));
        const availableTo = parseAvailableTo(data, topKind);
        if (availableTo !== '*' && !availableTo.includes(kind)) continue;
        const whenToUse = scalarToString(data?.['whenToUse']) ?? '';
        out.push({ kind: relKind, name: relKind.split('/').pop()!, whenToUse });
      }
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind));
}
