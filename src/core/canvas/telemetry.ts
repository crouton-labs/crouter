// telemetry.ts — read a node's job/telemetry.json (written by canvas-stophook
// on every turn_end). Best-effort throughout: a missing or corrupt file yields
// an empty record, never a throw.
//
//   tokens_in / tokens_out  cumulative, non-cached throughput across the session.
//   context_tokens          the LIVE context-window gauge (pi's footer figure)
//                           captured on the last turn_end — the accurate measure
//                           of how full the node's window currently is. Absent
//                           until the first turn_end records a usable gauge.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jobDir } from './paths.js';

export interface Telemetry {
  tokens_in?: number;
  tokens_out?: number;
  /** Live context-window size from the last turn_end (pi's getContextUsage). */
  context_tokens?: number;
  model?: string;
  updated_at?: string;
}

/** Read a node's telemetry record. Missing/corrupt → {}. Never throws. */
export function readTelemetry(nodeId: string): Telemetry {
  const path = join(jobDir(nodeId), 'telemetry.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Telemetry;
  } catch {
    return {};
  }
}

/** The node's current context-window size in tokens, or null when unknown.
 *  Prefers the live `context_tokens` gauge; falls back to cumulative
 *  `tokens_in` (the dashboard's coarse proxy) only when no live gauge exists. */
export function readContextTokens(nodeId: string): number | null {
  const tel = readTelemetry(nodeId);
  if (typeof tel.context_tokens === 'number') return tel.context_tokens;
  if (typeof tel.tokens_in === 'number') return tel.tokens_in;
  return null;
}
