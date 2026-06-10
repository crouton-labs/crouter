// canvas-inbox-watcher.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// The canvas model: each node is a long-lived resident that alternates between
// "working" (pi actively generating) and "dormant" (pi idle, waiting for a
// subscribed worker to push a report). This watcher bridges the dormant→working
// transition automatically: it polls the node's inbox.jsonl every 800ms and,
// when new entries arrive, coalesces them into a single digest and injects it as
// a pi user message — waking the node to react.
//
// Key differences from the legacy agent-inbox-watcher:
//   • Target resolution is trivial. CRTR_NODE_ID IS the node; its inbox lives at
//     nodes/<CRTR_NODE_ID>/inbox.jsonl. No session-dir scanning, no pi_session_id
//     matching, no spawned-vs-top-level branching.
//   • readInboxSince / readCursor / writeCursor from the canvas inbox primitive
//     replace the hand-rolled JSONL scanner and cursor-file helpers.
//   • coalesce() renders the digest (pointer list, not job-status prose).
//   • No crtr root-init or spawnSync bootstrap — the canvas runtime wires up the
//     node before launching pi; CRTR_NODE_ID is always present when we activate.
//   • Deliver-as decision is driven by InboxEntry.tier (and kind): critical →
//     true preempt (ctx.abort() the live turn, redeliver next tick), urgent →
//     steer at the turn boundary, normal|deferred → followUp. A finished node
//     (kind 'final') ALSO steers — a completion the subscriber may be blocked on
//     must interrupt the current turn, not wait behind it as a follow-up.
//
// Double-notify prevention (copied from legacy watcher):
//   A module-level `liveTimer` ensures that a /reload re-init clears the previous
//   setInterval before starting a new one — exactly one watcher is live at a time.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import {
  readInboxSince,
  readCursor,
  writeCursor,
  coalesce,
} from '../core/feed/inbox.js';
import type { InboxEntry } from '../core/feed/inbox.js';
import { getNode } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*)
// ---------------------------------------------------------------------------

type PiEvents = 'session_start' | 'turn_end' | 'agent_start' | 'agent_end' | 'session_shutdown';

interface PiLike {
  on: (event: PiEvents, handler: (event: any, ctx: any) => void | Promise<void>) => void;
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void;
}

// ---------------------------------------------------------------------------
// Module-level timer — prevents stacking on /reload (the double-notify bug).
//
// pi ignores an extension factory's returned disposer, so a /reload re-enters
// this module and would ADD a new setInterval on top of any running one.
// N reloads → N live watchers, each with its own in-memory cursor → N deliveries
// of the same entry. Clearing the prior timer on each re-init ensures exactly
// one watcher is live. Pattern copied verbatim from agent-inbox-watcher.ts.
// ---------------------------------------------------------------------------

let liveTimer: ReturnType<typeof setInterval> | undefined;

const DEFAULT_TICK_MS = 800;     // polling cadence
const DEFAULT_DEBOUNCE_MS = 1000; // flush once the burst has been quiet for this long

