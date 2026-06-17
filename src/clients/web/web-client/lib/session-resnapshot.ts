/**
 * Cold-start re-snapshot policy (consumed by node-page).
 *
 * A freshly-spawned node whose broker was still booting when the session hub
 * first connected is served a *static* snapshot and never transitions live on
 * its own (the hub's cold-start fallback starts no revive-watch). When the node
 * is actually live (lifecycle `active`) but our stream is stuck on that static
 * snapshot, a bounded socket reconnect re-runs the server's live-vs-static
 * check — the same effect as a manual page reload — and lands the live snapshot
 * once the broker's socket is up. Genuinely-dormant nodes (idle/done/dead/
 * canceled) never qualify, so the explicit Revive path stays untouched.
 *
 * Pure policy so node-page's effect stays a thin orchestrator and the decision
 * is unit-tested.
 */

/** Give up after this many bounded reconnects; the user can still Revive. */
export const MAX_RESNAPSHOT_ATTEMPTS = 8;
const BASE_MS = 400;
const MAX_MS = 4000;

export interface ResnapshotInput {
  /** The stream is on a static (dormant) snapshot. */
  dormant: boolean;
  /** Node lifecycle status from `crtr node inspect show` (null/undefined while it loads). */
  status: string | null | undefined;
  /** The session socket is genuinely open (not mid-reconnect). */
  socketReady: boolean;
  /** Reconnect attempts already spent this mount. */
  attempt: number;
}

/** Should we schedule another bounded reconnect to pick up a now-ready broker? */
export function shouldResnapshot(i: ResnapshotInput): boolean {
  return (
    i.dormant && i.status === 'active' && i.socketReady && i.attempt < MAX_RESNAPSHOT_ATTEMPTS
  );
}

/** Exponential backoff (ms) before the Nth (0-based) reconnect attempt. */
export function resnapshotDelay(attempt: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt));
}
