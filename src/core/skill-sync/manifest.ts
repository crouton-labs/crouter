/**
 * Layered manifest for bidirectional skill sync (Phase P2).
 *
 * Reads the user-scope (`~/.crouter/skill-sync.json`) and project-scope
 * (`<proj>/.crouter/skill-sync.json`) manifests, validates each against the
 * R-I1 schema with a hand-rolled strict validator (no new dependency), and
 * merges them into a single additive, project-wins pair list.
 *
 * Contract (R-U7/R-U8/R-U9/R-I1/R-X4):
 *  - Missing file        → empty layer (absence ≠ malformation).
 *  - Invalid JSON        → HARD error naming the file (no lenient fallback).
 *  - Schema-invalid pair → HARD error naming the file (no skip-and-proceed).
 *  - Merge               → additive union keyed on `id`; a project pair with an
 *                          `id` present in the user layer REPLACES it entirely.
 *
 * The shared data shapes (`Pair`, `Endpoint`, `TranslationOverride`) are
 * exported from here; P5/P6/P7 import them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userScopeRoot, findProjectScopeRoot } from '../scope.js';
import { usage } from '../errors.js';

// ── Shared types (consumed by P5/P6/P7) ──────────────────────────────────────

/** The scope a sync endpoint resolves within. `plugin` is crtr-side only (a
 *  skill bundle inside a crtr-registry plugin); `claude-plugin` is Claude-side
 *  only (a skill IN PLACE inside its Claude plugin's install path). */
export type EndpointScope = 'user' | 'project' | 'plugin' | 'claude-plugin';

/** One side of a sync pair — a single SKILL.md bundle on either the crtr or the
 *  Claude side. Resolves to `<dir>/<name>/SKILL.md` (R-I2, resolved by P6).
 *  `plugin` is required iff `scope` is `plugin` (crtr) or `claude-plugin`
 *  (Claude) — it names the owning plugin (a `claude-plugin` value is the
 *  marketplace-qualified key `<plugin>@<marketplace>`). */
export interface Endpoint {
  scope: EndpointScope;
  name: string;
  plugin?: string;
}

/** Per-pair override of the default translation profile — shallow-merged over
 *  it by P5's `resolveProfile` (R-I5). The JSON-overridable surface is the
 *  owned-field lists; P5 performs the profile-shape validation and rejects
 *  unknown keys, so this manifest validator only checks it is an object. */
export interface TranslationOverride {
  crtrOwned?: string[];
  claudeOwned?: string[];
}

/** A single bidirectional sync pair (R-I1). `kind` is optional and, if present,
 *  MUST be `"skill"` — the other endpoint kinds (`command`/`agent`/`plugin`) are
 *  built-in export artifacts (skill-sync/builtins.ts), not manifest-enrollable. */
export interface Pair {
  id: string;
  kind?: 'skill';
  crtr: Endpoint;
  claude: Endpoint;
  frontmatter?: TranslationOverride;
}

/** The merged, validated manifest. */
export interface LayeredManifest {
  pairs: Pair[];
}

// ── Public API ───────────────────────────────────────────────────────────────

const MANIFEST_FILE = 'skill-sync.json';
const VALID_SCOPES: readonly EndpointScope[] = ['user', 'project', 'plugin', 'claude-plugin'];

/**
 * Read, validate, and merge the user- and project-layer manifests.
 *
 * @param cwd  starting directory for project-scope resolution (defaults to the
 *             process cwd via `findProjectScopeRoot`).
 * @returns    `{ pairs }` — the additive, project-wins union (R-U8).
 * @throws     `usage()` error naming the offending file on malformed JSON or a
 *             schema-invalid layer (R-U7/R-X4). NEVER swallows a bad layer.
 */
export function readLayeredManifest(cwd?: string): LayeredManifest {
  const userPath = join(userScopeRoot(), MANIFEST_FILE);
  const userPairs = readLayer(userPath);

  const projectRoot = findProjectScopeRoot(cwd);
  const projectPairs = projectRoot
    ? readLayer(join(projectRoot, MANIFEST_FILE))
    : [];

  // Additive union keyed on `id`; project replaces user on collision (R-U8).
  // A Map preserves first-insertion order, so a project pair overwriting a user
  // pair keeps the user pair's position while replacing its value.
  const merged = new Map<string, Pair>();
  for (const p of userPairs) merged.set(p.id, p);
  for (const p of projectPairs) merged.set(p.id, p);

  return { pairs: [...merged.values()] };
}

// ── Layer read + strict validation ──────────────────────────────────────────

/** Read one layer file. Missing → empty (R-U7). Present-but-malformed → throw
 *  naming the file (R-U7/R-X4). Returns the validated pairs of that one layer. */
