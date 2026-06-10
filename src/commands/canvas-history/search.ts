import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import {
  buildCorpus,
  type HistoryArtifact,
  type HistorySource,
  type ScopeFilter,
  type CorpusFilter,
} from '../../core/canvas/index.js';
import type { NodeStatus } from '../../core/canvas/index.js';

const TYPES: HistorySource[] = ['report', 'doc', 'roadmap', 'meta'];
const NODE_KINDS = ['developer', 'spec', 'design', 'review', 'explore', 'plan', 'general'];
const STATUSES: NodeStatus[] = ['active', 'idle', 'done', 'dead', 'canceled'];
const SORTS = ['relevance', 'recency', 'oldest'];
const REL_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000,
};

/** ISO 8601 (`2026-06-01`) → epoch ms (absolute); relative (`7d`, `2w`, `1mo`)
 *  → now minus the duration. Throws usage on an unparseable value. */
function parseWhen(field: string, raw: string): number {
  const rel = raw.match(/^(\d+)(mo|[smhdwy])$/);
  if (rel !== null) return Date.now() - Number(rel[1]) * REL_UNITS[rel[2]];
  const abs = Date.parse(raw);
  if (!Number.isNaN(abs)) return abs;
  throw usage(`--${field} must be ISO 8601 (2026-06-01) or relative (7d, 2w, 1mo); received: ${raw}`);
}

function splitCsv(v: string | undefined): string[] | undefined {
  if (v === undefined || v === '') return undefined;
  return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}
function decodeCursor(c: string): number {
  const n = Number(Buffer.from(c, 'base64').toString('utf8'));
  if (!Number.isInteger(n) || n < 0) throw usage(`invalid --cursor: ${c}`);
  return n;
}

/** One snippet block: the matching line(s), `lines` deep. Falls back to the
 *  title or the first body lines when nothing matched on the body. */
function snippet(a: HistoryArtifact, terms: string[], lines: number): string {
  const body = a.loadBody();
  const rows = body.split('\n');
  if (terms.length > 0) {
    const idx = rows.findIndex((r) => {
      const lc = r.toLowerCase();
      return terms.some((t) => lc.includes(t));
    });
    if (idx !== -1) {
      return rows
        .slice(idx, idx + lines)
        .map((r) => r.trim())
        .filter((r) => r !== '')
        .join(' ⏎ ');
    }
  }
  const lead = rows.map((r) => r.trim()).filter((r) => r !== '').slice(0, lines).join(' ⏎ ');
  return lead !== '' ? lead : a.title;
}

function sortArtifacts(arts: HistoryArtifact[], mode: string, scored?: Map<string, number>): HistoryArtifact[] {
  const out = [...arts];
  if (mode === 'relevance' && scored !== undefined) {
    out.sort((x, y) => (scored.get(y.ref) ?? 0) - (scored.get(x.ref) ?? 0) || y.tsMs - x.tsMs || x.ref.localeCompare(y.ref));
  } else if (mode === 'oldest') {
    out.sort((x, y) => x.tsMs - y.tsMs || x.ref.localeCompare(y.ref));
  } else {
    out.sort((x, y) => y.tsMs - x.tsMs || x.ref.localeCompare(y.ref));
  }
  return out;
}

