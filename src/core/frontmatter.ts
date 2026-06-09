import { parse as parseYaml } from 'yaml';
import { isSkillType, type SkillFrontmatter } from '../types.js';

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export interface ParsedFrontmatter {
  data: SkillFrontmatter | null;
  body: string;
  raw: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { data: null, body: source, raw: '' };
  }
  const raw = match[1];
  const body = source.slice(match[0].length);
  return { data: toSkillFrontmatter(parseYamlBlock(raw)), body, raw };
}

export interface ParsedFrontmatterGeneric {
  /** Raw, uncoerced key/value record from the YAML block (null when absent). */
  data: Record<string, unknown> | null;
  body: string;
  raw: string;
}

/** Like parseFrontmatter but returns the raw key/value record instead of
 *  coercing to SkillFrontmatter. Used by consumers (e.g. subagents) that read
 *  fields skills don't declare, such as `tools` and `model`. */
export function parseFrontmatterGeneric(source: string): ParsedFrontmatterGeneric {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { data: null, body: source, raw: '' };
  }
  const raw = match[1];
  const body = source.slice(match[0].length);
  return { data: parseYamlBlock(raw), body, raw };
}

function toSkillFrontmatter(out: Record<string, unknown>): SkillFrontmatter {
  const fm: SkillFrontmatter = {
    name: scalarToString(out.name) ?? '',
    description: scalarToString(out.description),
    keywords: Array.isArray(out.keywords) ? out.keywords.map((k) => String(k)) : undefined,
    type: isSkillType(out.type) ? out.type : undefined,
  };
  return fm;
}

/** Coerce a YAML scalar (string/number/boolean) to its string form. A skill's
 *  `name`/`description` are always strings to consumers; native non-string
 *  scalars (a numeric/boolean value) render as their string form, and
 *  non-scalars (null/undefined/array/object) yield undefined. */
function scalarToString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Parse the inner YAML of a frontmatter block into a key/value record.
 *
 *  ONE strict parser, no fallback. The frontmatter contract IS "valid YAML":
 *  the single `yaml`-package path handles the substrate's nested `gate:` maps,
 *  inline `{…}` objects, and native scalar typing — and a doc whose frontmatter
 *  is NOT valid YAML THROWS, by design. There is deliberately no second lenient
 *  parser; a dual parsing strategy is the hedge we reject. Callers that iterate
 *  MANY docs isolate a per-doc throw at the COLLECTION layer (a clear scoped
 *  notice naming the bad file, then continue); single-doc callers let the error
 *  surface so the user learns their one requested doc is malformed.
 *
 *  A VALID non-object document (a bare scalar, a top-level list, or an empty
 *  block) normalizes to an empty record, preserving the contract that callers
 *  always receive a Record for well-formed-but-non-mapping frontmatter. */
function parseYamlBlock(raw: string): Record<string, unknown> {
  return normalizeToRecord(parseYaml(raw));
}

function normalizeToRecord(parsed: unknown): Record<string, unknown> {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function serializeFrontmatter(data: SkillFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${quoteIfNeeded(data.name)}`);
  if (data.description !== undefined) {
    lines.push(`description: ${quoteIfNeeded(data.description)}`);
  }
  if (data.type !== undefined) {
    lines.push(`type: ${data.type}`);
  }
  if (data.keywords && data.keywords.length) {
    const inline = `[${data.keywords.map(quoteIfNeeded).join(', ')}]`;
    lines.push(`keywords: ${inline}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function quoteIfNeeded(s: string): string {
  if (/[:#\-\[\]{},&*?|<>=!%@`]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
