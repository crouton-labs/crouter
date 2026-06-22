// error-stall.ts — the "is pi parked on an exhausted-retry engine error" signal.
//
// Sibling of busy.ts. When a node's pi engine exhausts its retry budget on a
// rate-limit / overloaded / connection error, pi appends an assistant message
// with stopReason:'error' and fires agent_end. The stophook clears `busy` and
// returns WITHOUT shutdown — so the broker stays alive and the node is
// indistinguishable from a healthy dormant node for up to ERROR_STALL_QUIET_MS,
// when the daemon (§I) force-recycles it. This marker makes that invisible
// window VISIBLE on the canvas graph views.
//
// The marker is `<jobDir>/error-stall` (alongside `<jobDir>/busy`). Like busy,
// it is always AND-ed with pidAlive at the read site, so a stale marker from a
// crashed broker is harmless (the dead pid fails the AND). Best-effort (never
// throws); no db column.
//
// This module also OWNS the grace constant (ERROR_STALL_QUIET_MS) so the render
// layer can read it without importing the daemon — the daemon imports it from
// here instead (it used to be declared in crtrd.ts, an upward layering inversion
// for any non-daemon reader).

import { existsSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobDir } from '../canvas/index.js';

// §I error-stall grace: how long a node's session .jsonl must have been QUIET
// (no append — mtime is the clock) before the daemon declares a trailing-error
// engine wedged and force-recycles it. ALSO the countdown origin shown on the
// canvas graph views ("auto-revive ~2m"). Moved here from crtrd.ts so render can
// read it without importing the daemon; crtrd.ts now imports it from here.
export const ERROR_STALL_QUIET_MS = 5 * 60_000;

export type ErrorStallKind = 'rate-limit' | 'connection' | 'overloaded' | 'other';

export interface ErrorStall {
  kind: ErrorStallKind;
  /** The raw errorMessage from the trailing error assistant turn (capped). */
  message: string;
  /** ISO 8601 — when the stall was recorded (≈ countdown origin). */
  since: string;
}

const MESSAGE_CAP = 500;

function errorStallPath(nodeId: string): string {
  return join(jobDir(nodeId), 'error-stall');
}

/** Classify a raw engine error message into a coarse kind. ORDER MATTERS: check
 *  rate-limit and overloaded BEFORE connection, so a 429/529 whose text also
 *  mentions "connection"/"network" is not swallowed by the connection match.
 *  pi gives no structured HTTP code — this is heuristic substring matching of
 *  the raw text and is accepted as brittle. */
export function classifyEngineError(message: string): ErrorStallKind {
  const m = message ?? '';
  if (/rate.?limit|\b429\b|too many requests|quota/i.test(m)) return 'rate-limit';
  if (/overloaded|\b529\b|\b503\b|capacity|server.{0,3}busy|temporarily unavailable/i.test(m)) return 'overloaded';
  if (/connection|econnreset|etimedout|enotfound|econnrefused|network|fetch failed|socket hang|timed? out|timeout/i.test(m)) return 'connection';
  return 'other';
}

/** True when a raw engine error is a provider 404 "this model does not exist /
 *  is not available" — distinct from the transient outage kinds above, because a
 *  404 is NOT retryable (pi auto-retries 429/5xx only) and NEVER resolves on its
 *  own: the configured model id is simply wrong/decommissioned. The broker reacts
 *  to this by failing the node over to the strong-anthropic ladder model and
 *  re-driving the turn. Heuristic substring match — pi surfaces no structured
 *  HTTP code, so we key off Anthropic's `not_found_error` body and the 404 line.
 *  Observed text: `Error: 404 {"type":"error","error":{"type":"not_found_error",
 *  "message":"Claude Fable 5 is not available. Please use Opus 4.8...`. */
export function isModelNotFoundError(message: string): boolean {
  const m = message ?? '';
  // Primary: Anthropic's structured 404 body (the verbatim shape observed).
  if (/not_found_error/i.test(m)) return true;
  // Unambiguous model-scoped phrasing, with or without a code.
  if (/model[^.]{0,40}(not\s*found|does not exist|is not available|unavailable)|(no such|unknown) model/i.test(m)) return true;
  // Backstop: a bare 404 alongside a not-found phrase.
  return /\b404\b/.test(m) && /not\s*found|not available|does not exist/i.test(m);
}

/** Mark a node parked on a trailing engine error. Best-effort. */
export function markErrorStall(nodeId: string, message: string): void {
  try {
    mkdirSync(jobDir(nodeId), { recursive: true });
    const stall: ErrorStall = {
      kind: classifyEngineError(message),
      message: message.slice(0, MESSAGE_CAP),
      since: new Date().toISOString(),
    };
    writeFileSync(errorStallPath(nodeId), JSON.stringify(stall));
  } catch {
    /* best-effort */
  }
}

/** Clear the error-stall marker (a fresh turn started, or the node revived/shut
 *  down). Best-effort. */
export function clearErrorStall(nodeId: string): void {
  try {
    rmSync(errorStallPath(nodeId), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Read the error-stall marker. null on absent or corrupt. AND this with
 *  pidAlive at the call site — a stale marker from a crashed broker is harmless
 *  because the dead pid fails the AND. */
export function readErrorStall(nodeId: string): ErrorStall | null {
  try {
    const raw = readFileSync(errorStallPath(nodeId), 'utf8');
    const o = JSON.parse(raw) as Partial<ErrorStall>;
    if (typeof o.kind !== 'string' || typeof o.since !== 'string') return null;
    return {
      kind: o.kind as ErrorStallKind,
      message: typeof o.message === 'string' ? o.message : '',
      since: o.since,
    };
  } catch {
    return null;
  }
}
