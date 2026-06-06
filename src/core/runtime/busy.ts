// busy.ts — the "is pi actually mid-turn" signal (a marker file, no db column).
//
// The disposition of a focus's OUTGOING node on a hot-swap (placement.ts
// `outgoingDisposition`) must distinguish a terminal worker that is GENUINELY
// mid-turn (keep it running off-screen, Invariant F2) from one merely PARKED at
// its prompt with a live pi (a viewer revived for inspection — despawn it back to
// dormant on focus-away). A live pid is NOT that signal: a parked node has a live
// pid too. This marker is.
//
// `<jobDir>/busy` exists for exactly the span pi is inside a turn: the stophook
// touches it on `agent_start` and unlinks it at the top of `agent_end` (and
// defensively on `session_shutdown`). It is always AND-ed with `pidAlive` at the
// read site, so a stale marker (process crashed mid-turn without firing
// agent_end) is harmless — the dead pid fails the AND and the node is reaped.
// No db migration, atomic touch/unlink, best-effort (never throws).

import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { jobDir } from '../canvas/index.js';

function busyPath(nodeId: string): string {
  return join(jobDir(nodeId), 'busy');
}

/** Mark a node mid-turn (pi entered a turn). Best-effort. */
export function markBusy(nodeId: string): void {
  try {
    mkdirSync(jobDir(nodeId), { recursive: true });
    writeFileSync(busyPath(nodeId), '');
  } catch {
    /* best-effort */
  }
}

/** Clear the mid-turn marker (the turn ended, however it routed). Best-effort. */
export function clearBusy(nodeId: string): void {
  try {
    rmSync(busyPath(nodeId), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Is the node currently inside a turn? AND this with `pidAlive` at the call
 *  site — a stale marker from a crashed pi is harmless because the dead pid
 *  fails the AND. */
export function isBusy(nodeId: string): boolean {
  return existsSync(busyPath(nodeId));
}
