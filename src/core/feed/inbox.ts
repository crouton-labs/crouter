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
import { randomUUID } from 'node:crypto';
import { inboxPath } from '../canvas/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxTier = 'critical' | 'urgent' | 'normal' | 'deferred';
export type InboxKind = 'update' | 'urgent' | 'final' | 'message' | 'completed';

/** A single inbox entry — a pointer, not a copy of the content. */
export interface InboxEntry {
  /** Short stable handle for addressing this entry from the CLI (`feed message
   *  <id>`). Set when the entry carries an inline body too long to fully inline
   *  in the digest, so the receiver can read the full text back by id. */
  id?: string;
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

  // A message that carries an inline body the digest will clip needs a stable
  // handle so the receiver can read the full text back (`feed message <id>`).
  if (full.id === undefined && bodyExceedsPreview(full)) full.id = randomUUID().slice(0, 8);

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

/** Find one inbox entry by its short `id` handle (see `feed message <id>`). */
export function readInboxEntryById(nodeId: string, id: string): InboxEntry | undefined {
  return readInboxSince(nodeId, undefined).find((e) => e.id === id);
}

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

/** Bounds for inlining a message body's preview in the digest. */
const BODY_MAX_LINES = 12;
const BODY_MAX_CHARS = 1000;

/** The inline body an entry carries (a direct msg / system alert), trimmed.
 *  Empty for a push pointer (whose body lives at `ref`) or a one-line entry
 *  whose `label` already IS the whole message. */
function inlineBody(e: Pick<InboxEntry, 'data' | 'label'>): string {
  const body = typeof e.data?.['body'] === 'string' ? (e.data['body'] as string).trim() : '';
  return body === '' || body === e.label ? '' : body;
}

/** True when an entry's inline body is long enough that the digest will clip it
 *  — the trigger for minting an addressable `id` so the full text stays
 *  recoverable via `feed message <id>`. */
export function bodyExceedsPreview(e: Pick<InboxEntry, 'data' | 'label'>): boolean {
  const body = inlineBody(e);
  return body !== '' && clipBody(body).clipped;
}

/** Clip a body to a bounded preview, reporting whether anything was dropped. */
export function clipBody(body: string): { text: string; clipped: boolean } {
  let text = body;
  let clipped = false;
  const lines = text.split('\n');
  if (lines.length > BODY_MAX_LINES) {
    text = lines.slice(0, BODY_MAX_LINES).join('\n');
    clipped = true;
  }
  if (text.length > BODY_MAX_CHARS) {
    text = text.slice(0, BODY_MAX_CHARS);
    clipped = true;
  }
  return { text: text.trimEnd(), clipped };
}

/**
 * Render one entry's digest line(s).
 *
 * A push pointer (has a `ref`) stays a pointer — the body lives in the report
 * file, dereferenced on demand by reading that path. A direct `node msg` or
 * system alert has NO report to dereference; its full body lives in the
 * inbox.jsonl entry itself (`data.body`), so we inline a bounded preview. When
 * that preview clips, the entry carries a short `id` and we point at the CLI
 * command that reads the full body back from the jsonl (`feed message <id>`).
 */
function renderEntry(e: InboxEntry): string {
  const body = inlineBody(e);
  if (body === '') {
    return e.ref !== undefined
      ? `  [${e.kind}] ${e.label}  (ref: ${e.ref})`
      : `  [${e.kind}] ${e.label}`;
  }
  const { text, clipped } = clipBody(body);
  const indented = text.split('\n').map((l) => `    ${l}`).join('\n');
  const more = clipped
    ? (e.id !== undefined
        ? `\n    … (clipped — full message: \`crtr feed message ${e.id}\`)`
        : '\n    … (body clipped)')
    : '';
  return `  [${e.kind}]\n${indented}${more}`;
}

/**
 * Render many unread inbox pointers into one compact digest string.
 *
 * Format (per sender group):
 *   From <sender> — <N> update(s):
 *     [<kind>] <label>  (ref: <path>)        ← push: pointer, dereference the ref
 *     [<kind>]                                ← ref-less msg: full body inlined
 *       <body line>
 *     …
 */
export function coalesce(entries: InboxEntry[]): string {
  if (entries.length === 0) return '(inbox empty)';

  // Group by `from` (null → 'system').
  const groups = new Map<string, InboxEntry[]>();
  for (const e of entries) {
    const key = e.from ?? 'system';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const sections: string[] = [];
  for (const [sender, items] of groups) {
    const lines = items.map(renderEntry);
    sections.push(`From ${sender} — ${items.length} update${items.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
