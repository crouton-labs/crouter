// Pagination helper for agent-facing paginated list leaves.
//
// Precondition: `allItemsSortedAscByKey` MUST be sorted ascending by the value
// `keyOf` returns. Sort order is part of each leaf's contract — this module
// trusts the caller. Violating the precondition produces silently wrong pages.
//
// Cursor design: encodes the stable sort key of the last-emitted item as
// base64url JSON `{k: <sortKey>}`. Resumption seeks the first item whose key
// is strictly greater than the cursor key — stable under inserts and deletes
// between pages (a deleted cursor key simply doesn't stall the scan; the next
// item after it is returned correctly).

import { CrtrError } from './errors.js';
import { ExitCode } from '../types.js';

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

/** Encodes a stable sort key into an opaque base64url cursor token. */
export function encodeCursor(key: string): string {
  const json = JSON.stringify({ k: key });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Decodes an opaque cursor token back to the sort key it encodes.
 *  Throws `CrtrError` with code `'invalid_cursor'` on malformed input. */
export function decodeCursor(token: string): string {
  let json: string;
  try {
    json = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new CrtrError(
      'invalid_cursor',
      'cursor could not be decoded.',
      ExitCode.USAGE,
      {
        received: token,
        next: 'Omit cursor to restart from the beginning.',
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CrtrError(
      'invalid_cursor',
      'cursor payload is not valid JSON.',
      ExitCode.USAGE,
      {
        received: token,
        next: 'Omit cursor to restart from the beginning.',
      },
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('k' in parsed) ||
    typeof (parsed as Record<string, unknown>).k !== 'string'
  ) {
    throw new CrtrError(
      'invalid_cursor',
      'cursor payload is missing required key field.',
      ExitCode.USAGE,
      {
        received: token,
        next: 'Omit cursor to restart from the beginning.',
      },
    );
  }

  return (parsed as { k: string }).k;
}

// ---------------------------------------------------------------------------
// paginate
// ---------------------------------------------------------------------------

export interface PaginateResult<T> {
  items: T[];
  next_cursor: string | null;
  total: number | null;
}

export interface PaginateOpts<T> {
  /** Default page size when `params.limit` is absent. */
  defaultLimit: number;
  /** Hard cap; `params.limit` is clamped to [1, maxLimit]. */
  maxLimit: number;
  /** Returns the stable sort key for an item. Must match the sort order of the
   *  input array — ascending by this key. */
  keyOf: (item: T) => string;
  /** 'count' → compute and return `total`; 'omit' → return `null`. */
  total: 'count' | 'omit';
}

/**
 * Returns one page of items from a pre-sorted list, with a stable opaque
 * cursor for resumption.
 *
 * @param allItemsSortedAscByKey - Full dataset, sorted ascending by `keyOf`.
 * @param params - Agent-supplied `{ limit?, cursor? }` from stdin.
 * @param opts - Caller-supplied configuration (limits, key extractor, total).
 */
export function paginate<T>(
  allItemsSortedAscByKey: T[],
  params: { limit?: number; cursor?: string },
  opts: PaginateOpts<T>,
): PaginateResult<T> {
  // Resolve effective limit: clamp to [1, maxLimit], default when absent.
  const rawLimit = params.limit !== undefined ? params.limit : opts.defaultLimit;
  const effectiveLimit = Math.min(Math.max(1, rawLimit), opts.maxLimit);

  // Resolve start position from cursor.
  let startIndex = 0;
  if (params.cursor !== undefined) {
    const cursorKey = decodeCursor(params.cursor); // throws CrtrError on bad cursor
    // Find the first item whose key is strictly greater than cursorKey.
    // Linear scan; callers with large datasets should pre-filter upstream.
    startIndex = allItemsSortedAscByKey.findIndex(
      (item) => opts.keyOf(item) > cursorKey,
    );
    if (startIndex === -1) {
      // All items are at or before the cursor key — list is exhausted.
      startIndex = allItemsSortedAscByKey.length;
    }
  }

  const page = allItemsSortedAscByKey.slice(startIndex, startIndex + effectiveLimit);

  // next_cursor: null is the ONLY end-of-list signal.
  let next_cursor: string | null = null;
  if (page.length === effectiveLimit && startIndex + effectiveLimit < allItemsSortedAscByKey.length) {
    const lastKey = opts.keyOf(page[page.length - 1]);
    next_cursor = encodeCursor(lastKey);
  }

  const total: number | null =
    opts.total === 'count' ? allItemsSortedAscByKey.length : null;

  return { items: page, next_cursor, total };
}
