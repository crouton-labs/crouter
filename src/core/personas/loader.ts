/**
 * Persona file loader.
 *
 * Discovers and parses persona markdown files with YAML frontmatter.
 * Resolution order (highest → lowest precedence): project > user > builtin.
 *
 * Layout on disk:
 *   <root>/personas/<kind>/base.md
 *   <root>/personas/<kind>/orchestrator.md
 *   <root>/personas/orchestration-kernel.md
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
function personaSearchRoots(): string[] {
  const roots: string[] = [];

  const projectRoot = findProjectScopeRoot();
  if (projectRoot) roots.push(join(projectRoot, 'personas'));

  roots.push(join(userScopeRoot(), 'personas'));
  roots.push(builtinPersonasRoot());

  return roots;
}

// ---------------------------------------------------------------------------
// File resolution helpers
// ---------------------------------------------------------------------------

/**
 * Find the first existing file across the scope roots.
 * `relativePath` is relative to each root (e.g. 'general/base.md').
 */
function resolveFile(relativePath: string): string | null {
  for (const root of personaSearchRoots()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadedPersona {
  /** Raw, uncoerced frontmatter key/value record (null when no frontmatter). */
  frontmatter: Record<string, unknown> | null;
  /** Body text with any @include directives inlined. */
  body: string;
}

/**
 * Load and parse a persona file for the given `kind` and `mode`.
 *
 * Returns `null` when no file is found in any scope (project/user/builtin).
 * On success, `@include` directives in the body are resolved and inlined.
 */
export function loadPersona(kind: string, mode: 'base' | 'orchestrator'): LoadedPersona | null {
  const relativePath = `${kind}/${mode}.md`;
  const filePath = resolveFile(relativePath);
  if (!filePath) return null;

  const src = readFileSync(filePath, 'utf8');
  const { data, body } = parseFrontmatterGeneric(src);

  return {
    frontmatter: data,
    body: inlineIncludes(body).trim(),
  };
}

/**
 * Load the raw text of the orchestration kernel (no frontmatter, body only).
 * Returns an empty string if the kernel file cannot be found.
 */
export function loadKernel(): string {
  const filePath = resolveFile('orchestration-kernel.md');
  if (!filePath) return '';
  const src = readFileSync(filePath, 'utf8');
  const { body } = parseFrontmatterGeneric(src);
  return body.trim();
}

/**
 * Load the base runtime prompt — the node operating protocol prepended to
 * EVERY persona (delegate/ask/promote). Returns '' if not found. The
 * lifecycle/spine-specific sections (finish vs. dormant, report-up vs. silent)
 * live in their own fragments, loaded below.
 */
export function loadRuntimeBase(): string {
  const filePath = resolveFile('runtime-base.md');
  if (!filePath) return '';
  const src = readFileSync(filePath, 'utf8');
  const { body } = parseFrontmatterGeneric(src);
  return body.trim();
}

/**
 * Load the lifecycle fragment — the "how you end" contract, keyed on the node's
 * lifecycle axis: `terminal` (drive to done + `push final`) or `resident`
 * (dormant/wake, never forced to submit). Single source for both the baked-in
 * system prompt (resolve) and the transition guidance (runtime/persona.ts).
 * Returns '' if the fragment file cannot be found.
 */
export function loadLifecycleFragment(lifecycle: 'terminal' | 'resident'): string {
  const filePath = resolveFile(`lifecycle/${lifecycle}.md`);
  if (!filePath) return '';
  const { body } = parseFrontmatterGeneric(readFileSync(filePath, 'utf8'));
  return body.trim();
}

/**
 * Load the spine fragment — the "who you report to" contract, keyed on whether
 * the node has a manager (anyone it reports up to). `has-manager` teaches the
 * `push update`/`push urgent`/escalate verbs; `no-manager` (a top-of-spine root)
 * omits the push family entirely — it answers to the human directly.
 * Returns '' if the fragment file cannot be found.
 */
export function loadSpineFragment(hasManager: boolean): string {
  const filePath = resolveFile(`spine/${hasManager ? 'has-manager' : 'no-manager'}.md`);
  if (!filePath) return '';
  const { body } = parseFrontmatterGeneric(readFileSync(filePath, 'utf8'));
  return body.trim();
}

/**
 * Enumerate the kinds with at least one persona file (base.md or
 * orchestrator.md) across all scope roots (project/user/builtin). Used to
 * validate a requested `--kind` and to list the valid choices.
 */
export function availableKinds(): string[] {
  const kinds = new Set<string>();
  for (const root of personaSearchRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, 'base.md')) || existsSync(join(dir, 'orchestrator.md'))) {
        kinds.add(entry.name);
      }
    }
  }
  return [...kinds].sort();
}

const REVIEWERS_SUBDIR = 'reviewers';

export interface SubKind {
  /** Full kind string to spawn, e.g. 'plan/reviewers/security'. */
  kind: string;
  /** Leaf name, e.g. 'security'. */
  name: string;
  /** One-line "what it reviews", from the sub-kind base.md `summary` frontmatter (or ''). */
  summary: string;
}

/**
 * Enumerate the reviewer sub-kinds owned by `parentKind` — the specialist
 * personas at `<root>/<parentKind>/reviewers/<name>/base.md`, scanned across all
 * scope roots (project > user > builtin; highest precedence wins per name).
 *
 * Sub-kinds are intentionally NOT global kinds: `availableKinds()` scans only the
 * immediate children of each persona root, so `<parentKind>/reviewers/*` never
 * leaks into the global list. A sub-kind is reachable only by its full kind
 * string and is surfaced only in its parent kind's composed prompt (resolve.ts).
 * Kind-parametric: any kind owns a roster simply by adding
 * `<kind>/reviewers/<name>/base.md` — no code change.
 */
export function subKindsFor(parentKind: string): SubKind[] {
  const byName = new Map<string, SubKind>();
  for (const root of personaSearchRoots()) {
    const dir = join(root, parentKind, REVIEWERS_SUBDIR);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || byName.has(entry.name)) continue; // higher root already won
      const baseFile = join(dir, entry.name, 'base.md');
      if (!existsSync(baseFile)) continue;
      const { data } = parseFrontmatterGeneric(readFileSync(baseFile, 'utf8'));
      const summary = data && typeof data['summary'] === 'string' ? (data['summary'] as string) : '';
      byName.set(entry.name, { kind: `${parentKind}/${REVIEWERS_SUBDIR}/${entry.name}`, name: entry.name, summary });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
