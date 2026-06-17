// Fallback content fetcher: when Exa cannot fetch a URL, we re-fetch it through
// pure.md (https://pure.md), which renders any page to clean markdown. This is
// the ONLY module that talks to pure.md. API-key resolution is optional — the
// service works keyless (rate-limited); a key raises limits.

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { userScopeRoot } from '../../core/scope.js';

const PUREMD_BASE = 'https://pure.md';

/** Resolve an optional pure.md API token: PUREMD_API_KEY env first, then
 *  ~/.crouter/puremd.key. Returns undefined when neither is set — pure.md is
 *  usable keyless, so a missing token is not an error. */
function getApiKey(): string | undefined {
  const env = process.env['PUREMD_API_KEY'];
  if (env !== undefined && env.trim() !== '') return env.trim();

  const keyFile = join(userScopeRoot(), 'puremd.key');
  if (existsSync(keyFile)) {
    const fromFile = readFileSync(keyFile, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  }
  return undefined;
}

export type PuremdResult = { ok: true; text: string } | { ok: false; reason: string };

/** Fetch a single URL's content as markdown via pure.md, capped at maxChars.
 *  Never throws — any transport or HTTP failure becomes { ok: false, reason }
 *  so the caller can keep the URL in its failures list. */
export async function puremdFetch(url: string, maxChars: number): Promise<PuremdResult> {
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key !== undefined) headers['x-puremd-api-token'] = key;

  let res: Response;
  try {
    res = await fetch(`${PUREMD_BASE}/${url}`, { headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `pure.md request failed: ${msg}` };
  }

  if (!res.ok) {
    return { ok: false, reason: `pure.md returned ${res.status} ${res.statusText}` };
  }

  let text: string;
  try {
    text = (await res.text()).trim();
  } catch {
    return { ok: false, reason: 'pure.md response body unreadable' };
  }

  if (text === '') return { ok: false, reason: 'pure.md returned empty content' };
  return { ok: true, text: text.slice(0, maxChars) };
}
