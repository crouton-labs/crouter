import { join, relative, sep } from 'node:path';
import type { InstalledPlugin, Scope } from '../types.js';
import { pathExists, readText, walkFiles } from './fs-utils.js';
import { parseFrontmatterGeneric } from './frontmatter.js';
import { listInstalledPlugins, parseSkillQualifier } from './resolver.js';
import { ambiguous, notFound, usage } from './errors.js';
import { warn } from './output.js';
import { pluginMemoryDir, projectScopeRoot, scopeMemoryDir } from './scope.js';

/**
 * Thin memory-document resolver for the document substrate. Mirrors the SHAPE
 * of the skill resolver (qualifier parse → scope precedence → direct path
 * lookup → leaf-name fallback) but drops ALL plugin machinery: memory
 * resolution is scope + leaf/path ONLY. The three memory scopes resolve in
 * precedence order project > user > builtin (the same precedence concept as
 * orderPluginsByResolution, minus plugins). It returns the raw parsed
 * frontmatter + body; it does NOT interpret the schema, kind, gate, or rungs —
 * that is the schema/gate layer's job (callers filter by `frontmatter.kind`).
 */
export interface MemoryDoc {
  /** Path-derived identity: the doc's path under the scope's memory/ root, no
   *  extension, slash-separated — e.g. memory/taste/foo.md → "taste/foo". */
  name: string;
  scope: Scope;
  /** Absolute path to the resolved .md file. */
  path: string;
  /** Raw, uncoerced frontmatter record (null when the doc has no frontmatter). */
  frontmatter: Record<string, unknown> | null;
  /** Document body, with the frontmatter block stripped. */
  body: string;
}

export interface MemoryResolutionOpts {
  /** Restrict resolution to a single scope. Conflicts with a scope prefix on
   *  the identifier (e.g. `user/foo` with scope=project) throw. */
  scope?: Scope;
}

/** Canonical, unambiguous identifier for a memory document: `<scope>/<name>`. */
export function memoryDocId(doc: MemoryDoc): string {
  return `${doc.scope}/${doc.name}`;
}

/** The memory scopes in resolution precedence: project > user > builtin.
 *  Project is included only when a project scope exists for the cwd. A single
 *  `scope` narrows to just that scope. */
function scopesInPrecedence(scope?: Scope): Scope[] {
  if (scope) return [scope];
  const out: Scope[] = [];
  if (projectScopeRoot()) out.push('project');
  out.push('user');
  out.push('builtin');
  return out;
}

function loadMemoryDoc(name: string, scope: Scope, path: string): MemoryDoc {
  const { data, body } = parseFrontmatterGeneric(readText(path));
  return { name, scope, path, frontmatter: data, body };
}

/** All memory docs in one scope's memory/ dir, scanned recursively for *.md
 *  (topical subdirs supported), sorted by path-derived name. */
