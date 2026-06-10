// schema.ts — the typed shape of a substrate document's frontmatter, the
// visibility ladder, and the parse/validate function that turns a resolved
// MemoryDoc into a fully-typed SubstrateDoc. This is the keystone every
// downstream track (CLI verbs, boot render, on-read render, migrator) builds
// against — pure and side-effect free. See design-substrate.md §4 (schema).
//
// There is NO kind-based default for visibility: the right rung is a
// case-by-case authoring call, so both rungs are required at authoring time
// (enforced by `crtr memory write` on create and by `crtr memory lint`). The
// runtime parser is tolerant by contract (it maps over many docs and must
// never throw), so a doc missing/with an invalid rung falls back to the neutral
// floor `none` — a malformed doc renders invisible rather than crashing, and
// lint flags it. Valid docs never hit the fallback.

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
// The neutral fallback rung used only when a doc omits a visibility field or
// carries an invalid one. NOT a default an author may lean on — authoring-time
// enforcement requires explicit rungs; this is purely the runtime parser's
// never-throw floor (a malformed doc renders invisible, and lint flags it).
// ---------------------------------------------------------------------------

export const FALLBACK_RUNG: Rung = 'none';

// ---------------------------------------------------------------------------
// The schema object.
// ---------------------------------------------------------------------------

/** A gate predicate tree, evaluated by predicate.ts (`evalCondition`) against
 *  the node-config subject. Typed loosely on purpose — the matcher engine owns
 *  validation; structurally it is a field→matcher map with optional
 *  `all`/`any`/`not` combinators (design §4). */
export type GatePredicate = Record<string, unknown>;

/** The frontmatter-derived schema of a substrate document, with kind-aware
 *  defaults applied. Required fields (`kind`/`when-and-why-to-read`) and
 *  optionals all resolved to concrete typed values. */
export interface SubstrateSchema {
  /** Which of the three semantic kinds. */
  kind: DocKind;
  /** The read-routing line — a single sentence answering WHEN to read this doc
   *  and WHY it is worth the read: "When <circumstance>, this <kind> should be
   *  read <because <payoff>>." (design §4). This is read-routing — why an agent
   *  should spend the read — NEVER justification of why the content should be
   *  obeyed. It IS the preview verbatim. Frontmatter key `when-and-why-to-read`. */
  whenAndWhyToRead: string;
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
 *  document and cannot be classified. Tolerant of every other imperfection (a
 *  missing `when-and-why-to-read` defaults to '', a missing/bad rung falls back
 *  to the neutral floor `none`), so a renderer mapping over many docs never
 *  throws. Authoring-time enforcement of these fields lives in `crtr memory
 *  write` (on create) and `crtr memory lint`. */
export function parseSubstrateFrontmatter(
  fm: Record<string, unknown> | null,
): SubstrateSchema | null {
  if (fm === null) return null;
  if (!isDocKind(fm.kind)) return null;
  const kind = fm.kind;
  return {
    kind,
    whenAndWhyToRead: strField(fm['when-and-why-to-read']),
    shortForm: strField(fm['short-form']),
    systemPromptVisibility: parseRung(fm['system-prompt-visibility'], FALLBACK_RUNG),
    fileReadVisibility: parseRung(fm['file-read-visibility'], FALLBACK_RUNG),
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

/** The `preview`-rung routing line (design §4): the `when-and-why-to-read`
 *  field rendered essentially verbatim — it is already authored as the complete
 *  routing sentence ("When …, this <kind> should be read …"), so there is no
 *  template to compose. Both boot and on-read render this identical line, so it
 *  lives once here to prevent drift. Light cleanup normalizes the trailing
 *  period. */
export function previewLine(doc: Pick<SubstrateSchema, 'whenAndWhyToRead'>): string {
  const line = doc.whenAndWhyToRead.trim().replace(/\.+$/, '');
  return line === '' ? '' : `${line}.`;
}

// ---------------------------------------------------------------------------
// Field coercion helpers (private).
// ---------------------------------------------------------------------------

function strField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Resolve a visibility field to a ladder rung, falling back to the neutral
 *  floor when absent/invalid. */
function parseRung(v: unknown, fallback: Rung): Rung {
  return typeof v === 'string' && (RUNGS as readonly string[]).includes(v)
    ? (v as Rung)
    : fallback;
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
