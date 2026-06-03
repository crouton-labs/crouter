// Push engine for the pi-native canvas runtime.
//
// `push(nodeId, opts)` writes a report to the node's reports/ directory, then
// fans out a lightweight inbox pointer to every subscriber. The inbox entry
// carries the report path (ref), not the body — subscribers dereference on
// demand.
//
// Compact timestamp format: 20260602T184512 (UTC, no separators) chosen for
// file-system friendliness and lexicographic sort alignment.

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  reportsDir,
  subscribersOf,
  setStatus,
  updateNode,
} from '../canvas/index.js';
import { appendInbox } from './inbox.js';
import { appendPassive } from './passive.js';
import type { InboxTier } from './inbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PushKind = 'update' | 'urgent' | 'final';

export interface PushOpts {
  /** Semantic kind of this push. `final` also finalises the node. */
  kind: PushKind;
  /** Report body (markdown). Written verbatim after the YAML frontmatter. */
  body: string;
  /**
   * Node id of the sender — recorded as `from` on each inbox entry.
   * Defaults to `nodeId` (the publisher) when omitted.
   */
  from?: string;
}

export interface PushResult {
  /** Absolute path of the written report file. */
  reportPath: string;
  /** Node ids that received an inbox pointer. */
  deliveredTo: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format a Date as `YYYYMMDDTHHmmss` (UTC, no separators). */
function compactTs(d: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/**
 * Write a report file atomically (tmp + rename).
 * Returns the final absolute path.
 */
function writeReport(nodeId: string, kind: PushKind, ts: string, body: string): string {
  const dir = reportsDir(nodeId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileName = `${ts}-${kind}.md`;
  const finalPath = join(dir, fileName);
  const tmpPath = `${finalPath}.tmp`;

  const isoTs = new Date().toISOString();
  // YAML frontmatter: minimal, machine-readable, no freeform content in it.
  const frontmatter = `---\nnode: ${nodeId}\nkind: ${kind}\nts: ${isoTs}\n---\n`;
  writeFileSync(tmpPath, frontmatter + body, 'utf8');
  renameSync(tmpPath, finalPath);

  return finalPath;
}

/**
 * Extract the first line of a string and truncate to `maxLen` chars.
 * Used to populate the inbox entry's `label` field (~80 chars).
 */
function firstLine(text: string, maxLen = 80): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line;
}

/** Map a PushKind to the appropriate inbox delivery tier. */
function tierFor(kind: PushKind): InboxTier {
  return kind === 'urgent' ? 'urgent' : 'normal';
}

// ---------------------------------------------------------------------------
// Core push
// ---------------------------------------------------------------------------

/**
 * Push a report from `nodeId` and fan it out as inbox pointers to all
 * current subscribers.
 *
 * Steps:
 *   (a) Write nodes/<nodeId>/reports/<ts>-<kind>.md (YAML front + body).
 *   (b) For each active/passive subscriber, append a pointer to their inbox.
 *   (c) If kind === 'final', mark the node done.
 */
export async function push(nodeId: string, opts: PushOpts): Promise<PushResult> {
  const { kind, body } = opts;
  const from = opts.from ?? nodeId;
  const now = new Date();
  const ts = compactTs(now);

  // (a) Write the report.
  const reportPath = writeReport(nodeId, kind, ts, body);

  // (b) Fan out a pointer to every subscriber. Active subscribers get it on
  //     inbox.jsonl (the inbox-watcher polls that → a wake). Passive subscribers
  //     get it on passive.jsonl instead — the watcher never polls that, so they
  //     are NOT woken; the pointer accumulates until the node is next messaged,
  //     when canvas-passive-context drains it as XML pre-text.
  const subscribers = subscribersOf(nodeId);
  const deliveredTo: string[] = [];

  const label = firstLine(body);
  for (const sub of subscribers) {
    const entry = { from, tier: tierFor(kind), kind, ref: reportPath, label };
    if (sub.active) appendInbox(sub.node_id, entry);
    else appendPassive(sub.node_id, entry);
    deliveredTo.push(sub.node_id);
  }

  // (c) Finalise node when kind === 'final'.
  if (kind === 'final') {
    setStatus(nodeId, 'done');
    updateNode(nodeId, { intent: 'done' });
  }

  return { reportPath, deliveredTo };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Emit a routine progress update from `nodeId`. */
export async function pushUpdate(
  nodeId: string,
  body: string,
  opts?: { from?: string },
): Promise<PushResult> {
  return push(nodeId, { kind: 'update', body, ...opts });
}

/** Emit an urgent alert from `nodeId` (inbox tier: urgent). */
export async function pushUrgent(
  nodeId: string,
  body: string,
  opts?: { from?: string },
): Promise<PushResult> {
  return push(nodeId, { kind: 'urgent', body, ...opts });
}

/**
 * Emit the final report from `nodeId` (inbox tier: normal, kind: final).
 * Also transitions the node to status=done / intent=done.
 */
export async function pushFinal(
  nodeId: string,
  body: string,
  opts?: { from?: string },
): Promise<PushResult> {
  return push(nodeId, { kind: 'final', body, ...opts });
}
