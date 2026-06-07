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
//     (c) Natural stop ('stop' | 'length') — run the stop-guard (the node is
//         NEVER auto-pushed; it reports only via its own explicit `crtr push`):
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

import { getNode, jobDir, updateNode, recordPid, subscribersOf, setPresence } from '../core/canvas/index.js';
import { transition } from '../core/runtime/lifecycle.js';
import { markBusy, clearBusy } from '../core/runtime/busy.js';
import { evaluateStop } from '../core/runtime/stop-guard.js';
import { personaDrift, commitPersonaAck } from '../core/runtime/persona.js';
import { reviveInPlace } from '../core/runtime/revive.js';
import { handleNewSession, markCleanExitDone } from '../core/runtime/reset.js';
import { focusOf, handFocusToManager, tearDownNode, closeFocusToShell } from '../core/runtime/placement.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*)
// ---------------------------------------------------------------------------

type PiEvents = 'agent_start' | 'turn_end' | 'agent_end' | 'session_shutdown' | 'session_start';

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
  /** Live context-window size from this turn_end (pi's getContextUsage). Lets
   *  out-of-process readers (e.g. `crtr node new`'s yield nudge) see how full a
   *  node's window is without pi's in-memory gauge. */
  context_tokens?: number;
  model: string;
  updated_at: string;
}

/**
 * Merge accumulated token counts into nodes/<nodeId>/job/telemetry.json.
 * Creates the directory when it doesn't yet exist. Best-effort; never throws.
 * `contextTokens` is the live window gauge for THIS turn; when null (pi can't
 * size the window yet) the last recorded value is preserved.
 */
