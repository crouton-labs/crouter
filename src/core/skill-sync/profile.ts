/**
 * Translation profile (Phase P5) — the single home of the crtr ↔ Claude
 * frontmatter asymmetry.
 *
 * Body and asset reconciliation is symmetric (a plain 3-way merge); frontmatter
 * is the ONLY asymmetric axis, and all of that asymmetry lives here (R-U3). The
 * forward translator (`claudeToCrtr.description`) reshapes a Claude `description`
 * into a crtr read-routing `when-and-why-to-read` sentence + `short-form`; the
 * reverse translator (`crtrToClaude.description`) inverts that back into the
 * canonical Claude form `"<gist>. Use when <situation>."` so a round-trip is
 * byte-stable (R-S4 / OD-1).
 *
 * The forward string functions (`reshapeWhenAndWhy`, `cleanClause`,
 * `toShortForm`, `yamlQuote`, `USE_WHEN_RE`) preserve the legacy reshape
 * behavior exactly — `reshapeWhenAndWhy` output is byte-identical to that
 * legacy for the same input (R-I4). Frontmatter writing and generator stamping
 * are intentionally NOT part of this module — the reconcile engine owns all
 * writes.
 */

import { usage } from '../errors.js';
import type { TranslationOverride } from './manifest.js';

// ── Forward translation (Claude `description` → crtr `when-and-why-to-read`) ──

// "Use when …" / "Use this when …" / "This skill should be used when …" / "Used when …"
const USE_WHEN_RE =
  /\b(?:use\s+this\s+skill\s+when|use\s+this\s+when|this\s+skill\s+should\s+be\s+used\s+when|used\s+when|use\s+when)\b\s*/i;

/** Collapse whitespace, strip surrounding connective punctuation, and lowercase
 *  a leading Capitalized word (but never an ACRONYM) so the clause reads inline
 *  after "When " / "because ". */
function cleanClause(s: string): string {
  let c = s.replace(/\s+/g, ' ').trim();
  c = c.replace(/^[,;:.\s]+/, '').replace(/[,;:.\s]+$/, '');
  if (/^[A-Z][a-z]/.test(c)) c = c.charAt(0).toLowerCase() + c.slice(1);
  return c;
}

/** Reshape a Claude `description` into a read-routing sentence per
 *  taste/why-field-means-why-to-read: "When <situation>, this skill should be
 *  read [because <gist>]." Claude descriptions are typically
 *  "<gist>. Use when <situation>." — we lift the use-when clause into the
 *  situation and the preceding text into the payoff. With no explicit clause,
 *  the whole description becomes the situation. */
export function reshapeWhenAndWhy(description: string): string {
  const desc = description.replace(/\s+/g, ' ').trim();
  if (desc === '') return 'When this skill applies, this skill should be read.';
  const m = desc.match(USE_WHEN_RE);
  if (m && m.index !== undefined) {
    const gist = cleanClause(desc.slice(0, m.index));
    const situation = cleanClause(desc.slice(m.index + m[0].length));
    if (situation !== '') {
      let out = `When ${situation}, this skill should be read`;
      if (gist !== '') out += ` because ${gist}`;
      return out + '.';
    }
  }
  return `When ${cleanClause(desc)}, this skill should be read.`;
}

/** One-line short-form for the human inventory (never loaded into agent
 *  context): the source description collapsed to a single line. */
