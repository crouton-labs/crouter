// Node inboxes + session paths — the delivery substrate shared by the jobs
// layer and the session graph.
//
// Extracted from sessions.ts so the jobs layer (jobs.ts) can deliver completion
// events into a parent node's inbox WITHOUT importing sessions.ts (which itself
// imports jobs.ts — that would be a cycle). This module depends only on path
// utilities, never on jobs.ts or sessions.ts.
//
// Subscriptions / report-to relationships deliver events to a target node's
// inbox: an append-only JSONL log at
//   sessions/<session_id>/inboxes/<sanitized-node-id>.jsonl
// A node id like `pane:%12` is sanitized for use as a filename; the event
// payload keeps the original `to` ref so readers don't depend on the mangling.

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CRTR_DIR_NAME } from '../types.js';
import { mangleCwd } from './artifact.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function sessionsRoot(cwd: string = process.cwd()): string {
  return join(homedir(), CRTR_DIR_NAME, mangleCwd(cwd), 'sessions');
}

export function sessionDir(sessionId: string, cwd?: string): string {
  return join(sessionsRoot(cwd), sessionId);
}

export function sessionMetaPath(sessionId: string, cwd?: string): string {
  return join(sessionDir(sessionId, cwd), 'session.json');
}

// ---------------------------------------------------------------------------
// Node inboxes — event delivery between graph nodes
// ---------------------------------------------------------------------------

export interface NodeEvent {
  ts: string;
  to: string;
  from: string | null;
  event: string;
  data?: Record<string, unknown>;
}

export function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function inboxesDir(sessionId: string, cwd?: string): string {
  return join(sessionDir(sessionId, cwd), 'inboxes');
}

export function inboxPath(sessionId: string, nodeId: string, cwd?: string): string {
  return join(inboxesDir(sessionId, cwd), `${sanitizeNodeId(nodeId)}.jsonl`);
}

/**
 * Append an event to a node's inbox within a session. Creates the inboxes
 * directory on demand. Append-only JSONL; safe for concurrent writers since
 * each line is a single atomic append.
 */
export function appendNodeEvent(
  sessionId: string,
  nodeId: string,
  event: { from?: string | null; event: string; data?: Record<string, unknown> },
  cwd?: string,
): NodeEvent {
  const dir = inboxesDir(sessionId, cwd);
  mkdirSync(dir, { recursive: true });
  const rec: NodeEvent = {
    ts: new Date().toISOString(),
    to: nodeId,
    from: event.from ?? null,
    event: event.event,
  };
  if (event.data !== undefined) rec.data = event.data;
  appendFileSync(inboxPath(sessionId, nodeId, cwd), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/**
 * Read a node's inbox events, oldest first. Returns [] when the inbox is absent
 * or unreadable. `sinceTs` filters to events strictly after the given ISO time.
 */
export function readNodeInbox(
  sessionId: string,
  nodeId: string,
  opts: { sinceTs?: string } = {},
  cwd?: string,
): NodeEvent[] {
  const p = inboxPath(sessionId, nodeId, cwd);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out: NodeEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let ev: NodeEvent;
    try {
      ev = JSON.parse(line) as NodeEvent;
    } catch {
      continue;
    }
    if (opts.sinceTs !== undefined && ev.ts <= opts.sinceTs) continue;
    out.push(ev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lightweight node resolution — read session.json directly
// ---------------------------------------------------------------------------

interface MinimalAgent {
  job_id: string;
  node_id?: string;
  name?: string;
}
interface MinimalNode {
  node_id: string;
}
interface MinimalSession {
  nodes?: MinimalNode[];
  agents?: MinimalAgent[];
}

/**
 * Resolve a node ref (node_id, job_id, agent name, or 1-based index) to a
 * node_id by reading session.json directly. Pure read — never reaps panes,
 * joins telemetry, or recurses through the jobs layer (so it is safe to call
 * from inside a terminal job transition). Returns null when session.json is
 * absent/unparseable or no node matches; callers may then treat the raw ref as
 * an already-resolved node id (the default report_to refs always are).
 */
export function resolveNodeIdInSession(
  sessionId: string,
  ref: string,
  cwd?: string,
): string | null {
  const mp = sessionMetaPath(sessionId, cwd);
  if (!existsSync(mp)) return null;
  let rec: MinimalSession;
  try {
    rec = JSON.parse(readFileSync(mp, 'utf8')) as MinimalSession;
  } catch {
    return null;
  }
  const nodes = rec.nodes ?? [];
  if (nodes.some((n) => n.node_id === ref)) return ref;
  const agents = rec.agents ?? [];
  const byJob = agents.find((a) => a.job_id === ref);
  if (byJob !== undefined) return byJob.node_id ?? byJob.job_id;
  const byName = agents.find((a) => a.name === ref);
  if (byName !== undefined) return byName.node_id ?? byName.job_id;
  const idx = parseInt(ref, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) {
    const a = agents[idx - 1];
    if (a !== undefined) return a.node_id ?? a.job_id;
  }
  return null;
}
