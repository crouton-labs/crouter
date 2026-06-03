// canvas-stophook.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// In the canvas model each node owns a dedicated pi window (one-window-per-node),
// so the tmux pane-relocation swap-back guard of the legacy stophook is omitted —
// there are no shared pane slots to restore.
//
// Responsibilities:
//
//   turn_end — accumulate token usage and flush telemetry.json under the node's
//              job/ dir so the dashboard shows live counts.
//
//   agent_end — decide what happens when the node stops:
//     (a) stopReason is 'aborted' or 'error' → stay alive for re-steering; return.
//     (b) node.status is already 'done' (agent called `crtr push --final` this
//         turn, which sets status synchronously) → shut down; work is complete.
//     (c) Natural stop ('stop' | 'length') — auto-push the last assistant text
//         as a routine feed update, then run the stop-guard:
//           • 'reprompt' → pi.sendUserMessage so the node finishes or escalates.
//           • 'allow' (awaiting) → idle-release: free the tmux window and shut
//                          down; the daemon watches the inbox and revives it
//                          (resume) when a subscribed worker delivers.
//           • 'allow' (attended root) → stay alive, dormant; the human wakes it.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, jobDir, updateNode, subscribersOf } from '../core/canvas/index.js';
import { push } from '../core/feed/feed.js';
import { evaluateStop } from '../core/runtime/stop-guard.js';
import { reviveInPlace, reviveNode } from '../core/runtime/revive.js';
import { resetRoot } from '../core/runtime/reset.js';
import { focusNodeInPlace, getFocus } from '../core/runtime/presence.js';
import { windowAlive } from '../core/runtime/tmux.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*)
// ---------------------------------------------------------------------------

type PiEvents = 'turn_end' | 'agent_end' | 'session_shutdown' | 'session_start';

interface PiLike {
  on: (event: PiEvents, handler: (event: any, ctx: any) => void | Promise<void>) => void;
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void;
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

interface Telemetry {
  tokens_in: number;
  tokens_out: number;
  model: string;
  updated_at: string;
}

/**
 * Merge accumulated token counts into nodes/<nodeId>/job/telemetry.json.
 * Creates the directory when it doesn't yet exist. Best-effort; never throws.
 */
function flushTelemetry(
  jobDirPath: string,
  tokensIn: number,
  tokensOut: number,
  model: string,
): void {
  try {
    if (!existsSync(jobDirPath)) mkdirSync(jobDirPath, { recursive: true });

    const filePath = join(jobDirPath, 'telemetry.json');

    // Merge with any existing record so concurrent readers always see a complete
    // picture. Model name falls back to whatever was last recorded.
    let existing: Partial<Telemetry> = {};
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Telemetry>;
      } catch {
        /* start fresh on a corrupt file */
      }
    }

    const record: Telemetry = {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model: model !== '' ? model : (existing.model ?? ''),
      updated_at: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  } catch {
    /* telemetry is best-effort; never surface */
  }
}

// ---------------------------------------------------------------------------
// Message-extraction helpers
// ---------------------------------------------------------------------------

/** Walk backwards through the agent_end messages array to find the last
 *  assistant turn. */
function lastAssistantMessage(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return undefined;
}

/** When a FOCUSED node is about to shut down (final or idle-release), bring its
 *  manager into the visible pane it currently occupies so the view travels UP
 *  the spine — instead of the visible window collapsing when this node's pi
 *  exits in it. A no-op unless this node is the one the user is looking at.
 *
 *  This is the swap-back guard the one-window-per-node model dropped: in-place
 *  focus (swap-pane) reintroduced shared pane slots, so a focused leaf that
 *  exits must hand its slot back to its manager rather than take it down.
 *  Best-effort throughout — never throws out of agent_end. */
