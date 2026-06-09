// schema.ts — the typed shape of a substrate document's frontmatter, the
// visibility ladder, the kind→default-rungs table, and the parse/validate
// function that turns a resolved MemoryDoc into a fully-typed SubstrateDoc with
// defaults applied. This is the keystone every downstream track (CLI verbs,
// boot render, on-read render, migrator) builds against — pure and side-effect
// free. See design-substrate.md §4 (schema) + §9 (defaults).

import type { Scope } from '../../types.js';
import type { MemoryDoc } from '../memory-resolver.js';

// ---------------------------------------------------------------------------
// Kinds — the three semantic kinds (design §3). `kind` is data, not a fork.
// ---------------------------------------------------------------------------

export const KINDS = ['skill', 'reference', 'preference'] as const;
export type DocKind = (typeof KINDS)[number];

/** Is `v` one of the three valid document kinds? */
export function isDocKind(v: unknown): v is DocKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// The 4-rung visibility ladder (design §4). A strict, monotone ordering where
// each rung is a superset of disclosure over the one before:
//   none < name < preview < content
// `always` is NOT a separate rung — `always` IS `content` (design §4); the
// parser normalizes the alias so a stale doc still resolves.
// ---------------------------------------------------------------------------

export const RUNGS = ['none', 'name', 'preview', 'content'] as const;
export type Rung = (typeof RUNGS)[number];

/** Ordinal of a rung on the ladder (none=0 … content=3). */
export function rungRank(r: Rung): number {
  return RUNGS.indexOf(r);
}

/** Does rung `r` disclose at least as much as `min`? — e.g.
 *  `rungAtLeast(doc.systemPromptVisibility, 'name')` ⇒ "shows at boot at all". */
export function rungAtLeast(r: Rung, min: Rung): boolean {
  return rungRank(r) >= rungRank(min);
}

// ---------------------------------------------------------------------------
// The kind→default-rungs table (design §9). When an author omits a visibility
// field, its default is a function of `kind` — chosen so the common case is
// correct with no thought and the migration is behavior-preserving for skills
// and preferences. One data row per kind, NOT a code fork.
//
//   kind         system-prompt-visibility   file-read-visibility
//   skill        name                       none
//   preference   preview                    none
//   reference    none                       preview
// ---------------------------------------------------------------------------

export const KIND_DEFAULT_RUNGS: Record<DocKind, { systemPrompt: Rung; fileRead: Rung }> = {
  skill: { systemPrompt: 'name', fileRead: 'none' },
  preference: { systemPrompt: 'preview', fileRead: 'none' },
  reference: { systemPrompt: 'none', fileRead: 'preview' },
};

// ---------------------------------------------------------------------------
// The schema object.
// ---------------------------------------------------------------------------

/** A gate predicate tree, evaluated by predicate.ts (`evalCondition`) against
 *  the node-config subject. Typed loosely on purpose — the matcher engine owns
 *  validation; structurally it is a field→matcher map with optional
 *  `all`/`any`/`not` combinators (design §4). */
export type GatePredicate = Record<string, unknown>;

/** The frontmatter-derived schema of a substrate document, with kind-aware
 *  defaults applied. Required fields (`kind`/`when`/`why`) and optionals all
 *  resolved to concrete typed values. */
export interface SubstrateSchema {
  /** Which of the three semantic kinds. */
  kind: DocKind;
  /** Routing condition — "When you are in a situation like X…" (design §4). */
  when: string;
  /** Payoff — "…because Z." Half of the generated preview line. */
  why: string;
  /** Human-facing abbreviation for `crtr memory list`. NEVER loaded into an
   *  agent's context (design §3). Empty string when absent. */
  shortForm: string;
  /** How much surfaces at boot (system prompt / autoloaded context). */
  systemPromptVisibility: Rung;
  /** How much surfaces on-read (when a related file is read). */
  fileReadVisibility: Rung;
  /** Optional eligibility predicate over the node's own config. Absent ⇒ always
   *  eligible. An empty `{}` is carried as-is and is inert (never matches) — see
   *  `gatePasses`. */
  gate?: GatePredicate;
  /** Optional glob list narrowing the on-read trigger to matching read files.
   *  Absent ⇒ positional trigger only. A single glob is normalized to a 1-list. */
  appliesTo?: string[];
}

