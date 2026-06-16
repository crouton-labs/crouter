// The `~/.crouter/canvas/` layout. One global, cwd-agnostic home for the whole canvas.
//
//   ~/.crouter/canvas/
//     canvas.db                 sqlite (WAL) — topology only (nodes + edges)
//     nodes/<node_id>/
//       meta.json               source of truth for the node's row
//       context/                roadmap.md, initial-prompt.md, explore-*.md, artifacts
//       job/                    log.jsonl, telemetry.json
//       reports/                append-only push history (<ts>-<kind>.md)
//       inbox.jsonl             messages + coalesced subscription feed
//       transcript.jsonl        mirror/pointer of the pi session
//       session.ptr             pi session id/path
//
// `CRTR_HOME` overrides the root (used by tests and isolated runs).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CRTR_DIR_NAME } from '../../types.js';

/** Root of the global canvas home (`~/.crouter/canvas` unless `CRTR_HOME` is set).
 *  Nested under the `.crouter` scope root so the whole runtime lives in one
 *  visible top-level dir; `canvas/` keeps node-graph runtime state separate from
 *  durable user content (memory/plugins/marketplaces/config) at the scope root. */
export function crtrHome(): string {
  const override = process.env['CRTR_HOME'];
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), CRTR_DIR_NAME, 'canvas');
}

export function canvasDbPath(): string {
  return join(crtrHome(), 'canvas.db');
}

export function nodesRoot(): string {
  return join(crtrHome(), 'nodes');
}

export function nodeDir(nodeId: string): string {
  return join(nodesRoot(), nodeId);
}

export function contextDir(nodeId: string): string {
  return join(nodeDir(nodeId), 'context');
}

export function jobDir(nodeId: string): string {
  return join(nodeDir(nodeId), 'job');
}

export function reportsDir(nodeId: string): string {
  return join(nodeDir(nodeId), 'reports');
}

export function nodeMetaPath(nodeId: string): string {
  return join(nodeDir(nodeId), 'meta.json');
}

export function inboxPath(nodeId: string): string {
  return join(nodeDir(nodeId), 'inbox.jsonl');
}

/** Passive-subscription accumulator. Pushes from publishers this node subscribes
 *  to PASSIVELY land here instead of inbox.jsonl — the inbox-watcher never polls
 *  it, so they never wake the node. Drained as XML pre-text on the next message. */
export function passivePath(nodeId: string): string {
  return join(nodeDir(nodeId), 'passive.jsonl');
}

export function transcriptPath(nodeId: string): string {
  return join(nodeDir(nodeId), 'transcript.jsonl');
}

export function sessionPtrPath(nodeId: string): string {
  return join(nodeDir(nodeId), 'session.ptr');
}

/** On-read injection dedup set — the doc realpaths already surfaced on-read in
 *  this node's CURRENT conversation transcript. Persisted so the once-per-
 *  transcript dedup survives a dormancy → revive(resume) cycle: a resume reuses
 *  the same .jsonl transcript in a NEW pi process, so the in-memory set would
 *  otherwise start empty and re-inject docs already present in the transcript.
 *  Deleted by the launch paths that start a FRESH transcript. */
export function injectedDocsPath(nodeId: string): string {
  return join(nodeDir(nodeId), 'injected-docs.json');
}

/** Create the full directory skeleton for a node. Idempotent. */
export function ensureNodeDirs(nodeId: string): void {
  // Refuse an empty nodeId: it would mint stray `nodes/context`, `nodes/job`,
  // `nodes/reports` siblings (non-node entries the test harness's node-dir
  // scan would miscount). A node skeleton must belong to a real node id.
  if (!nodeId) {
    throw new Error('ensureNodeDirs: empty nodeId — refusing to create stray node-skeleton dirs under nodes/');
  }
  for (const d of [contextDir(nodeId), jobDir(nodeId), reportsDir(nodeId)]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Ensure the canvas home exists. Idempotent. */
export function ensureHome(): void {
  mkdirSync(nodesRoot(), { recursive: true });
}