function readLayer(path: string): Pair[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // empty layer
    throw usage(`failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usage(`invalid JSON in ${path}: ${(err as Error).message}`);
  }

  return validateLayer(parsed, path);
}

/** Validate one parsed layer against the R-I1 schema. Throws naming `path` on
 *  any violation. Duplicate-`id` detection is scoped to THIS layer only —
 *  cross-layer `id` collisions are the legal project-wins merge, not an error. */
function validateLayer(doc: unknown, path: string): Pair[] {
  if (!isObject(doc)) {
    throw usage(`malformed manifest ${path}: top level must be a JSON object`);
  }

  // Strict-require `version: 2` — any existing manifest MUST declare it (no
  // advisory hedge). v1 has zero on-disk instances, so this is a clean forward
  // marker, not a migration.
  const version = (doc as Record<string, unknown>).version;
  if (version !== 2) {
    throw usage(
      `malformed manifest ${path}: "version" must be 2 (got ${JSON.stringify(version)})`,
    );
  }

  // `pairs` absent → empty manifest; present → must be an array.
  const rawPairs = (doc as Record<string, unknown>).pairs;
  if (rawPairs === undefined) return [];
  if (!Array.isArray(rawPairs)) {
    throw usage(`malformed manifest ${path}: "pairs" must be an array`);
  }

  const seen = new Set<string>();
  const pairs: Pair[] = [];
  rawPairs.forEach((entry, i) => {
    const pair = validatePair(entry, i, path);
    if (seen.has(pair.id)) {
      throw usage(
        `malformed manifest ${path}: duplicate pair id "${pair.id}" within one layer`,
      );
    }
    seen.add(pair.id);
    pairs.push(pair);
  });

  return pairs;
}

function validatePair(entry: unknown, i: number, path: string): Pair {
  const where = `pairs[${i}]`;
  if (!isObject(entry)) {
    throw usage(`malformed manifest ${path}: ${where} must be an object`);
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    throw usage(`malformed manifest ${path}: ${where} is missing a non-empty string "id"`);
  }
  const id = e.id;

  // `kind` is optional; absent → "skill". Any value other than "skill" is a hard
  // error — export kinds (command/agent/plugin) are built-in, not enrollable.
  let kind: 'skill' | undefined;
  if (e.kind !== undefined) {
    if (e.kind !== 'skill') {
      throw usage(
        `malformed manifest ${path}: ${where}.kind must be "skill" or absent — ` +
          `kinds like "command"/"agent"/"plugin" are built-in export artifacts, ` +
          `not manifest-enrollable`,
      );
    }
    kind = e.kind;
  }

  const crtr = validateEndpoint(e.crtr, `${where}.crtr`, path, 'crtr');
  const claude = validateEndpoint(e.claude, `${where}.claude`, path, 'claude');

  let frontmatter: TranslationOverride | undefined;
  if (e.frontmatter !== undefined) {
    if (!isObject(e.frontmatter)) {
      throw usage(`malformed manifest ${path}: ${where}.frontmatter must be an object`);
    }
    frontmatter = e.frontmatter as TranslationOverride;
  }

  return { id, kind, crtr, claude, frontmatter };
}

function validateEndpoint(
  value: unknown,
  where: string,
  path: string,
  side: 'crtr' | 'claude',
): Endpoint {
  if (!isObject(value)) {
    throw usage(`malformed manifest ${path}: ${where} is missing or not an object`);
  }
  const ep = value as Record<string, unknown>;

  if (!isScope(ep.scope)) {
    throw usage(
      `malformed manifest ${path}: ${where}.scope must be one of ${VALID_SCOPES.join('|')}`,
    );
  }
  const scope = ep.scope;

  // Scopes are side-specific: `plugin` resolves a crtr-registry plugin, so it is
  // only legal on the crtr side; `claude-plugin` resolves a Claude install path,
  // so it is only legal on the Claude side (R-I1).
  if (scope === 'plugin' && side !== 'crtr') {
    throw usage(
      `malformed manifest ${path}: ${where}.scope "plugin" is only valid for a crtr ` +
        `endpoint — for a Claude plugin skill use "claude-plugin"`,
    );
  }
  if (scope === 'claude-plugin' && side !== 'claude') {
    throw usage(
      `malformed manifest ${path}: ${where}.scope "claude-plugin" is only valid for a ` +
        `Claude endpoint`,
    );
  }

  if (typeof ep.name !== 'string' || ep.name.length === 0) {
    throw usage(`malformed manifest ${path}: ${where}.name must be a non-empty string`);
  }
  const name = ep.name;

  // `plugin` required iff scope names a plugin (`plugin` or `claude-plugin`).
  if (scope === 'plugin' || scope === 'claude-plugin') {
    if (typeof ep.plugin !== 'string' || ep.plugin.length === 0) {
      throw usage(
        `malformed manifest ${path}: ${where} has scope "${scope}" but no non-empty "plugin" name`,
      );
    }
    return { scope, name, plugin: ep.plugin };
  }
  if (ep.plugin !== undefined) {
    throw usage(
      `malformed manifest ${path}: ${where}.plugin is only valid when scope is "plugin" or "claude-plugin"`,
    );
  }
  return { scope, name };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScope(v: unknown): v is EndpointScope {
  return typeof v === 'string' && (VALID_SCOPES as readonly string[]).includes(v);
}