/** A fully-resolved substrate document: the parsed schema PLUS the resolver's
 *  path-derived identity and body. This single object flows through the whole
 *  pipeline (gate eval → boot/on-read render), so a renderer never re-parses. */
export interface SubstrateDoc extends SubstrateSchema {
  /** Path-derived identity, e.g. `taste/document-substrate` (resolver-supplied). */
  name: string;
  /** The scope this doc resolved from. */
  scope: Scope;
  /** Absolute path to the source .md. */
  path: string;
  /** Document body, frontmatter stripped. */
  body: string;
}

// ---------------------------------------------------------------------------
// Parse / validate.
// ---------------------------------------------------------------------------

/** Parse a raw frontmatter record (from `parseFrontmatterGeneric`, via the
 *  resolver) into a typed schema with defaults applied. Returns `null` when the
 *  record is absent or carries no valid `kind` — i.e. it is not a substrate
 *  document and cannot be classified or defaulted. Tolerant of every other
 *  imperfection (missing `when`/`why` default to '', a bad rung falls back to
 *  the kind default), so a renderer mapping over many docs never throws. */
export function parseSubstrateFrontmatter(
  fm: Record<string, unknown> | null,
): SubstrateSchema | null {
  if (fm === null) return null;
  if (!isDocKind(fm.kind)) return null;
  const kind = fm.kind;
  const defaults = KIND_DEFAULT_RUNGS[kind];
  return {
    kind,
    when: strField(fm.when),
    why: strField(fm.why),
    shortForm: strField(fm['short-form']),
    systemPromptVisibility: parseRung(fm['system-prompt-visibility'], defaults.systemPrompt),
    fileReadVisibility: parseRung(fm['file-read-visibility'], defaults.fileRead),
    gate: parseGate(fm.gate),
    appliesTo: parseAppliesTo(fm['applies-to']),
  };
}

/** Parse a resolved MemoryDoc into a fully-typed SubstrateDoc (schema + the
 *  resolver's name/scope/path/body). Returns `null` for a non-substrate doc
 *  (no valid `kind`), so callers can `docs.map(parseSubstrateDoc).filter(...)`. */
export function parseSubstrateDoc(doc: MemoryDoc): SubstrateDoc | null {
  const schema = parseSubstrateFrontmatter(doc.frontmatter);
  if (schema === null) return null;
  return { ...schema, name: doc.name, scope: doc.scope, path: doc.path, body: doc.body };
}

/** The generated `preview`-rung routing line (design §4), composed from the two
 *  required prose fields and the kind: `"{when}, read this {kind}. {why}."`.
 *  Both boot and on-read render render this identical line, so it lives once
 *  here to prevent drift. Light cleanup avoids doubled punctuation. */
export function previewLine(doc: Pick<SubstrateSchema, 'kind' | 'when' | 'why'>): string {
  const when = doc.when.trim().replace(/[.,]+$/, '');
  const why = doc.why.trim().replace(/\.+$/, '');
  return `${when}, read this ${doc.kind}. ${why}.`;
}

// ---------------------------------------------------------------------------
// Field coercion helpers (private).
// ---------------------------------------------------------------------------

function strField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Resolve a visibility field to a ladder rung, falling back to the kind
 *  default when absent/invalid. Maps the `always` alias → `content` (design §4). */
function parseRung(v: unknown, fallback: Rung): Rung {
  if (typeof v !== 'string') return fallback;
  const norm = v === 'always' ? 'content' : v;
  return (RUNGS as readonly string[]).includes(norm) ? (norm as Rung) : fallback;
}

/** A gate is engaged only when frontmatter carries a non-null, non-array object
 *  (the predicate vocabulary's field→matcher map). Anything else (absent, null,
 *  scalar, array) ⇒ no gate ⇒ always eligible — the safe default that never
 *  silently hides a doc. An empty `{}` IS carried (and is inert per design §4). */
function parseGate(v: unknown): GatePredicate | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as GatePredicate)
    : undefined;
}

/** Normalize `applies-to` to a non-empty glob list, or undefined (positional
 *  trigger only). Accepts a single string or an array of strings. */
function parseAppliesTo(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    return v.trim() === '' ? undefined : [v];
  }
  if (Array.isArray(v)) {
    const globs = v.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
    return globs.length > 0 ? globs : undefined;
  }
  return undefined;
}