export const searchLeaf = defineLeaf({
  name: 'search',
  description: 'ranked content search across the cwd\'s node history',
  whenToUse:
    'you want to find past work by what it SAYS — a design, a final report, a roadmap, a finding — across every node that ran in this cwd, ranked by relevance. Omit the query to browse the record by recency ("what happened here lately"). Narrow with --type/--kind/--status/--since, scope elsewhere with --cwd/--all-cwds/--under/--node, or switch to --grep for an exact regex over bodies. Use `canvas history read <ref>` to read a hit in full, `canvas history show <node-id>` to list one node\'s artifacts, and `canvas revive <id>` to reopen a node you found.',
  help: {
    name: 'canvas history search',
    summary: 'ranked/filtered/sorted content search over the per-cwd episodic record (reports + context docs + meta)',
    params: [
      { kind: 'positional', name: 'query', required: false, constraint: 'Whitespace-separated terms, matched case-insensitively and weighted across node name/description, report titles, and doc headings (and full bodies with --body); artifacts matching more/stronger fields rank higher. Omit to browse by recency (no relevance ranking; --sort still applies). Under --grep: an ECMAScript regex matched against bodies (line hits).' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Search another project\'s record. Default: the calling node\'s cwd (process cwd when not a node). Mutually exclusive with --all-cwds.' },
      { kind: 'flag', name: 'all-cwds', type: 'bool', required: false, constraint: 'Search every cwd on the canvas. Mutually exclusive with --cwd.' },
      { kind: 'flag', name: 'under', type: 'string', required: false, constraint: 'Restrict to a node and its subscription descendants (one initiative / sub-DAG).' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Restrict to specific node ids. Comma-separated for several.' },
      { kind: 'flag', name: 'type', type: 'string', required: false, constraint: `Corpus to search; comma-separated for several. One of: ${TYPES.join(', ')}. report = push history; doc = context artifacts; roadmap = roadmap.md specifically; meta = node name/description/kind. Default: all.` },
      { kind: 'flag', name: 'report-kind', type: 'enum', choices: ['final', 'update'], required: false, constraint: 'Narrow reports to outcome summaries (final) or progress (update). Implies --type report.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: `Node kind; comma-separated for several. One of: ${NODE_KINDS.join(', ')}.` },
      { kind: 'flag', name: 'status', type: 'string', required: false, constraint: `Node lifecycle status; comma-separated for several. One of: ${STATUSES.join(', ')} (e.g. done = completed work only).` },
      { kind: 'flag', name: 'since', type: 'string', required: false, constraint: 'Lower bound on artifact timestamp. ISO 8601 (2026-06-01) or relative (7d, 2w, 1mo).' },
      { kind: 'flag', name: 'until', type: 'string', required: false, constraint: 'Upper bound on artifact timestamp. ISO 8601 or relative.' },
      { kind: 'flag', name: 'grep', type: 'bool', required: false, constraint: 'Treat the query as an ECMAScript regex matched against bodies (one hit per matching line) instead of weighted ranking. Requires a query. Mutually exclusive with --body.' },
      { kind: 'flag', name: 'body', type: 'bool', required: false, constraint: 'Also weigh full body text in the ranking (default weighs name/title/heading only). Ignored under --grep.' },
      { kind: 'flag', name: 'sort', type: 'enum', choices: SORTS, required: false, constraint: 'relevance (default with a query) ranks by score; recency (default without a query) / oldest order by artifact timestamp.' },
      { kind: 'flag', name: 'snippet-lines', type: 'int', required: false, default: 1, constraint: 'Context lines per hit. Default 1.' },
      { kind: 'flag', name: 'full', type: 'bool', required: false, constraint: 'Inline each hit\'s full body. Off by default; pair with a small --limit. Ignored under --grep.' },
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 20, constraint: 'Page size. Default 20, hard max 100.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Opaque token from a prior next_cursor; omit on the first call.' },
    ],
    output: [
      { name: 'hits', type: 'object[]', required: true, constraint: 'Ranked/sorted hits, each: {ref, node, kind, source, ts, score?, snippet}. Under --grep: {ref, node, ts, line, text} per matching body line, sorted by ref then line. ref is the <node-id>:<relpath> handle passed verbatim to `canvas history read`.' },
      { name: 'next_cursor', type: 'string|null', required: true, constraint: 'Token for the next page; null is the only end-of-list signal.' },
      { name: 'total', type: 'int', required: true, constraint: 'Total matching artifacts (exact).' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const query = ((input['query'] as string | undefined) ?? '').trim();
    const cwd = input['cwd'] as string | undefined;
    const allCwds = input['allCwds'] === true;
    const under = input['under'] as string | undefined;
    const nodes = splitCsv(input['node'] as string | undefined);
    const grep = input['grep'] === true;
    const weighBody = input['body'] === true;
    const full = input['full'] === true;
    const snippetLines = Math.max(1, (input['snippetLines'] as number | undefined) ?? 1);
    const limit = Math.min(100, Math.max(1, (input['limit'] as number | undefined) ?? 20));
    const cursor = input['cursor'] as string | undefined;

    if (cwd !== undefined && allCwds) throw usage('--cwd and --all-cwds are mutually exclusive.');
    if (grep && weighBody) throw usage('--grep and --body are mutually exclusive (--grep always scans bodies).');
    if (grep && query === '') throw usage('--grep requires a query (the regex). Omit --grep to browse by recency.');

    const reportKind = input['reportKind'] as string | undefined;
    const types = splitCsv(input['type'] as string | undefined) as HistorySource[] | undefined;
    if (types !== undefined) {
      const bad = types.find((t) => !TYPES.includes(t));
      if (bad !== undefined) throw usage(`--type must be one of: ${TYPES.join(', ')}; received: ${bad}`);
    }
    const scope: ScopeFilter = { cwd, allCwds, under, nodes };
    const corpus: CorpusFilter = {
      types,
      reportKind,
      kinds: splitCsv(input['kind'] as string | undefined),
      statuses: splitCsv(input['status'] as string | undefined) as NodeStatus[] | undefined,
      sinceMs: input['since'] !== undefined ? parseWhen('since', input['since'] as string) : undefined,
      untilMs: input['until'] !== undefined ? parseWhen('until', input['until'] as string) : undefined,
    };

    const arts = buildCorpus(scope, corpus);
    const offset = cursor !== undefined ? decodeCursor(cursor) : 0;

    // --- grep mode: regex over bodies, one row per matching line ---
    if (grep) {
      let re: RegExp;
      try {
        re = new RegExp(query, 'i');
      } catch {
        throw usage(`invalid regex pattern: ${query}`);
      }
      const lineHits: Array<{ ref: string; node: string; ts: string; line: number; text: string }> = [];
      for (const a of arts) {
        const rows = a.loadBody().split('\n');
        rows.forEach((text, i) => {
          if (re.test(text)) lineHits.push({ ref: a.ref, node: `${a.nodeName} (${a.nodeId})`, ts: a.ts, line: i + 1, text: text.trim() });
        });
      }
      lineHits.sort((x, y) => x.ref.localeCompare(y.ref) || x.line - y.line);
      const page = lineHits.slice(offset, offset + limit);
      const nextCursor = offset + limit < lineHits.length ? encodeCursor(offset + limit) : null;
      return {
        hits: page,
        next_cursor: nextCursor,
        total: lineHits.length,
        follow_up: 'Read a hit with `canvas history read <ref>`. Drop --grep for a ranked topic search; narrow with `canvas history search -h`.',
      };
    }

    // --- ranked / browse mode ---
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    let pool = arts;
    let scored: Map<string, number> | undefined;
    const sortMode = (input['sort'] as string | undefined) ?? (terms.length > 0 ? 'relevance' : 'recency');

    if (terms.length > 0 && sortMode === 'relevance') {
      scored = new Map();
      const matched: HistoryArtifact[] = [];
      for (const a of arts) {
        const titleLc = a.title.toLowerCase();
        const nameLc = a.nodeName.toLowerCase();
        const descLc = a.nodeDesc.toLowerCase();
        const bodyLc = weighBody ? a.loadBody().toLowerCase() : null;
        let score = 0;
        for (const t of terms) {
          if (titleLc.includes(t)) score += 10;
          if (nameLc.includes(t)) score += 5;
          if (descLc.includes(t)) score += 3;
          if (bodyLc !== null && bodyLc.includes(t)) score += 1;
        }
        if (score > 0) {
          scored.set(a.ref, score);
          matched.push(a);
        }
      }
      pool = matched;
    } else if (terms.length > 0) {
      // Query present but a timeline sort requested: filter by match, order by ts.
      pool = arts.filter((a) => {
        const hay = `${a.title}\n${a.nodeName}\n${a.nodeDesc}${weighBody ? '\n' + a.loadBody() : ''}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    }

    const sorted = sortArtifacts(pool, sortMode, scored);
    const page = sorted.slice(offset, offset + limit);
    const nextCursor = offset + limit < sorted.length ? encodeCursor(offset + limit) : null;

    const hits = page.map((a) => {
      const base: Record<string, unknown> = {
        ref: a.ref,
        node: `${a.nodeName} (${a.nodeId})`,
        kind: a.nodeKind,
        source: a.source === 'report' && a.reportKind ? `report:${a.reportKind}` : a.source,
        ts: a.ts,
      };
      if (sortMode === 'relevance' && scored !== undefined) base['score'] = scored.get(a.ref) ?? 0;
      if (full) base['body'] = a.loadBody();
      else base['snippet'] = snippet(a, terms, snippetLines);
      return base;
    });

    return {
      hits,
      next_cursor: nextCursor,
      total: sorted.length,
      follow_up: 'Read a hit with `canvas history read <ref>`; narrow with `canvas history search -h`.',
    };
  },
  render: (r) => renderSearch(r),
});

function renderSearch(r: Record<string, unknown>): string {
  const hits = r['hits'] as Record<string, unknown>[];
  const total = r['total'] as number;
  const nextCursor = r['next_cursor'] as string | null;
  const full = hits.length > 0 && Object.prototype.hasOwnProperty.call(hits[0], 'body');
  const parts: string[] = [];

  if (hits.length === 0) {
    parts.push('0 hits.');
  } else if (full) {
    parts.push(`${hits.length} of ${total} hits:`);
    for (const h of hits) {
      const head = `### ${h['ref']}\n- node: ${h['node']}  |  kind: ${h['kind']}  |  source: ${h['source']}  |  ts: ${h['ts']}`;
      parts.push(`${head}\n\n${String(h['body'] ?? '').trim()}`);
    }
  } else {
    parts.push(`${hits.length} of ${total} hits:`);
    const cols = Object.keys(hits[0]).filter((c) => c !== 'body');
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = hits
      .map((h) => `| ${cols.map((c) => String(h[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
      .join('\n');
    parts.push(`${head}\n${sep}\n${body}`);
  }

  parts.push(`- next_cursor: ${nextCursor ?? 'null'}\n- total: ${total}`);
  parts.push(String(r['follow_up']));
  return parts.join('\n\n');
}