// Testability seam: a test can inject a much shorter cadence so it doesn't have
// to sleep against the real ~800ms/1000ms wall-clock timing. Read per-registration
// (not as an import-time module const) so each registerCanvasInboxWatcher() call
// picks up the env current at that moment. Unset → production defaults.
function resolveCadence(): { tickMs: number; debounceMs: number } {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    tickMs: parse(process.env['CRTR_WATCHER_TICK_MS'], DEFAULT_TICK_MS),
    debounceMs: parse(process.env['CRTR_WATCHER_DEBOUNCE_MS'], DEFAULT_DEBOUNCE_MS),
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the canvas inbox watcher on `pi`.
 *
 * CRTR_NODE_ID is re-read each tick so late-injected env (edge case) is
 * handled gracefully. Returns a disposer for testability; pi ignores it —
 * the module-level liveTimer guard is the actual stacking prevention.
 */
export function registerCanvasInboxWatcher(pi: PiLike): () => void {
  const { tickMs: TICK_MS, debounceMs: DEBOUNCE_MS } = resolveCadence();

  // Capture the latest event context so isIdle() is readable inside the timer
  // callback, which has no ctx of its own.
  let lastCtx: any;
  let streaming = false;

  const captureCtx = (_event: any, ctx: any): void => {
    if (ctx !== undefined) lastCtx = ctx;
  };

  pi.on('session_start', captureCtx);
  pi.on('turn_end', captureCtx);
  pi.on('agent_start', (_e: any, ctx: any): void => {
    captureCtx(_e, ctx);
    streaming = true;
  });
  pi.on('agent_end', (_e: any, ctx: any): void => {
    captureCtx(_e, ctx);
    streaming = false;
  });

  /**
   * True when pi is not currently streaming a response.
   * When idle, sendUserMessage triggers a new turn immediately.
   * When streaming, steer (interrupt) on urgency or a finished node, else follow up.
   */
  const isIdle = (): boolean => {
    try {
      if (typeof lastCtx?.isIdle === 'function') return lastCtx.isIdle() === true;
    } catch {
      /* fall through to the streaming flag */
    }
    return !streaming;
  };

  // ---------------------------------------------------------------------------
  // Debounce state
  // ---------------------------------------------------------------------------

  /** Entries received since the last flush — coalesced into one message. */
  let buffer: InboxEntry[] = [];
  /** Epoch-ms of the most recent entry arrival. Used to detect burst-quiet. */
  let lastArrival = 0;

  /**
   * Durable cursor — ISO 8601 of the last entry we've consumed.
   * Seeded from the persisted cursor file on first resolution; undefined means
   * "read from the beginning" (no prior cursor → process all existing entries).
   * NOT reset to `now` on first tick: that would silently drop entries that
   * arrived between node creation and watcher startup (the startup race).
   */
  let cursor: string | undefined;
  let seeded = false;

  // ---------------------------------------------------------------------------
  // Flush: deliver the buffered entries as a single pi user message.
  // ---------------------------------------------------------------------------
  const flush = (): void => {
    if (buffer.length === 0) return;

    // Deferred-tier entries must never WAKE an idle node — by contract they ride
    // the next natural turn, never interrupt. If everything buffered is deferred
    // and the node is idle, hold them (leave buffered, cheap re-check each tick)
    // and return without delivering. They flush the moment the node is next
    // streaming, or a higher-tier entry joins the batch (every() turns false).
    if (isIdle() && buffer.every((e) => e.tier === 'deferred')) return;

    const batch = buffer;
    buffer = [];

    const digest = coalesce(batch);

    // Tier (and kind) drive delivery mode. Critical is a TRUE preempt; urgent —
    // and a finished node (kind 'final') — steers at the turn boundary;
    // normal/deferred ride the next turn (followUp). (A purely-deferred idle
    // batch was already held above and never reaches here.) A completion a
    // subscriber is likely blocked on must not drain as a follow-up, so 'final'
    // steers exactly like 'urgent'.
    const anyCritical = batch.some((e) => e.tier === 'critical');
    const steerMidStream =
      anyCritical || batch.some((e) => e.tier === 'urgent' || e.kind === 'final');

    try {
      if (isIdle()) {
        // Idle → trigger a new turn immediately (sendUserMessage always triggers).
        pi.sendUserMessage(digest);
      } else if (anyCritical) {
        // Critical mid-stream → TRUE preempt. ctx.abort() cancels the live LLM
        // stream right now (stopReason becomes 'aborted'; the stophook stays alive
        // on that). We then re-buffer and let the next tick deliver via the idle
        // path — by then the turn has torn down and sendUserMessage starts a fresh
        // turn. Relying on the proven idle path (not steer-after-abort semantics)
        // keeps this robust; if abort hasn't settled by the next tick we simply
        // abort again and retry — idempotent and self-healing.
        try { lastCtx?.abort?.(); } catch { /* abort is best-effort */ }
        buffer = batch.concat(buffer);
      } else {
        // Mid-stream → steer on urgency or a finished node, else enqueue for the
        // turn after this one.
        pi.sendUserMessage(digest, { deliverAs: steerMidStream ? 'steer' : 'followUp' });
      }
    } catch {
      // Re-queue on delivery failure so a transient error doesn't silently drop
      // inbox entries. They will be retried on the next flush.
      buffer = batch.concat(buffer);
    }
  };

  // ---------------------------------------------------------------------------
  // Tick: poll the node's inbox and buffer new arrivals.
  // ---------------------------------------------------------------------------
  const tick = (): void => {
    try {
      // Re-read env each tick: CRTR_NODE_ID could theoretically be set after the
      // extension factory runs (e.g. the runtime injects it just before the first
      // turn). In practice it is always present before turn_end fires, but the
      // check is cheap and keeps the watcher robust.
      const nodeId = process.env['CRTR_NODE_ID'];
      if (nodeId === undefined || nodeId.trim() === '') return;

      // Seed the cursor once, on the first tick that resolves a nodeId.
      // readCursor returns undefined when no cursor file exists → readInboxSince
      // with undefined returns ALL entries (no truncation to `now`).
      if (!seeded) {
        cursor = readCursor(nodeId);
        seeded = true;
      }

      const newEntries = readInboxSince(nodeId, cursor);

      // Refresh-yield in flight: the node ran `crtr node yield` and is about to be
      // torn down and revived fresh. Hold everything — don't consume the cursor
      // (advancing it past these entries would drop them on tear-down) and don't
      // deliver (steering a child's `final` into the yielding turn hijacks the
      // clean stop the refresh path depends on, which is how a yield got derailed
      // mid-flight). The fresh pi re-reads the feed on boot. getNode only when
      // there's actual work pending, so idle ticks stay cheap.
      if ((newEntries.length > 0 || buffer.length > 0) && getNode(nodeId)?.intent === 'refresh') {
        return;
      }

      if (newEntries.length > 0) {
        // Advance and persist the cursor BEFORE buffering, so a crash after this
        // point loses at most one coalesced message rather than re-injecting
        // already-delivered entries on restart (exactly-once over restart contract).
        const latest = newEntries.reduce((a, b) => (a.ts > b.ts ? a : b));
        cursor = latest.ts;
        writeCursor(nodeId, cursor);

        buffer.push(...newEntries);
        lastArrival = Date.now();
      }

      // Flush only once the burst has settled (no new entry within DEBOUNCE_MS)
      // so near-simultaneous pushes from multiple workers arrive as one message.
      if (buffer.length > 0 && Date.now() - lastArrival >= DEBOUNCE_MS) {
        flush();
      }
    } catch {
      /* watcher is best-effort; a tick must never crash the host session */
    }
  };

  // ---------------------------------------------------------------------------
  // Timer management — clear any leftover timer from a prior /reload.
  // ---------------------------------------------------------------------------
  if (liveTimer !== undefined) clearInterval(liveTimer);
  const timer = setInterval(tick, TICK_MS);
  // unref() so the watcher doesn't keep the Node process alive when everything
  // else has finished (matches legacy watcher behaviour).
  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  // pi DOES fire session_shutdown — use it as the authoritative teardown so a
  // re-init (e.g. /reload) never discovers a live sibling timer.
  pi.on('session_shutdown', (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
  });

  // Disposer: returned for testability + explicit teardown in test harnesses.
  // pi ignores the factory return value, so the module-level guard above is what
  // actually prevents stacking in production.
  return (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
  };
}

export default registerCanvasInboxWatcher;
