import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { listAllMemoryDocs } from '../../core/memory-resolver.js';
import { parseSubstrateDoc } from '../../core/substrate/index.js';
import type { SubstrateDoc } from '../../core/substrate/index.js';
import type { Scope } from '../../types.js';
import { MEMORY_KINDS } from './shared.js';

// A unit in the search space: a substrate memory document, normalized to the
// fields find ranks/returns.
interface Unit {
  name: string;
  kind: string;
  scope: Scope;
  path: string;
  /** Read-routing line (substrate `when-and-why-to-read`; skill description). */
  routing: string;
  /** Hook shown in results (substrate short-form; skill description). */
  shortForm: string;
  /** Frontmatter-stripped body, loaded lazily for --body / --grep. */
  loadBody: () => string;
}

function substrateUnit(d: SubstrateDoc): Unit {
  return {
    name: d.name,
    kind: d.kind,
    scope: d.scope,
    path: d.path,
    routing: d.whenAndWhyToRead,
    shortForm: d.shortForm,
    loadBody: () => d.body,
  };
}

/** The candidate set: every substrate memory document (native + plugin, supplied
 *  by listAllMemoryDocs), optionally narrowed to one kind. find searches
 *  EVERYTHING — it never applies gate or visibility-rung filtering (design
 *  §11#3).
 *
 *  Dedup by (scope, name): native and plugin docs of the same scope can collide
 *  on identity. The FIRST unit encountered for a given identity wins — native
 *  before plugin, which mirrors the memory resolver's own precedence. */
function candidates(kindFilter: string | undefined): Unit[] {
  const seen = new Set<string>(); // "scope/name" → first wins
  const add = (u: Unit): void => {
    const id = `${u.scope}/${u.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    units.push(u);
  };

  const units: Unit[] = [];
  for (const doc of listAllMemoryDocs()) {
    const sub = parseSubstrateDoc(doc);
    if (sub === null) continue;
    if (kindFilter !== undefined && sub.kind !== kindFilter) continue;
    add(substrateUnit(sub));
  }
  return units;
}

export const findLeaf = defineLeaf({
  name: 'find',
  description: 'relevance search across memory documents',
  whenToUse:
    'you do not yet know which document applies and need to discover what is stored — ranks documents by relevance, weighted over name, the read-routing line, and short-form (add --body to also weigh body text). Searches the full scope set regardless of any visibility gate. Use --grep instead when you need an exact regex or literal-string match across document bodies rather than a ranked topic match.',
  help: {
    name: 'memory find',
    summary: 'relevance search across memory documents, weighted over name/routing-line/short-form (and body with --body)',
    params: [
      { kind: 'positional', name: 'query', required: true, constraint: 'With ranked search (default): whitespace-separated terms, matched case-insensitively and weighted over name, the read-routing line, and short-form (plus body with --body); documents matching more/stronger fields rank higher. With --grep: an ECMAScript regex applied to each document body line.' },
      { kind: 'flag', name: 'kind', type: 'enum', choices: [...MEMORY_KINDS], required: false, constraint: 'Filter to a single kind. Default: all kinds.' },
      { kind: 'flag', name: 'grep', type: 'bool', required: false, constraint: 'Treat the query as an ECMAScript regex and match it against document bodies, instead of weighted relevance ranking. Mutually exclusive with --body.' },
      { kind: 'flag', name: 'body', type: 'bool', required: false, constraint: 'Also weigh document body text in the relevance ranking (in addition to name/when/why/short-form). Ignored under --grep, which always scans bodies.' },
    ],
    output: [
      { name: 'query', type: 'string', required: true, constraint: 'Echo of the input query.' },
      { name: 'hits', type: 'object[]', required: true, constraint: 'Ranked mode — each: {name, kind, scope, score, short_form}, sorted by score descending. Under --grep instead — each: {path, line, text} for every body line matching the regex, sorted by path then line ascending.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands for reading a hit in full or refining the search.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const query = input['query'] as string;
    const kindFilter = input['kind'] as string | undefined;
    const grep = input['grep'] as boolean;
    const weighBody = input['body'] as boolean;

    if (grep && weighBody) {
      throw usage('--grep and --body are mutually exclusive (--grep always scans bodies).');
    }

    const units = candidates(kindFilter);

    // --- grep mode: regex over every unit's body, one row per matching line ---
    if (grep) {
      let regex: RegExp;
      try {
        regex = new RegExp(query);
      } catch {
        throw usage(`invalid regex pattern: ${query}`);
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const u of units) {
        const lines = u.loadBody().split('\n');
        lines.forEach((text, idx) => {
          if (regex.test(text)) matches.push({ path: u.path, line: idx + 1, text });
        });
      }
      matches.sort((a, b) => {
        const pc = a.path.localeCompare(b.path);
        return pc !== 0 ? pc : a.line - b.line;
      });
      return {
        query,
        hits: matches,
        follow_up: 'Read a document in full with `crtr memory read <name>`. Drop --grep for a ranked topic search.',
      };
    }

    // --- ranked mode: weighted relevance over name/routing-line/short-form(+body) ---
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) throw usage('query must contain at least one non-whitespace term');

    interface Hit {
      unit: Unit;
      score: number;
    }
    const hits: Hit[] = [];
    for (const u of units) {
      const nameLc = u.name.toLowerCase();
      const routingLc = u.routing.toLowerCase();
      const shortLc = u.shortForm.toLowerCase();
      const bodyLc = weighBody ? u.loadBody().toLowerCase() : null;
      let score = 0;
      for (const term of terms) {
        if (nameLc.includes(term)) score += 10;
        if (routingLc.includes(term)) score += 5;
        if (shortLc.includes(term)) score += 3;
        if (bodyLc !== null && bodyLc.includes(term)) score += 1;
      }
      if (score > 0) hits.push({ unit: u, score });
    }
    hits.sort((a, b) => b.score - a.score || a.unit.name.localeCompare(b.unit.name));

    return {
      query,
      hits: hits.map((h) => ({
        name: h.unit.name,
        kind: h.unit.kind,
        scope: h.unit.scope,
        score: h.score,
        short_form: h.unit.shortForm,
      })),
      follow_up: 'Read a hit in full with `crtr memory read <name>`. Add --body to weigh body text, or --grep for an exact regex.',
    };
  },
});
