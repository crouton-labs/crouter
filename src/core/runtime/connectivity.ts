// connectivity.ts — "is the network reachable right now" for the daemon.
//
// Used by the daemon's connectivity-recovery pass (crtrd §J) to decide whether a
// node parked on a CONNECTION error should be nudged to continue. The signal the
// user thinks in terms of is "my wifi is back" — so this is a coarse internet-
// reachability probe, NOT a per-provider health check.
//
// Implementation: a fast TCP connect to a couple of well-known anycast resolvers
// on 443. RAW IPs (no DNS lookup) on purpose — DNS itself fails when the network
// is down, so resolving a hostname would conflate "wifi down" with "DNS down" and
// add latency; the IPs below are stable anycast addresses. Online = ANY target
// accepts a TCP connection within the timeout. Never throws.
//
// The probe is injected into superviseTick (deps.probeOnline) so tests drive the
// "wifi state" deterministically — no real network call, no real wifi toggled.

import { Socket } from 'node:net';

/** Anycast resolvers reachable from essentially any connected network. A single
 *  success means the box has working internet; we don't care WHICH target. */
const PROBE_TARGETS: ReadonlyArray<{ host: string; port: number }> = [
  { host: '1.1.1.1', port: 443 }, // Cloudflare
  { host: '8.8.8.8', port: 443 }, // Google
];

/** Default per-target connect timeout. Short — a healthy network connects in
 *  tens of ms; a down network should be declared down quickly so the daemon tick
 *  isn't held up. */
export const PROBE_TIMEOUT_MS = 3000;

/** Resolve true iff a TCP connection to host:port completes within timeoutMs.
 *  Any error/timeout resolves false (never rejects). The socket is always torn
 *  down. Exported for unit testing against a local listener. */
export function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already torn down */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** True when the box can reach the internet (any PROBE_TARGET accepts a TCP
 *  connection within the timeout). The default production probe; tests inject
 *  their own through superviseTick(deps.probeOnline). Never throws. */
export async function probeOnline(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const results = await Promise.all(
      PROBE_TARGETS.map((t) => tcpReachable(t.host, t.port, timeoutMs)),
    );
    return results.some((ok) => ok);
  } catch {
    // Promise.all only rejects if a target promise rejects — they never do, but
    // be defensive: an unexpected throw reads as "can't tell", and "can't tell"
    // must never claim the network is UP (which would nudge nodes into a retry
    // that fails again). Treat as offline.
    return false;
  }
}
