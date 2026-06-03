// Per-node inbox.jsonl primitive for the pi-native canvas runtime.
//
// An inbox entry is a lightweight POINTER (~30 tokens), never content.
// The report body lives in nodes/<id>/reports/; the inbox line carries only
// enough to find it and decide whether to dereference.
//
// Layout:
//   nodes/<id>/inbox.jsonl          — one JSON line per entry, append-only
//   nodes/<id>/inbox.jsonl.cursor   — ISO 8601 of last-read entry (sidecar)

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { inboxPath } from '../canvas/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxTier = 'critical' | 'urgent' | 'normal' | 'deferred';
export type InboxKind = 'update' | 'urgent' | 'final' | 'message' | 'completed';

/** A single inbox entry — a pointer, not a copy of the content. */
export interface InboxEntry {
  /** ISO 8601 timestamp of delivery. */
  ts: string;
  /** Node id of the sender, or null for system-generated entries. */
  from: string | null;
  /** Priority band for the receiver's attention. */
  tier: InboxTier;
  /** Semantic kind of the push event. */
  kind: InboxKind;
  /** Absolute path to the report file, when this entry is a push pointer. */
  ref?: string;
  /** First ~80 chars of the body's first line — enough to decide if it matters. */
  label: string;
  /** Arbitrary structured payload for non-push message entries. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cursor sidecar path
// ---------------------------------------------------------------------------

function cursorPath(nodeId: string): string {
  return `${inboxPath(nodeId)}.cursor`;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Atomically append one inbox entry to `nodes/<nodeId>/inbox.jsonl`.
 * Fills `ts` (current ISO time). Returns the completed entry.
 */
export function appendInbox(nodeId: string, entry: Omit<InboxEntry, 'ts'>): InboxEntry {
  const full: InboxEntry = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + '\n';

  // Ensure the parent directory exists (inbox.jsonl lives directly under the
  // node dir, which ensureNodeDirs creates — but guard anyway for callers that
  // haven't yet scaffolded the node).
  const dir = dirname(inboxPath(nodeId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // appendFileSync is atomic within a single process (a single write(2) call for
  // a short line is atomic on POSIX). For multi-process safety we rely on the
  // OS-level append guarantee (O_APPEND) which Node honours via 'a' flag.
  appendFileSync(inboxPath(nodeId), line, { encoding: 'utf8', flag: 'a' });

  return full;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Return all inbox entries strictly after `cursorIso`.
 * When `cursorIso` is undefined, returns every entry in the file.
 */
export function readInboxSince(nodeId: string, cursorIso?: string): InboxEntry[] {
  const p = inboxPath(nodeId);
  if (!existsSync(p)) return [];

  const raw = readFileSync(p, 'utf8');
  const entries: InboxEntry[] = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as InboxEntry);

  if (cursorIso === undefined) return entries;

  // Entries are appended in chronological order; filter to those strictly
  // after the cursor. We compare ISO strings lexicographically (valid for UTC).
  return entries.filter((e) => e.ts > cursorIso);
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

/**
 * Read the persisted cursor ISO for a node's inbox.
 * Returns undefined if no cursor file exists yet.
 */
export function readCursor(nodeId: string): string | undefined {
  const p = cursorPath(nodeId);
  if (!existsSync(p)) return undefined;
  const val = readFileSync(p, 'utf8').trim();
  return val !== '' ? val : undefined;
}

/**
 * Persist a new cursor ISO for a node's inbox (atomic tmp+rename).
 */
export function writeCursor(nodeId: string, iso: string): void {
  const p = cursorPath(nodeId);
  const tmp = `${p}.tmp`;
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tmp, iso, 'utf8');
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Coalesce
// ---------------------------------------------------------------------------

/**
 * Render many unread inbox pointers into one compact digest string.
 *
 * Format (per sender group):
 *   From <sender> — <N> update(s):
 *     [<kind>] <label>  (ref: <path>)
 *     …
 *
 * A header line announces the total count and instructs the receiver to
 * dereference only what matters.
 */
export function coalesce(entries: InboxEntry[]): string {
  if (entries.length === 0) return '(inbox empty)';

  const header = `${entries.length} update${entries.length === 1 ? '' : 's'} since last read — dereference what matters.\n`;

  // Group by `from` (null → 'system').
  const groups = new Map<string, InboxEntry[]>();
  for (const e of entries) {
    const key = e.from ?? 'system';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const sections: string[] = [];
  for (const [sender, items] of groups) {
    const lines = items.map((e) => {
      const refPart = e.ref !== undefined ? `  (ref: ${e.ref})` : '';
      return `  [${e.kind}] ${e.label}${refPart}`;
    });
    sections.push(`From ${sender} — ${items.length} update${items.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
  }

  return header + sections.join('\n\n');
}