export function listMemoryDocs(scope: Scope): MemoryDoc[] {
  const dir = scopeMemoryDir(scope);
  if (!dir || !pathExists(dir)) return [];
  const docs: MemoryDoc[] = [];
  for (const file of walkFiles(dir, (n) => n.endsWith('.md'))) {
    const name = relative(dir, file).replace(/\.md$/i, '').split(sep).join('/');
    if (!name) continue;
    // COLLECTION layer: the strict frontmatter parser throws on invalid YAML.
    // Isolate one malformed doc with a clear scoped notice + skip, so a single
    // bad file can't brick `memory list`/`find` or the substrate boot render.
    try {
      docs.push(loadMemoryDoc(name, scope, file));
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      warn(`invalid frontmatter in ${file}: ${msg}`);
    }
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/** All of one plugin's substrate docs, mounted under the virtual `<pluginName>/`
 *  namespace. Walks `pluginMemoryDir(plugin)` recursively for *.md, deriving each
 *  doc's name exactly as `listMemoryDocs` does (path-relative, no extension,
 *  slash-separated) then prefixing the plugin name. Builtin has no plugins. */
export function listPluginMemoryDocs(plugin: InstalledPlugin, scope: Scope): MemoryDoc[] {
  const dir = pluginMemoryDir(plugin);
  if (!pathExists(dir)) return [];
  const docs: MemoryDoc[] = [];
  for (const file of walkFiles(dir, (n) => n.endsWith('.md'))) {
    const derived = relative(dir, file).replace(/\.md$/i, '').split(sep).join('/');
    if (!derived) continue;
    const name = `${plugin.name}/${derived}`;
    try {
      docs.push(loadMemoryDoc(name, scope, file));
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      warn(`invalid frontmatter in ${file}: ${msg}`);
    }
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/** All memory docs across the resolved scopes, in precedence order
 *  (project, then user, then builtin). Within each scope, native docs are
 *  emitted FIRST, then that scope's enabled-plugin docs — so native wins on the
 *  caller's first-wins (scope,name) dedup. Each group is name-sorted within. */
export function listAllMemoryDocs(scope?: Scope): MemoryDoc[] {
  return scopesInPrecedence(scope).flatMap((s) => [
    ...listMemoryDocs(s),
    ...listInstalledPlugins(s)
      .filter((p) => p.enabled)
      .flatMap((p) => listPluginMemoryDocs(p, s)),
  ]);
}

/** Direct full-path lookup of memory/<name>.md across scopes, precedence-first.
 *  Returns every scope's hit in precedence order; the resolver takes the first
 *  (highest-precedence) one — a fully-specified name is never ambiguous.
 *
 *  A directory INDEX is the cleaner contract: when `<name>.md` is absent but
 *  `<name>/INDEX.md` exists, the bare dir name (`taste`) resolves to the dir's
 *  INDEX doc — carrying the dir name as its identity. (`taste/INDEX` still
 *  resolves directly as the file path.) */
function findMemoryMatches(name: string, scope: Scope | undefined): MemoryDoc[] {
  const matches: MemoryDoc[] = [];
  for (const s of scopesInPrecedence(scope)) {
    const dir = scopeMemoryDir(s);
    if (!dir) continue;
    const path = join(dir, ...name.split('/')) + '.md';
    if (pathExists(path)) {
      matches.push(loadMemoryDoc(name, s, path));
      continue;
    }
    const indexPath = join(dir, ...name.split('/'), 'INDEX.md');
    if (pathExists(indexPath)) matches.push(loadMemoryDoc(name, s, indexPath));
  }
  return matches;
}

/** Leaf-name fallback: match docs whose final path segment equals `leaf`.
 *  Only meaningful for a bare segment (a slashed query can never equal a single
 *  segment), mirroring findSkillsByLeaf. Returns matches precedence-ordered. */
function findMemoryByLeaf(leaf: string, scope: Scope | undefined): MemoryDoc[] {
  if (leaf.includes('/')) return [];
  let all: MemoryDoc[];
  try {
    all = listAllMemoryDocs(scope);
  } catch {
    return [];
  }
  return all.filter((d) => (d.name.split('/').pop() ?? d.name) === leaf);
}

function formatLeafAmbiguous(leaf: string, matches: MemoryDoc[]): string {
  const ids = matches.map(memoryDocId).join(', ');
  return `ambiguous memory document: ${leaf} matches multiple documents: ${ids}`;
}

/**
 * Resolve a path-derived name to a single memory document.
 *
 * Accepted identifier forms (mirroring parseSkillQualifier, no plugins):
 *   <name>            — bare name; resolved by scope precedence project>user>builtin
 *   <scope>/<name>    — pinned to one scope (user|project)
 * `<name>` may carry topical subdirs (`taste/foo`); a bare leaf (`foo`) falls
 * back to a last-segment match across the resolved scopes.
 *
 * Resolution order: parse qualifier → direct memory/<name>.md lookup
 * (precedence-first) → leaf-name fallback (ambiguity error listing candidates).
 */
export function resolveMemoryDoc(
  rawName: string,
  opts: MemoryResolutionOpts = {},
): MemoryDoc {
  const parsed = parseSkillQualifier(rawName);

  if (parsed.scope && opts.scope && parsed.scope !== opts.scope) {
    throw usage(
      `scope conflict: identifier "${rawName}" uses scope "${parsed.scope}" but --scope is "${opts.scope}"`,
    );
  }

  const effectiveScope: Scope | undefined = opts.scope ?? parsed.scope;
  const name = parsed.segments.join('/');
  if (name === '') throw usage(`memory document name required`);

  // Direct full-path lookup: a fully-specified name resolves by scope precedence.
  const direct = findMemoryMatches(name, effectiveScope);
  if (direct.length > 0) return direct[0];

  // Leaf-name fallback: the caller gave only the final segment (e.g. "foo" for
  // "taste/foo"). Match by last segment across the resolved scope dirs.
  const byLeaf = findMemoryByLeaf(name, effectiveScope);
  if (byLeaf.length > 0) {
    // Same path-derived name across scopes → precedence wins (return first);
    // genuinely different docs sharing a leaf → ambiguous.
    const distinctNames = new Set(byLeaf.map((d) => d.name));
    if (distinctNames.size === 1) return byLeaf[0];
    throw ambiguous(formatLeafAmbiguous(name, byLeaf), {
      memory: name,
      candidates: byLeaf.map((d) => ({
        id: memoryDocId(d),
        scope: d.scope,
        path: d.path,
      })),
      next: 'Multiple documents share this leaf name. Re-run with one of the full names in candidates.',
    });
  }

  throw notFound(`memory document not found: ${rawName}`, {
    memory: name,
    scope: parsed.scope,
  });
}
