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

import { existsSync, readFileSync } from 'node:fs';
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
 * EVERY persona (push/finish/delegate/feed/ask). Returns '' if not found.
 */
export function loadRuntimeBase(): string {
  const filePath = resolveFile('runtime-base.md');
  if (!filePath) return '';
  const src = readFileSync(filePath, 'utf8');
  const { body } = parseFrontmatterGeneric(src);
  return body.trim();
}
