// Claude SKILL.md → crouter substrate-doc mapping (design §2.3).
// Pure, unit-testable. The bridge command (`crtr pkg bridge sync`) runs this
// unattended every session, so the description→read-routing reshape is a
// deterministic, conservative string rewrite — NOT a content paraphrase. An
// author who wants durable tuning uses an INDEX (which the bridge never
// touches), because a generator-stamped leaf is overwritten on the next sync.

export interface BridgeSkillInput {
  /** Source skill `name` frontmatter (identity only; not emitted as a field). */
  name: string;
  /** Source skill `description` frontmatter — the text we reshape + carry. */
  description: string;
  /** The skill body, copied verbatim below the generated frontmatter. */
  body: string;
}

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
function toShortForm(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

/** Always-double-quote a YAML scalar, escaping backslashes and quotes. The two
 *  generated fields are single-line, so this is safe regardless of colons,
 *  commas, or other YAML-significant characters. */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Map a parsed Claude SKILL.md to a crouter substrate-doc string: full
 *  frontmatter (kind/when-and-why/short-form/visibility/generator) + the copied
 *  body. Deterministic and pure. */
export function buildBridgeDoc(input: BridgeSkillInput): string {
  const whenAndWhy = reshapeWhenAndWhy(input.description);
  const shortForm = toShortForm(input.description);
  const fm = [
    '---',
    'kind: skill',
    `when-and-why-to-read: ${yamlQuote(whenAndWhy)}`,
    `short-form: ${yamlQuote(shortForm)}`,
    'system-prompt-visibility: name',
    'file-read-visibility: none',
    'generator: claude-bridge',
    '---',
    '',
  ].join('\n');
  const body = input.body.replace(/^\n+/, '');
  const trailing = body.endsWith('\n') ? '' : '\n';
  return fm + '\n' + body + trailing;
}
