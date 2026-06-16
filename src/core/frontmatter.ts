import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export interface ParsedFrontmatterGeneric {
  /** Raw, uncoerced key/value record from the YAML block (null when absent). */
  data: Record<string, unknown> | null;
  body: string;
  raw: string;
}

/** Parse a frontmatter block as a raw key/value record. */
export function parseFrontmatterGeneric(source: string): ParsedFrontmatterGeneric {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { data: null, body: source, raw: '' };
  }
  const raw = match[1];
  const body = source.slice(match[0].length);
  return { data: parseYamlBlock(raw), body, raw };
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
