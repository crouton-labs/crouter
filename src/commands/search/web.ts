import { defineLeaf } from '../../core/command.js';
import {
  exaSearch,
  parseDomains,
  renderResult,
  TEXT_MAX_CHARACTERS,
  type ExaResult,
} from './exa.js';

const SEARCH_TYPES = ['auto', 'fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning'] as const;

export const webLeaf = defineLeaf({
  name: 'web',
  description: 'find web pages relevant to a query, with highlight excerpts',
  whenToUse:
    'you need to discover web pages relevant to a query and read query-matched excerpts from them — the default web search. Use this for open-ended research, finding sources, or gathering current information. Reach for `answer` instead when you want one synthesized, cited answer to a specific question rather than a ranked list of pages; reach for `contents` when you already hold the URLs and only need their content.',
  help: {
    name: 'search web',
    summary: 'web search via Exa — ranked results with query-relevant highlight excerpts (or full text)',
    params: [
      { kind: 'positional', name: 'query', required: true, constraint: 'The search query. Natural language; be specific.' },
      { kind: 'flag', name: 'type', type: 'enum', choices: [...SEARCH_TYPES], required: false, default: 'auto', constraint: 'Search depth. auto balances relevance and speed; fast/instant trade depth for latency; deep-lite/deep/deep-reasoning run multi-query expansion and rank the combined set for harder synthesis.' },
      { kind: 'flag', name: 'num', type: 'int', required: false, default: 10, constraint: 'Number of results to return.' },
      { kind: 'flag', name: 'text', type: 'bool', required: false, constraint: `Return cleaned full page text (capped at ${TEXT_MAX_CHARACTERS} characters per result) instead of highlight excerpts. Off by default; highlights keep token usage predictable.` },
      { kind: 'flag', name: 'include-domains', type: 'string', required: false, constraint: 'Comma-separated domain allowlist — restrict results to these domains.' },
      { kind: 'flag', name: 'exclude-domains', type: 'string', required: false, constraint: 'Comma-separated domain blocklist — drop results from these domains.' },
    ],
    output: [
      { name: 'query', type: 'string', required: true, constraint: 'Echo of the query searched.' },
      { name: 'results', type: 'object[]', required: true, constraint: 'Ranked best-first, each: title, url, published date and author when present, and either highlight excerpts (default) or capped full text (--text).' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next command — fetch full content of a result with `crtr search contents`, or refine the query.' },
    ],
    outputKind: 'object',
    effects: ['Sends one search request to the Exa API (network). No local state changes.'],
  },
  run: async (input) => {
    const query = input['query'] as string;
    const type = input['type'] as string;
    const num = input['num'] as number;
    const wantText = input['text'] as boolean;

    const contents = wantText
      ? { text: { maxCharacters: TEXT_MAX_CHARACTERS } }
      : { highlights: true };

    const body: Record<string, unknown> = { query, type, numResults: num, contents };
    const include = parseDomains(input['includeDomains'] as string | undefined);
    const exclude = parseDomains(input['excludeDomains'] as string | undefined);
    if (include !== undefined) body['includeDomains'] = include;
    if (exclude !== undefined) body['excludeDomains'] = exclude;

    const res = await exaSearch(body);
    const results = res.results ?? [];
    return {
      query,
      results,
      follow_up:
        'Fetch the full content of any result with `crtr search contents <url>`. No good hits? Broaden the query, drop domain filters, or try --type deep.',
    };
  },
  render: (result) => {
    const query = result['query'] as string;
    const results = result['results'] as ExaResult[];
    const followUp = result['follow_up'] as string;

    if (results.length === 0) {
      return `No results for "${query}".\n\n${followUp}`;
    }

    const lines = [`${results.length} results for "${query}":`, ''];
    results.forEach((r, i) => {
      lines.push(renderResult(r, i + 1));
      lines.push('');
    });
    lines.push(followUp);
    return lines.join('\n');
  },
});
