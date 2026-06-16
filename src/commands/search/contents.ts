import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import {
  exaContents,
  parseUrls,
  renderResult,
  TEXT_MAX_CHARACTERS,
  type ExaResult,
  type ExaStatus,
} from './exa.js';

export const contentsLeaf = defineLeaf({
  name: 'contents',
  description: 'extract clean content from URLs you already have',
  whenToUse:
    'you already hold one or more URLs — from a prior `search web`/`answer`, a database, an RSS feed, or user input — and need their cleaned content or highlights. This does NOT search; it only extracts from the URLs you give it. Reach for `web` when you still need to find the pages, and `answer` when you want a synthesized response rather than raw page content.',
  help: {
    name: 'search contents',
    summary: 'content extraction via Exa — cleaned highlights or full text for URLs you already have',
    params: [
      { kind: 'positional', name: 'urls', required: true, constraint: 'One or more URLs to extract, separated by commas or whitespace.' },
      { kind: 'flag', name: 'text', type: 'bool', required: false, constraint: `Return cleaned full page text (capped at ${TEXT_MAX_CHARACTERS} characters per URL) instead of highlight excerpts. Off by default.` },
      { kind: 'flag', name: 'max-age-hours', type: 'int', required: false, constraint: 'Maximum acceptable age of cached content, in hours; content older than this is freshly crawled. 0 forces a fresh crawl every time. Omit to use cache when available and crawl as fallback.' },
    ],
    output: [
      { name: 'results', type: 'object[]', required: true, constraint: 'One per successfully extracted URL, each: title, url, and either highlight excerpts (default) or capped full text (--text).' },
      { name: 'failures', type: 'object[]', required: true, constraint: 'URLs that could not be fetched, each: url and reason.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next command for retrying failures or refreshing stale content.' },
    ],
    outputKind: 'object',
    effects: ['Sends one contents request to the Exa API (network). No local state changes.'],
  },
  run: async (input) => {
    const urls = parseUrls(input['urls'] as string);
    if (urls.length === 0) throw usage('no URLs provided', { next: 'Pass one or more URLs separated by commas or whitespace.' });

    const wantText = input['text'] as boolean;
    const maxAgeHours = input['maxAgeHours'] as number | undefined;

    const body: Record<string, unknown> = { urls };
    if (wantText) body['text'] = { maxCharacters: TEXT_MAX_CHARACTERS };
    else body['highlights'] = true;
    if (maxAgeHours !== undefined) body['maxAgeHours'] = maxAgeHours;

    const res = await exaContents(body);
    const results = res.results ?? [];
    const fetched = new Set(results.map((r) => r.url).filter((u): u is string => u !== undefined));

    const failures: Array<{ url: string; reason: string }> = [];
    for (const s of res.statuses ?? []) {
      if (s.status === 'success') continue;
      const url = s.id ?? '(unknown url)';
      if (fetched.has(url)) continue;
      const reason =
        typeof s.error === 'string'
          ? s.error
          : s.error?.tag ?? s.status ?? 'unknown error';
      failures.push({ url, reason });
    }

    return {
      results,
      failures,
      follow_up:
        'Stale or empty content? Re-run with --max-age-hours 0 to force a fresh crawl. Need to find more pages? Use `crtr search web`.',
    };
  },
  render: (result) => {
    const results = result['results'] as ExaResult[];
    const failures = result['failures'] as Array<{ url: string; reason: string }>;
    const followUp = result['follow_up'] as string;

    const lines: string[] = [];
    if (results.length === 0) {
      lines.push('No content extracted.');
    } else {
      lines.push(`Extracted ${results.length} URL${results.length === 1 ? '' : 's'}:`, '');
      results.forEach((r, i) => {
        lines.push(renderResult(r, i + 1));
        lines.push('');
      });
    }

    if (failures.length > 0) {
      lines.push(`Failed (${failures.length}):`);
      for (const f of failures) lines.push(`- ${f.url} — ${f.reason}`);
      lines.push('');
    }

    lines.push(followUp);
    return lines.join('\n');
  },
});