export function toShortForm(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

/** Always-double-quote a YAML scalar, escaping backslashes and quotes. The two
 *  generated fields are single-line, so this is safe regardless of colons,
 *  commas, or other YAML-significant characters. */
export function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── Reverse translation (crtr `when-and-why-to-read` → Claude `description`) ──

/** The forward `reshapeWhenAndWhy` form, parsed back into its parts:
 *  "When <situation>, this skill should be read[ because <gist>]." */
const RESHAPE_RE =
  /^When (.+?), this skill should be read(?: because (.+?))?\.?$/s;

/** Recover `{ situation, gist }` from a `when-and-why-to-read` sentence. A
 *  value emitted by `reshapeWhenAndWhy` matches `RESHAPE_RE`; anything else is
 *  treated as a bare situation with no gist. The clauses are normalized through
 *  `cleanClause` so the reverse is the exact inverse of the forward split. */
function parseWhenAndWhy(whenAndWhy: string): { situation: string; gist: string } {
  const w = whenAndWhy.replace(/\s+/g, ' ').trim();
  const m = w.match(RESHAPE_RE);
  if (m) {
    return { situation: cleanClause(m[1]), gist: cleanClause(m[2] ?? '') };
  }
  return { situation: cleanClause(w), gist: '' };
}

/** Pull a gist out of a `short-form` line: the text before any "Use when …"
 *  clause (mirroring the forward split), or the whole line if there is none. */
function gistFromShortForm(shortForm: string): string {
  const s = shortForm.replace(/\s+/g, ' ').trim();
  const m = s.match(USE_WHEN_RE);
  if (m && m.index !== undefined) return cleanClause(s.slice(0, m.index));
  return cleanClause(s);
}

/** Capitalize the first character of a clause (no-op for an empty string or a
 *  leading acronym, which is already upper-case). */
function capitalizeFirst(s: string): string {
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Reverse translator: a crtr `when-and-why-to-read` (plus optional `short-form`
 * for the gist when the sentence carries none) → the canonical Claude
 * `description` form `"<gist>. Use when <situation>."`.
 *
 * This is the exact inverse of `reshapeWhenAndWhy`, normalized so that
 * `crtrToClaudeDescription(reshapeWhenAndWhy(d), toShortForm(d))` is a fixed
 * point under re-application — a round-trip is byte-stable (R-S4 / OD-1). The
 * `gist` is recovered from the sentence's `because` clause; only when that is
 * absent do we fall back to the (use-when-stripped) `short-form`, so a
 * `short-form` that is itself a "Use when …" line contributes nothing and
 * cannot ping-pong.
 */
export function crtrToClaudeDescription(whenAndWhy: string, shortForm?: string): string {
  const { situation, gist: parsedGist } = parseWhenAndWhy(whenAndWhy);
  let gist = parsedGist;
  if (gist === '' && shortForm !== undefined) gist = gistFromShortForm(shortForm);

  const useWhen = situation === '' ? '' : `Use when ${situation}.`;
  if (gist === '') return useWhen;
  const cap = capitalizeFirst(gist);
  return useWhen === '' ? `${cap}.` : `${cap}. ${useWhen}`;
}

// ── Translation profile ──────────────────────────────────────────────────────

/** The crtr ↔ Claude frontmatter contract: the two translatable `description`
 *  axes plus the owned-field lists that are NEVER crossed to the other side
 *  (R-X2). Shape per R-I4. */
export interface TranslationProfile {
  claudeToCrtr: { description: (d: string) => { whenAndWhy: string; shortForm: string } };
  crtrToClaude: { description: (whenAndWhy: string, shortForm?: string) => string };
  crtrOwned: readonly string[];
  claudeOwned: readonly string[];
}

/** The default profile (R-I4). The forward translator reuses
 *  `reshapeWhenAndWhy`/`toShortForm` verbatim; the reverse uses
 *  `crtrToClaudeDescription`. Owned-field lists match the field taxonomy. */
export const DEFAULT_PROFILE: TranslationProfile = {
  claudeToCrtr: {
    description: (d) => ({ whenAndWhy: reshapeWhenAndWhy(d), shortForm: toShortForm(d) }),
  },
  crtrToClaude: {
    description: (whenAndWhy, shortForm) => crtrToClaudeDescription(whenAndWhy, shortForm),
  },
  crtrOwned: ['kind', 'system-prompt-visibility', 'file-read-visibility', 'gate', 'applies-to'],
  claudeOwned: ['argument-hint', 'user-invocable', 'paths', 'context', 'model', 'agent', 'keywords', 'type'],
};

/** The only fields a per-pair `frontmatter` override may set (R-I5). The
 *  translators are functions and cannot be expressed in JSON, so the
 *  overridable surface is exactly the owned-field lists. */
const OVERRIDABLE_KEYS = ['crtrOwned', 'claudeOwned'] as const;

/**
 * Resolve a pair's effective profile: a SHALLOW merge of its `frontmatter`
 * override over `DEFAULT_PROFILE`, validated against the profile shape (R-I5).
 * An unknown key or a non-string-array value is a malformed-manifest error
 * (R-U7). NEVER mutates `DEFAULT_PROFILE` — the override path returns a fresh
 * object; the no-override path returns the (unmodified) constant.
 */
export function resolveProfile(override?: TranslationOverride): TranslationProfile {
  if (override === undefined) return DEFAULT_PROFILE;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    throw usage('malformed manifest: pair frontmatter override must be an object');
  }

  for (const key of Object.keys(override)) {
    if (!(OVERRIDABLE_KEYS as readonly string[]).includes(key)) {
      throw usage(
        `malformed manifest: unknown frontmatter override key "${key}" (allowed: ${OVERRIDABLE_KEYS.join(', ')})`,
      );
    }
  }

  return {
    claudeToCrtr: DEFAULT_PROFILE.claudeToCrtr,
    crtrToClaude: DEFAULT_PROFILE.crtrToClaude,
    crtrOwned: validateOwned(override.crtrOwned, 'crtrOwned') ?? DEFAULT_PROFILE.crtrOwned,
    claudeOwned: validateOwned(override.claudeOwned, 'claudeOwned') ?? DEFAULT_PROFILE.claudeOwned,
  };
}

/** Validate one owned-field override list: undefined → inherit the default;
 *  anything other than an array of strings → malformed-manifest error. */
function validateOwned(value: unknown, key: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw usage(`malformed manifest: frontmatter override "${key}" must be an array of strings`);
  }
  return value;
}
