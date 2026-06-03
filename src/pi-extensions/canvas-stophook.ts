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
//           • 'allow'    → stay dormant; the inbox-watcher wakes it when a
//                          subscribed worker delivers.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, jobDir, updateNode } from '../core/canvas/index.js';
import { push } from '../core/feed/feed.js';
import { evaluateStop } from '../core/runtime/stop-guard.js';

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

  // ---------------------------------------------------------------------------
  // session_start — capture pi's session id once so `pi --resume <id>` works.
  //
  // pi exposes the session id via ctx.sessionManager.getSessionId() on every
  // event context (ReadonlySessionManager from dist/core/extensions/types.d.ts).
  // session_start fires early in the extension lifecycle, before any turns, so
  // it's the earliest reliable place to read it. We guard on value change to
  // avoid a spurious meta.json write on every reload.
  // ---------------------------------------------------------------------------
  let sessionIdCaptured = false; // fire-once guard

  pi.on('session_start', (_event: any, ctx: any): void => {
    if (sessionIdCaptured) return;
    try {
      const id: unknown = ctx?.sessionManager?.getSessionId?.();
      if (typeof id !== 'string' || id === '') return;

      // Only write when the value actually changed — avoids thrashing meta.json.
      const existing = getNode(nodeId);
      if (existing?.pi_session_id === id) {
        sessionIdCaptured = true;
        return;
      }

      updateNode(nodeId, { pi_session_id: id });
      sessionIdCaptured = true;
    } catch {
      /* best-effort; never surface from an extension handler */
    }
  });

  // Running totals across all turns in this pi session. Both turn_end and
  // agent_end accumulate so tokens emitted in the final partial turn (if pi
  // fires agent_end without a preceding turn_end for it) are captured.
  let totalIn = 0;
  let totalOut = 0;
  let model = '';

  // Context-size steering. As the node's input context grows we nudge it (once
  // per band) to get its affairs in order and consider yielding. Resident
  // orchestrators heed this to refresh; terminal workers auto-promote on yield.
  // Bands are absolute for now (a fraction-of-window policy can replace them).
  const STEER_BANDS: { at: number; note: string }[] = [
    { at: 100_000, note: 'Context ~100k. Get your affairs in order: update context/roadmap.md, delegate outstanding work, and consider `crtr node yield` to refresh.' },
    { at: 150_000, note: 'Context ~150k. You should wrap up or `crtr node yield` soon — update your roadmap so a fresh revive can continue.' },
    { at: 200_000, note: 'Context ~200k. Yield now (`crtr node yield`) unless you are about to `crtr push final`.' },
  ];
  const firedBands = new Set<number>();

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

    // Context-size steering: fire the highest crossed band we haven't yet.
    try {
      const band = [...STEER_BANDS].reverse().find((b) => totalIn >= b.at && !firedBands.has(b.at));
      if (band !== undefined) {
        firedBands.add(band.at);
        pi.sendUserMessage(`[crtr] ${band.note}`, { deliverAs: 'followUp' });
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
          try { ctx?.shutdown?.(); } catch { /* ignore */ }
          return;
        }

        // (b') Refresh-yield: the node ran `crtr node yield` this turn, setting
        //     intent='refresh'. Shut the process down; the daemon sees the dead
        //     window + intent=refresh and revives a FRESH pi against the context
        //     dir (the node re-reads its roadmap). This is the only kill+revive.
        if (node?.intent === 'refresh') {
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

        // 'allow' (awaiting | attended | …) → genuinely dormant. Surface the
        // last message as a routine feed checkpoint, then stay asleep; the
        // inbox-watcher drives the next wake-up when a subscribed worker delivers.
        const text = extractText(last);
        if (text !== '') {
          await push(nodeId, { kind: 'update', body: text });
        }
      } catch {
        /* agent_end handler must never throw out of the extension */
      }
    })();
  });
}

export default registerCanvasStophook;
