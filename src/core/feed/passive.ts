// Per-node passive-subscription accumulator for the pi-native canvas runtime.
//
// A PASSIVE subscription (the `active=false` flavor of a subscribes_to edge)
// must never WAKE its subscriber. So when `push` fans out, a passive
// subscriber's pointer is written here — to nodes/<id>/passive.jsonl — instead
// of inbox.jsonl. The inbox-watcher polls only inbox.jsonl, so nothing here
// triggers a turn.
//
// The accumulator is drained the moment the node is next MESSAGED: the
// canvas-passive-context extension reads + clears this file on pi's `input`
// event and injects every entry as timestamped XML pre-text before the message
// reaches the LLM. Until then entries simply pile up, oldest first.
//
// Same entry shape as the inbox (InboxEntry) so the two stores stay symmetric
// and a passive edge can be flipped active without reshaping data.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { passivePath } from '../canvas/index.js';
import type { InboxEntry } from './inbox.js';

/**
 * Atomically append one entry to `nodes/<nodeId>/passive.jsonl`.
 * Fills `ts` (current ISO time). Returns the completed entry.
 */
export function appendPassive(nodeId: string, entry: Omit<InboxEntry, 'ts'>): InboxEntry {
  const full: InboxEntry = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + '\n';

  const dir = dirname(passivePath(nodeId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  appendFileSync(passivePath(nodeId), line, { encoding: 'utf8', flag: 'a' });
  return full;
}

/**
 * Parse jsonl text into entries, tolerating corruption: each line is parsed on
 * its own and a single malformed line is SKIPPED, never the whole feed. The
 * drain path renames + deletes its snapshot, so a non-tolerant parse here would
 * silently discard every accumulated entry the moment one bad line appears.
 */
function parseEntries(text: string): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as InboxEntry);
    } catch {
      // Skip only the corrupt line — the rest of the feed survives.
    }
  }
  return entries;
}

/** Return every accumulated passive entry (oldest first) without clearing. */
export function readPassive(nodeId: string): InboxEntry[] {
  const p = passivePath(nodeId);
  if (!existsSync(p)) return [];
  return parseEntries(readFileSync(p, 'utf8'));
}

/**
 * Read AND clear the accumulator in one shot — the drain-on-message primitive.
 *
 * We rename the file aside before reading so a concurrent `appendPassive` (a
 * publisher pushing at the same instant) starts a fresh file and is never lost
 * to the truncate: at worst it lands in the next drain. The renamed snapshot is
 * removed after a successful read. Returns the drained entries (oldest first).
 */
export function drainPassive(nodeId: string): InboxEntry[] {
  const p = passivePath(nodeId);
  if (!existsSync(p)) return [];

  const snapshot = `${p}.draining`;
  try {
    renameSync(p, snapshot);
  } catch {
    // Lost the race (file vanished) — nothing to drain.
    return [];
  }

  // Parse with the tolerant per-line parser BEFORE removing the snapshot, so a
  // single corrupt line can never discard the whole accumulated feed.
  let entries: InboxEntry[] = [];
  try {
    entries = parseEntries(readFileSync(snapshot, 'utf8'));
  } finally {
    try { rmSync(snapshot, { force: true }); } catch { /* best-effort cleanup */ }
  }
  return entries;
}
