// The `~/.crtr/` layout. One global, cwd-agnostic home for the whole canvas.
//
//   ~/.crtr/
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

/** Root of the global canvas home (`~/.crtr` unless `CRTR_HOME` is set). */
export function crtrHome(): string {
  const override = process.env['CRTR_HOME'];
  return override !== undefined && override !== '' ? override : join(homedir(), '.crtr');
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

/** Create the full directory skeleton for a node. Idempotent. */
export function ensureNodeDirs(nodeId: string): void {
  for (const d of [contextDir(nodeId), jobDir(nodeId), reportsDir(nodeId)]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Ensure the canvas home exists. Idempotent. */
export function ensureHome(): void {
  mkdirSync(nodesRoot(), { recursive: true });
}
