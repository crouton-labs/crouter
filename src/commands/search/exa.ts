// The only module that talks to api.exa.ai. Owns API-key resolution, the three
// endpoint calls (/search, /answer, /contents), request shaping, and translation
// of HTTP/transport failures into the crtr error taxonomy. Leaves never build
// HTTP requests directly. Uses the Node global fetch — no HTTP dependency.

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { usage, network } from '../../core/errors.js';
import { userScopeRoot } from '../../core/scope.js';

const EXA_BASE = 'https://api.exa.ai';

/** Resolve the Exa API key: EXA_API_KEY env first, then ~/.crouter/exa.key.
 *  Never prompts and never proceeds keyless — throws a usage error naming both
 *  options when neither is present. */
export function getApiKey(): string {
  const env = process.env['EXA_API_KEY'];
  if (env !== undefined && env.trim() !== '') return env.trim();

  const keyFile = join(userScopeRoot(), 'exa.key');
  if (existsSync(keyFile)) {
    const fromFile = readFileSync(keyFile, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  }

  throw usage('no Exa API key found', {
    next: `Set the EXA_API_KEY environment variable, or write the key to ${keyFile}.`,
  });
}

/** One Exa result row as returned by /search and /contents. Fields are present
 *  only when the API supplies them. */
export interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  text?: string;
  score?: number;
}

export interface ExaSearchResponse {
  results?: ExaResult[];
}

export interface ExaAnswerResponse {
  answer?: string;
  citations?: Array<{ title?: string; url?: string }>;
}

/** Per-URL fetch status returned by /contents (and /search livecrawls). */
export interface ExaStatus {
  id?: string;
  status?: string;
  error?: { tag?: string; httpStatusCode?: number } | string;
}

export interface ExaContentsResponse {
  results?: ExaResult[];
  statuses?: ExaStatus[];
}

/** POST a JSON body to an Exa endpoint and return the parsed JSON. Any non-2xx
 *  response or transport failure becomes a crtr network error carrying Exa's
 *  status/message and a concrete recovery hint. */
async function exaPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = getApiKey();
  let res: Response;
  try {
    res = await fetch(`${EXA_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw network(`Exa request failed: ${msg}`, {
      next: 'Check network connectivity and retry. If it persists, simplify the query or reduce --num.',
    });
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* body unreadable — status line is enough */
    }
    throw network(`Exa returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`, {
      received: `HTTP ${res.status}`,
      next:
        res.status === 401
          ? 'The API key was rejected. Verify EXA_API_KEY or ~/.crouter/exa.key.'
          : 'Retry; if it persists, simplify the query, reduce --num, or drop domain filters.',
    });
  }

  return (await res.json()) as T;
}

export function exaSearch(body: Record<string, unknown>): Promise<ExaSearchResponse> {
  return exaPost<ExaSearchResponse>('/search', body);
}

export function exaAnswer(body: Record<string, unknown>): Promise<ExaAnswerResponse> {
  return exaPost<ExaAnswerResponse>('/answer', body);
}

export function exaContents(body: Record<string, unknown>): Promise<ExaContentsResponse> {
  return exaPost<ExaContentsResponse>('/contents', body);
}

/** Cap (characters) applied to full-text extraction so a single call cannot
 *  blow up the caller's context. Highlights remain the default content mode. */
export const TEXT_MAX_CHARACTERS = 4000;

/** Split a positional URL argument on commas or whitespace into a clean list. */
export function parseUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => u !== '');
}

/** Split a comma-separated domain flag into a clean list, or undefined when empty. */
export function parseDomains(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  return list.length > 0 ? list : undefined;
}

/** Render one result as agent-ready markdown: a numbered heading with title +
 *  metadata line, then highlights as bullets or capped text as a blockquote. */
export function renderResult(r: ExaResult, index: number): string {
  const lines: string[] = [];
  const title = r.title !== undefined && r.title !== '' ? r.title : '(untitled)';
  lines.push(`### ${index}. ${title}`);

  const meta: string[] = [];
  if (typeof r.url === 'string' && r.url !== '') meta.push(r.url);
  if (typeof r.publishedDate === 'string' && r.publishedDate !== '') meta.push(r.publishedDate.slice(0, 10));
  if (typeof r.author === 'string' && r.author !== '') meta.push(r.author);
  if (meta.length > 0) lines.push(meta.join(' · '));

  if (r.highlights !== undefined && r.highlights.length > 0) {
    for (const h of r.highlights) lines.push(`- ${h.replace(/\s+/g, ' ').trim()}`);
  } else if (r.text !== undefined && r.text !== '') {
    lines.push(r.text.trim());
  }
  return lines.join('\n');
}