function restoreFocusToManager(nodeId: string): void {
  try {
    if (getFocus() !== nodeId) return; // not in view — nothing to restore
    const meta = getNode(nodeId);
    if (meta === null) return;
    const managerId = meta.parent ?? subscribersOf(nodeId)[0]?.node_id ?? null;
    if (managerId === null || managerId === nodeId) return;
    const manager = getNode(managerId);
    if (manager === null) return;
    // Revive a dormant manager so there is a live pane to swap into view (it is
    // about to be woken by this node's push anyway).
    if (!windowAlive(manager.tmux_session, manager.window)) {
      try { reviveNode(managerId, { resume: true }); } catch { return; }
    }
    // Swap the manager into THIS (focused, exiting) node's pane slot. focus reads
    // the caller pane from $TMUX_PANE — this stophook runs inside the exiting
    // node's pi, so that is the visible pane. When this node's pi then exits, its
    // pane lives on in the manager's old (background) window and closes there.
    focusNodeInPlace(managerId);
  } catch {
    /* best-effort; never throw out of agent_end */
  }
}

/** Concatenate all {type:'text'} content blocks from an assistant message. */
function extractText(msg: any): string {
  if (!msg || !Array.isArray(msg.content)) return '';
  return (msg.content as any[])
    .filter((c) => c != null && c.type === 'text' && typeof c.text === 'string')
    .map((c) => (c.text as string))
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Context-size steering bands — mode-specific schedules that ESCALATE in tone
// as input context grows. The first band is a gentle "consider it"; a later
// band turns firm. Past the last explicit band the firmest nudge repeats every
// 50k, so a long-lived node keeps getting reminded.
//
//   orchestrator: 130k gentle (consider yielding) → 150k+ firm (do it now)
//   base worker:  130k suggest promote → 160k+ suggest promote (+ "ignore if
//                 nearly done")
// ---------------------------------------------------------------------------

const STEER_STEP = 50_000;
const ORCH_BANDS = [130_000, 150_000];   // gentle, then firm (firm repeats +50k)
const WORKER_BANDS = [130_000, 160_000]; // suggest, then suggest+ignore (repeats +50k)

/** The highest band threshold at or below `tokens` for `mode`. Below the first
 *  band → null. At/past the last listed band, bands continue every STEER_STEP
 *  (so the firmest nudge keeps recurring). */
function steerBand(tokens: number, mode: string): number | null {
  const bands = mode === 'orchestrator' ? ORCH_BANDS : WORKER_BANDS;
  const first = bands[0]!;
  const last = bands[bands.length - 1]!;
  if (tokens < first) return null;
  if (tokens >= last) return last + Math.floor((tokens - last) / STEER_STEP) * STEER_STEP;
  let chosen = first;
  for (const b of bands) if (tokens >= b) chosen = b;
  return chosen;
}

/** The nudge text for a crossed band, specialized to the node's mode + how far
 *  along the escalation it is. An orchestrator is steered to checkpoint its
 *  roadmap and yield (gently first, then firmly); a non-orchestrator (base
 *  worker) is steered to PROMOTE itself — become a resident orchestrator — when
 *  work remains, with an "ignore if nearly done" once it's deeper in. */
function steerNote(at: number, mode: string): string {
  const k = Math.round(at / 1000);
  if (mode === 'orchestrator') {
    if (at < 150_000) {
      return `Context ~${k}k and growing. When you reach a good stopping point, consider updating context/roadmap.md and running \`crtr node yield\` to refresh against it — no rush yet.`;
    }
    return `Context ~${k}k. Update context/roadmap.md so a fresh revive can continue, delegate any outstanding work, then \`crtr node yield\` to refresh.`;
  }
  const suggest = `If much more work remains than this context can finish, consider \`crtr node promote\` to become a resident orchestrator (seeds a roadmap, lets you delegate and \`crtr node yield\` to refresh).`;
  if (at < 160_000) return `Context ~${k}k. ${suggest}`;
  return `Context ~${k}k. ${suggest} If you're nearly done, ignore this suggestion and finish with \`crtr push final\`.`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the canvas turn_end / agent_end handlers on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session. Safe to call multiple times (each call
 * re-registers on the same `pi` instance, so it should only be called once
 * per node lifecycle, matching how pi loads extensions).
 */
export function registerCanvasStophook(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  const jobDirPath = jobDir(nodeId);

  // Running totals across all turns in this pi session. Both turn_end and
  // agent_end accumulate so tokens emitted in the final partial turn (if pi
  // fires agent_end without a preceding turn_end for it) are captured.
  let totalIn = 0;
  let totalOut = 0;
  let model = '';

  // Context-size steering. As input context grows we nudge the node once per
  // band on an escalating, mode-specific schedule (see steerBand/steerNote).
  // Mode is read at fire time since a base worker can promote mid-session: an
  // orchestrator is steered to checkpoint + yield; a base worker to promote.
  const firedBands = new Set<number>();

  // ---------------------------------------------------------------------------
  // session_start — capture pi's session id, and detect `/new`.
  //
  // pi exposes the session id via ctx.sessionManager.getSessionId() on every
  // event context; session_start fires early, before any turns. We bind the
  // FIRST session_start of this process as the boot (a fresh launch and a daemon
  // revive are both new processes, so their first session_start is a boot, not
  // a `/new`). A LATER session_start with a DIFFERENT id, in this same live
  // process, can only mean the user ran `/new` — a brand-new conversation. For
  // a root that means a brand-new graph: reset it (the `crtr`-again equivalent),
  // then rebind. A reload reports the same id and is a no-op.
  // ---------------------------------------------------------------------------
  let boundSessionId: string | null = null;

  pi.on('session_start', (_event: any, ctx: any): void => {
    try {
      const id: unknown = ctx?.sessionManager?.getSessionId?.();
      if (typeof id !== 'string' || id === '') return;

      if (boundSessionId === null) {
        // Boot: bind this process to its session id.
        boundSessionId = id;
        const existing = getNode(nodeId);
        if (existing?.pi_session_id !== id) updateNode(nodeId, { pi_session_id: id });
        return;
      }

      if (id === boundSessionId) return; // reload of the same conversation

      // A new session id in the same process = `/new`. Brand-new graph.
      boundSessionId = id;
      try { resetRoot(nodeId, id); } catch { /* best-effort */ }
      // Clear in-memory context-steering so the fresh conversation starts clean.
      totalIn = 0;
      totalOut = 0;
      firedBands.clear();
    } catch {
      /* best-effort; never surface from an extension handler */
    }
  });

  /** Absorb usage + model from any assistant message (turn or final batch). */
  const accumulate = (msg: any): void => {
    if (msg?.role !== 'assistant' || msg.usage == null) return;
    totalIn += Number(msg.usage.input ?? 0) || 0;
    totalOut += Number(msg.usage.output ?? 0) || 0;
    if (typeof msg.model === 'string' && msg.model !== '') model = msg.model;
  };

  // ---------------------------------------------------------------------------
  // turn_end — live telemetry refresh.
  // event shape: { message: AssistantMessage, ... }
  // ---------------------------------------------------------------------------
  pi.on('turn_end', (event: any): void => {
    accumulate(event?.message);
    // Fire-and-forget: flushTelemetry uses synchronous fs writes and never throws.
    flushTelemetry(jobDirPath, totalIn, totalOut, model);

    // Context-size steering: fire the current band once, with mode-specific
    // guidance (mode is read live — a worker may have promoted since launch).
    try {
      const mode = getNode(nodeId)?.mode ?? 'base';
      const at = steerBand(totalIn, mode);
      if (at !== null && !firedBands.has(at)) {
        firedBands.add(at);
        pi.sendUserMessage(`[crtr] ${steerNote(at, mode)}`, { deliverAs: 'followUp' });
      }
    } catch {
      /* steering is best-effort */
    }
  });

  // ---------------------------------------------------------------------------
  // agent_end — routing decision when the node's pi stops.
  // event shape: { messages: AgentMessage[] }
  // ---------------------------------------------------------------------------
  pi.on('agent_end', (event: any, ctx: any): void => {
    // Wrap in a void async IIFE so we can await the async push() call without
    // making the handler signature async (pi may not uniformly await async
    // handlers). The internal I/O (push) is all synchronous fs, so this
    // resolves in a single microtask tick — no meaningful async delay.
    void (async (): Promise<void> => {
      try {
        const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];

        // Accumulate tokens from the final batch (edge case: a turn that fired
        // agent_end without a preceding turn_end for the same turn).
        for (const m of messages) accumulate(m);

        const last = lastAssistantMessage(messages);
        const stopReason: string = last?.stopReason ?? '';

        // (a) Interrupted or errored — stay alive so the user can re-steer.
        if (stopReason !== 'stop' && stopReason !== 'length') return;

        // (b) Already done: `crtr push --final` was called this turn, which
        //     transitions node.status → 'done' synchronously. Shut down cleanly.
        const node = getNode(nodeId);
        if (node?.status === 'done') {
          restoreFocusToManager(nodeId);
          try { ctx?.shutdown?.(); } catch { /* ignore */ }
          return;
        }

        // (b') Refresh-yield: the node ran `crtr node yield` this turn, setting
        //     intent='refresh'. Re-exec a FRESH pi IN PLACE in this same tmux
        //     pane (respawn-pane -k) so the node re-reads its roadmap without
        //     churning its window — critically, an interactive/foreground root
        //     is never dropped to a shell, and no daemon round-trip is needed
        //     (the old window-death detection silently failed whenever pi
        //     exited into a persistent shell pane). Falls back to a clean
        //     shutdown (daemon revives in a new window) only when we're not in
        //     a tmux pane.
        if (node?.intent === 'refresh') {
          // Notify subscribers BEFORE refreshing. A yield is a checkpoint, not a
          // disappearance: the node keeps its identity and its subscription
          // edges across the revive, so it still owes its parent a report. Emit
          // one now (an `update`, not a `final` — the node isn't done) so a
          // yield is never silent to whoever is watching.
          try {
            const yieldText = extractText(last);
            const body = yieldText !== ''
              ? `↻ Refreshing context (yield) — still working toward my goal.\n\n${yieldText}`
              : '↻ Refreshing context (yield) — still working toward my goal.';
            await push(nodeId, { kind: 'update', body });
          } catch { /* notify is best-effort */ }

          const pane = process.env['TMUX_PANE'];
          if (pane !== undefined && pane.trim() !== '') {
            try {
              reviveInPlace(nodeId, pane);
              return; // respawn-pane -k tears down this pi and starts the fresh one
            } catch { /* fall through to plain shutdown */ }
          }
          try { ctx?.shutdown?.(); } catch { /* ignore */ }
          return;
        }

        // (c) Natural stop — decide FIRST, then act. Running the stop-guard
        //     before any auto-push is what prevents duplicate reporting: a
        //     stalled terminal worker that narrates "done" without calling
        //     `push final` must NOT have that prose pushed as an `update`,
        //     because the reprompt below makes it emit a `final` next turn —
        //     two feed entries for one completion. Only genuinely dormant
        //     nodes ('allow') get a routine checkpoint update.
        const decision = evaluateStop(nodeId, { pushedFinal: false, askedHuman: false });

        if (decision.action === 'reprompt') {
          // Stalled — re-prompt so the node finishes or escalates. Its `final`
          // (or escalation) carries the real result, so we deliberately skip
          // the auto-update here. Deliver as a followUp: the turn just ended
          // but pi may still be flushing, so an unqualified sendUserMessage
          // races with 'already processing'.
          pi.sendUserMessage(decision.message, { deliverAs: 'followUp' });
          return;
        }

        // 'allow' — the node legitimately stopped. Surface the last assistant
        // message as a routine feed checkpoint first.
        const text = extractText(last);
        if (text !== '') {
          await push(nodeId, { kind: 'update', body: text });
        }

        // Idle-release: a node awaiting its workers (reason 'awaiting') is holding
        // a tmux window for nothing. Free it — mark it idle-released and shut pi
        // down; the daemon watches its inbox and revives it (resume) the moment a
        // subscribed worker delivers. An 'attended' root never releases: the human
        // is its wake source, so we keep its window live and dormant.
        if (decision.reason === 'awaiting') {
          updateNode(nodeId, { intent: 'idle-release', status: 'idle' });
          restoreFocusToManager(nodeId);
          try { ctx?.shutdown?.(); } catch { /* ignore */ }
          return;
        }
      } catch {
        /* agent_end handler must never throw out of the extension */
      }
    })();
  });
}

export default registerCanvasStophook;