function flushTelemetry(
  jobDirPath: string,
  tokensIn: number,
  tokensOut: number,
  model: string,
  contextTokens: number | null,
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
      context_tokens: contextTokens ?? existing.context_tokens,
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

// ---------------------------------------------------------------------------
// Context-size steering bands — a single shared schedule of thresholds that
// ESCALATE in tone as input context grows. The first band is a gentle
// "consider it"; a later band turns firm. The schedule TIGHTENS as it climbs:
// 130k, 150k, 170k, 185k, 200k, then every 10k (210k, 220k, …) so a long-lived
// node keeps getting reminded, more often the deeper it goes.
//
// The band schedule is shared across all node shapes; only the MESSAGE differs
// (steerNote), keyed on MODE first, then LIFECYCLE — three reachable personas:
//   orchestrator (terminal OR resident): HAS a roadmap (promotion / orchestrator
//             birth seeds context/roadmap.md), so it is steered to checkpoint +
//             yield — 130k gentle (consider yielding) → 150k firm (do it now) →
//             185k+ pushy. Keyed on mode, NOT lifecycle: a terminal/orchestrator
//             yields against its roadmap exactly like a resident one (the
//             daemon's refresh-revive keys on intent='refresh', not lifecycle).
//   resident/base (a root conversation): never promoted ⇒ NO roadmap on disk,
//             so it is NOT told to checkpoint/yield against one. Instead: if the
//             chat is outgrowing one window into a multi-phase job, promote;
//             otherwise wrap up or start fresh. 130k gentle → 150k firm → 185k+
//             pushy.
//   terminal/base (a worker): 130k/150k suggest promote → 170k suggest promote
//             (+ "ignore if nearly done") → 185k+ pushy.
//
// The promote/push-final guidance only makes sense for a terminal BASE worker. A
// resident node finishes by yielding or being closed, not `push final`, so it is
// never told to push final; only an ORCHESTRATOR (either lifecycle) has a roadmap
// to yield against, so only it is steered at the roadmap.
// ---------------------------------------------------------------------------

const STEER_STEP = 10_000;
// Shared escalation schedule (both lifecycles). Tightens as it climbs:
// 130k, 150k, 170k, 185k, 200k, then every 10k (210k, 220k, …).
const BANDS = [130_000, 150_000, 170_000, 185_000, 200_000];

/** The highest band threshold at or below `tokens`. Below the first band →
 *  null. At/past the last listed band, bands continue every STEER_STEP (so the
 *  firmest nudge keeps recurring). */
function steerBand(tokens: number): number | null {
  const first = BANDS[0]!;
  const last = BANDS[BANDS.length - 1]!;
  if (tokens < first) return null;
  if (tokens >= last) return last + Math.floor((tokens - last) / STEER_STEP) * STEER_STEP;
  let chosen = first;
  for (const b of BANDS) if (tokens >= b) chosen = b;
  return chosen;
}

/** The nudge text for a crossed band, specialized to the node's (mode,
 *  lifecycle) persona + how far along the escalation it is.
 *
 *  - orchestrator (terminal OR resident): checkpoint its roadmap and yield
 *    (gently → firmly → pushy). It has a context/roadmap.md to yield against.
 *  - resident/base (root conversation): never promoted, so NO roadmap exists —
 *    steer it to PROMOTE if the chat is growing into a multi-phase job (which
 *    seeds a roadmap), else wrap up / start fresh. Never points at roadmap.md or
 *    a bare `node yield`, which for a roadmap-less root just drops context.
 *  - terminal/base (worker): PROMOTE itself — become an orchestrator — when
 *    work remains, with an "ignore if nearly done, finish with push final" once
 *    it's deeper in.
 *
 *  At/past 185k every persona goes PUSHY: the context is long enough that
 *  drifting further risks an overflow. */
export function steerNote(at: number, lifecycle: string, mode: string): string {
  const k = Math.round(at / 1000);
  const pushy = at >= 185_000;

  // Keyed on MODE first: any orchestrator (terminal or resident) has a roadmap
  // to checkpoint + yield against.
  if (mode === 'orchestrator') {
    if (at < 150_000) {
      return `Context ~${k}k and growing. When you reach a good stopping point, consider updating context/roadmap.md and running \`crtr node yield\` to refresh against it — no rush yet.`;
    }
    if (!pushy) {
      return `Context ~${k}k. Update context/roadmap.md so a fresh revive can continue, delegate any outstanding work, then \`crtr node yield\` to refresh.`;
    }
    return `Context ~${k}k — this is getting long. Stop taking on new work now: checkpoint context/roadmap.md, hand off anything outstanding, and \`crtr node yield\` immediately to refresh before this context overflows.`;
  }

  if (lifecycle === 'resident') {
    // resident/base — a root conversation. It has no roadmap (only promotion
    // seeds one), so steer it toward promote-or-wrap-up, never at roadmap.md.
    const grow = `If this is turning into a multi-phase job, \`crtr node promote\` to become a resident orchestrator (seeds a roadmap so you can delegate and \`crtr node yield\` to refresh).`;
    if (at < 150_000) {
      return `Context ~${k}k and growing. ${grow} Otherwise no rush — wrap up when you reach a good stopping point.`;
    }
    if (!pushy) {
      return `Context ~${k}k. ${grow} If you're near done, just finish here; if there's more open-ended work, start a fresh \`crtr\` rather than letting this context grow.`;
    }
    return `Context ~${k}k — this is getting long. Wrap up now before this context overflows: finish what's in hand, or \`crtr node promote\` immediately if substantial work remains, otherwise continue in a fresh \`crtr\`.`;
  }

  // terminal — a worker.
  const suggest = `If much more work remains than this context can finish, consider \`crtr node promote\` to become an orchestrator (seeds a roadmap, lets you delegate and \`crtr node yield\` to refresh).`;
  if (at < 170_000) return `Context ~${k}k. ${suggest}`;
  if (!pushy) {
    return `Context ~${k}k. ${suggest} If you're nearly done, ignore this suggestion and finish with \`crtr push final\`.`;
  }
  return `Context ~${k}k — this is getting long. Wrap up now: \`crtr push final\` if you're close, otherwise \`crtr node promote\` immediately to continue as an orchestrator instead of overflowing this context.`;
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

  // Cumulative throughput across all turns in this pi session, for telemetry
  // (job/telemetry.json) only — both turn_end and agent_end accumulate so tokens
  // emitted in the final partial turn (if pi fires agent_end without a preceding
  // turn_end for it) are captured. NOT used for context-size steering: that is a
  // per-turn gauge (see contextTokens), not a running sum.
  let totalIn = 0;
  let totalOut = 0;
  let model = '';

  // Context-size steering. As input context grows we nudge the node once per
  // band on an escalating, persona-specific schedule (see steerBand/steerNote).
  // The node's (lifecycle, mode) persona is read at fire time, since a terminal
  // worker can promote mid-session: a resident orchestrator is steered to
  // checkpoint roadmap + yield; a resident base (root chat) to promote-or-wrap-
  // up (it has no roadmap); a terminal worker to promote / push final.
  const firedBands = new Set<number>();

  // ---------------------------------------------------------------------------
  // session_start — capture pi's session id, and detect `/new`.
  //
  // pi tags each session_start with a `reason`: 'startup' on boot (a fresh
  // launch or a daemon revive — both new processes), 'new' when the user runs
  // `/new` (a brand-new conversation in the SAME process), and 'resume' /
  // 'reload' / 'fork' for the in-place conversation swaps that keep the same
  // node. We branch on that reason — NOT on a remembered session id.
  //
  // Why reason, not a closure flag: pi RE-ACTIVATES extensions on every session
  // swap, so any id we stash on boot is reset to its initial value before the
  // next session_start fires and can never observe the change — a `/new` then
  // looks identical to a boot. (That is exactly the bug this replaced: `/new`
  // silently fell back to an in-place reset instead of relaunching, so the node
  // id + context dir never changed.) The event reason is delivered fresh on
  // every fire and is immune to the re-activation.
  //
  // For a root, reason 'new' means a brand-new graph: relaunch (park the old
  // root + boot a fresh node in this pane) or, with no pane, an in-place reset.
  // ---------------------------------------------------------------------------

  pi.on('session_start', (event: any, ctx: any): void => {
    try {
      const id: unknown = ctx?.sessionManager?.getSessionId?.();
      if (typeof id !== 'string' || id === '') return;

      // The absolute path to this session's .jsonl, captured alongside the id.
      // Resuming by path is immune to a cwd discrepancy (pi opens it directly),
      // whereas a bare id is resolved cwd-relative and forks across projects.
      const filed: unknown = ctx?.sessionManager?.getSessionFile?.();
      const sessionFile = typeof filed === 'string' && filed !== '' ? filed : null;

      // `/new` — a brand-new conversation in the same process. Route it: a
      // non-root child refreshes its session id; a ROOT in a tmux pane RELAUNCHES
      // (parks the old root + boots a fresh node in this pane via respawn-pane
      // -k, which tears down THIS pi); a root with no pane falls back to an
      // in-place reset. The relaunch's detached respawn may kill this pi before
      // the lines after the call run — that's fine; do not rely on anything
      // after handleNewSession.
      if (event?.reason === 'new') {
        try { handleNewSession(nodeId, id, process.env['TMUX_PANE'], {}, sessionFile); } catch { /* best-effort */ }
        // Clear in-memory context-steering so the fresh conversation starts clean.
        totalIn = 0;
        totalOut = 0;
        firedBands.clear();
        return;
      }

      // Boot / startup / resume / reload / fork → (re)bind this process to its
      // session id, record our OS pid (the daemon's liveness signal for inline
      // roots whose window outlives pi), and CONFIRM any pending refresh-yield.
      // Reaching session_start proves a fresh pi actually booted, so it is now
      // safe to clear intent='refresh'. reviveInPlace deliberately leaves intent
      // set: the detached respawn it dispatches can't confirm itself (it kills
      // the caller mid-flight), so a real boot is the only thing allowed to clear
      // it — otherwise a failed respawn would look identical to a successful one.
      const existing = getNode(nodeId);
      // Identity (session id/file) → meta; runtime (pid, intent) → atomic row setters.
      updateNode(nodeId, {
        pi_session_id: id,
        pi_session_file: sessionFile,
      });
      recordPid(nodeId, process.pid);
      if (existing?.intent === 'refresh') transition(nodeId, 'revive');
    } catch {
      /* best-effort; never surface from an extension handler */
    }
  });

  // ---------------------------------------------------------------------------
  // agent_start — pi entered a turn. Mark the node mid-turn (busy) so a
  // focus-away while it is genuinely working backstages it (Invariant F2)
  // rather than reaping it. Cleared at the top of agent_end (turn over).
  // ---------------------------------------------------------------------------
  pi.on('agent_start', (): void => {
    try { markBusy(nodeId); } catch { /* best-effort */ }
  });

  // ---------------------------------------------------------------------------
  // session_shutdown — clean exit → done.
  //
  // pi hands us a reason as a session tears down. Only 'quit' is a node-ending
  // event we record (markCleanExitDone guards against clobbering a node
  // agent_end already routed to done/refresh/idle-release). 'new' is owned by
  // the session_start trigger above; reload/resume/fork keep the SAME node id on
  // a swapped conversation. A true crash fires NO session_shutdown and falls
  // through to the daemon's window-gone 'dead'.
  //
  // MUST stay synchronous (no await): the synchronous DatabaseSync write then
  // lands within pi's awaited shutdown emit, before pi exits.
  // ---------------------------------------------------------------------------
  pi.on('session_shutdown', (event: any, _ctx: any): void => {
    try {
      clearBusy(nodeId); // turn marker is meaningless once pi is exiting
      // Clean /quit (reason='quit') resolves the node to done; if it held the
      // user's viewport, Q1-close it (tearDownNode kills the frozen focus pane +
      // closes the focus row → returns the user to a shell, §1.5/flow (e)). pi is
      // already exiting here, so killing its own pane is not a self-saw.
      if (markCleanExitDone(nodeId, event?.reason)) tearDownNode(nodeId);
    } catch { /* best-effort; never throw out of an extension handler */ }
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
  pi.on('turn_end', (event: any, ctx: any): void => {
    accumulate(event?.message);

    // The CURRENT context size via ctx.getContextUsage() — the exact figure pi's
    // footer shows. Captured once here for two consumers: the telemetry flush
    // (so out-of-process readers like `crtr node new` can size this node) and
    // the context-size steering below.
    //   .tokens is null/undefined only when pi can't know the size yet (no model,
    //   or right after a compaction before the next reply) — telemetry then keeps
    //   its last value and steering is skipped for the turn.
    let contextTokens: number | null = null;
    try {
      const t = ctx.getContextUsage()?.tokens;
      if (typeof t === 'number') contextTokens = t;
    } catch { /* gauge unavailable this turn */ }

    // Fire-and-forget: flushTelemetry uses synchronous fs writes and never throws.
    flushTelemetry(jobDirPath, totalIn, totalOut, model, contextTokens);

    // Context-size steering: fire the current band once, with lifecycle-specific
    // guidance (lifecycle is read live — a terminal worker may have promoted to
    // resident since launch).
    // Delivered as a STEER, not a followUp: guidance to become an orchestrator /
    // delegate / yield must redirect the node at the turn boundary, not queue
    // behind whatever it does next (where it rides along, easy to ignore).
    // Never the cumulative totalIn: under prompt caching that never grows (input
    // is a ~2-token uncached delta each turn), so the bands were unreachable and
    // the nudge never fired.
    try {
      const node = getNode(nodeId);
      const lifecycle = node?.lifecycle ?? 'terminal';
      const mode = node?.mode ?? 'base';
      const at = contextTokens !== null ? steerBand(contextTokens) : null;
      if (at !== null && !firedBands.has(at)) {
        firedBands.add(at);
        pi.sendUserMessage(`[crtr] ${steerNote(at, lifecycle, mode)}`, { deliverAs: 'steer' });
      }
    } catch {
      /* steering is best-effort */
    }

    // Persona-transition steering. When this node's mode or lifecycle changed
    // since it was last GIVEN guidance (it ran `crtr node promote` / `node
    // lifecycle` this turn, or a sibling/human flipped it while the node was
    // active), inject the guidance for its NEW persona once, then commit the
    // ack so the next turn sees no drift. This is the single delivery site for
    // in-session transitions — state-changing commands never hand-emit guidance.
    // Delivered as a STEER (like the context nudge): a persona change must
    // redirect the node at the turn boundary, not queue behind its next action.
    try {
      const drift = personaDrift(nodeId);
      if (drift !== null) {
        pi.sendUserMessage(drift.guidance, { deliverAs: 'steer' });
        commitPersonaAck(nodeId, drift.to);
      }
    } catch {
      /* persona steering is best-effort */
    }
  });

  // ---------------------------------------------------------------------------
  // agent_end — routing decision when the node's pi stops.
  // event shape: { messages: AgentMessage[] }
  // ---------------------------------------------------------------------------
  pi.on('agent_end', (event: any, ctx: any): void => {
    // All routing here is synchronous fs (status writes, telemetry, idle-release,
    // steering). The stop/yield auto-pushes that needed `await push(...)` were
    // removed, so the handler no longer needs to be async — the node reaches its
    // subscribers ONLY through its own explicit `crtr push` calls.
    // The turn has ended regardless of how it routes below — clear the mid-turn
    // marker FIRST so a focus-away from this now-parked node despawns it.
    clearBusy(nodeId);
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
          // TRULY-DONE (pushed `final` this turn). If this node owns the user's
          // viewport, its lifecycle successor takes the focus (§1.6):
          // handFocusToManager hands the focus row to the manager (the node up
          // the subscribes_to spine it reports to) and, when that manager's pi is
          // LIVE in the backstage, synchronously swaps it into this now-frozen
          // focus pane; a DORMANT manager is revived into the pane by the daemon
          // on the `final` it just pushed — either way no new window, no taint.
          // No manager (a root) or a manager already focused elsewhere → Q1-close
          // this focus AND flip remain-on-exit OFF on %m's window so the pane
          // closes when this pi exits (return-to-shell) instead of freezing into
          // an orphan. We CANNOT closePane(%m) from inside %m (self-saw), but the
          // pi is still alive mid-shutdown, so remain-on-exit-off is safe and
          // makes tmux reap the pane on exit. An unfocused done node just shuts
          // down (no pane anywhere, Invariant P). M is done → it owns no pane
          // (Invariant P), so null its own presence in BOTH sub-branches before
          // shutdown.
          const f = focusOf(nodeId);
          if (f !== null) {
            const managerId = node.parent ?? subscribersOf(nodeId)[0]?.node_id ?? null;
            if (!handFocusToManager(f.focus_id, managerId)) {
              // Q1 return-to-shell, self-saw-safe: close the focus row + disarm the
              // pane's freeze so it reaps on exit (we can't closePane our own pane).
              closeFocusToShell(f.focus_id, nodeId);
            }
          }
          setPresence(nodeId, { pane: null, tmux_session: null, window: null }); // M done → owns no pane
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
          // A yield is SILENT to subscribers: the node keeps its identity and
          // subscription edges across the revive and reports only through its
          // own explicit `crtr push` calls, so there is no checkpoint push here
          // — just re-exec a fresh pi in place against the roadmap.
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

        // (c) Natural stop — run the stop-guard to classify this stop. Nothing
        //     is auto-pushed: the node reaches its subscribers only through its
        //     own explicit `crtr push` calls this turn. The guard decides
        //     whether the stop is a legitimate dormancy (idle-release, or an
        //     attended root staying live) or a stall to reprompt.
        const decision = evaluateStop(nodeId, { pushedFinal: false, askedHuman: false });

        if (decision.action === 'reprompt') {
          // Stalled — re-prompt so the node finishes or escalates with an
          // explicit `crtr push final` (or `crtr human ask`). Deliver as a
          // followUp: the turn just ended but pi may still be flushing, so an
          // unqualified sendUserMessage races with 'already processing'.
          pi.sendUserMessage(decision.message, { deliverAs: 'followUp' });
          return;
        }

        // 'allow' — the node legitimately stopped. Nothing is pushed here; any
        // report it owed its subscribers was sent by an explicit `crtr push`
        // during the turn.
        //
        // Idle-release: a node awaiting its workers (reason 'awaiting') is holding
        // a tmux window for nothing. Free it — mark it idle-released and shut pi
        // down; the daemon watches its inbox and revives it (resume) the moment a
        // subscribed worker delivers. An 'attended' root never releases: the human
        // is its wake source, so we keep its window live and dormant.
        if (decision.reason === 'awaiting') {
          // AWAITING ≠ done (no manager-takeover). What happens next splits on
          // whether the user is WATCHING this node:
          //   • FOCUSED → it holds the user's viewport, so keep pi LIVE and
          //     dormant (exactly like a resident root): do NOT release or shut
          //     down. The in-process inbox-watcher (still alive) wakes it the
          //     instant a worker pushes — no respawn, no frozen pane, the pane
          //     stays interactive. When the user later focuses AWAY, placement's
          //     retarget reclassifies it as a parked terminal viewer and releases
          //     it then (transition 'release' + pane reaped), so the kept-alive
          //     pi is reclaimed on focus-away, never held forever.
          //   • UNFOCUSED → no one is watching, so holding a live pi for a window
          //     is waste. Release it (idle + idle-release) and shut pi down; its
          //     backstage pane closes and the daemon revives it (resume) on the
          //     next unseen inbox entry.
          if (focusOf(nodeId) !== null) return; // focused → stay alive, dormant
          transition(nodeId, 'release');
          try { ctx?.shutdown?.(); } catch { /* ignore */ }
          return;
        }
    } catch {
      /* agent_end handler must never throw out of the extension */
    }
  });
}

export default registerCanvasStophook;
