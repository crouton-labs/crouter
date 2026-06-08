// crtrd — the thin supervisor daemon. One instance per canvas.
//
// Sole responsibility: supervise tmux window exit and revive nodes. No
// orchestration logic lives here. The daemon is a process-lifecycle watcher.
//
// Model (v3: liveness is PANE-existence, not window-existence — a manual
// move-pane/join-pane/break-pane must never read as a node death)
//   • Poll every intervalMs (default 2000ms).
//   • For each active|idle node: check whether its tmux PANE is still alive
//     (isNodePaneAlive; window-existence is only a legacy/no-pane fallback).
//   • Pane alive → reconcile its LOCATION (follow any manual move; lazy-backfill
//     a legacy row's pane), then judge pi liveness — healthy, skip otherwise.
//   • Pane gone + intent==='refresh' → fresh respawn (node asked to yield).
//   • Pane gone + intent==='idle-release' → node freed its own pane while
//     dormant; clear the stale window ref and revive (resume) when its inbox
//     gains an unseen entry.
//   • Pane gone + any other intent → route on what the node was doing:
//       - never-booted (pi_session_id null) → crash ('dead') + surface boot fail
//       - mid-generation (busy marker present) → crash ('dead')
//       - finished its turn, still awaiting a live child → crash ('dead'), for now
//       - finished its turn, awaiting nothing live → finalize ('done')
//   • Nodes with no tmux placement (inline roots) are skipped.
//
// Single-instance guarantee
//   A PID file at crtrHome()/crtrd.pid prevents double-runs. On start, if the
//   file exists and the recorded pid is alive, we refuse to start (exit 0).
//   On stop (SIGINT/SIGTERM/exit) we remove the file.

import {
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { crtrHome } from '../core/canvas/paths.js';
import {
  listNodes,
  getRow,
  setPresence,
  getNode,
  hasActiveLiveSubscription,
  hasPendingSelfWake,
  dueWakes,
  consumeWake,
  advanceWake,
  type NodeRow,
  type NodeMeta,
  type Wakeup,
  type NotedWakePayload,
  type DeadlineWakePayload,
} from '../core/canvas/index.js';
import { transition } from '../core/runtime/lifecycle.js';
import { isBusy } from '../core/runtime/busy.js';
import { reconcile } from '../core/runtime/placement.js';
import { hostFor } from '../core/runtime/host.js';
import { reviveNode } from '../core/runtime/revive.js';
import { spawnChild, type SpawnChildOpts } from '../core/runtime/spawn.js';
import { wakeOriginFrom } from '../core/runtime/bearings.js';
import { pushUrgent, pushUpdate } from '../core/feed/feed.js';
import { appendInbox, readInboxSince, readCursor } from '../core/feed/inbox.js';
import { nextSlotAfter } from '../core/wake.js';

/** Surface a vehicle that never booted.
 *
 *  `spawnChild` returns status="active" the instant the tmux window opens — it
 *  does NOT wait for pi to come up, because boot is inherently slow (and slower
 *  under load) and racing it would either block the spawner or false-fail a
 *  slow-but-healthy launch. The cost of that optimism: a pi that dies before its
 *  first session_start (so `pi_session_id` was never recorded) is invisible —
 *  the parent believes its child is running. When the daemon later finds the
 *  pane gone with no session ever bound, it errors LOUDLY up the spine: an
 *  urgent push so the parent learns the child failed to launch instead of just
 *  seeing a silent `dead`. */
async function surfaceBootFailure(meta: NodeMeta): Promise<void> {
  const body =
    `⚠ Spawn failed — \`${meta.name}\` (${meta.kind}) never started.\n\n` +
    `Its pi vehicle exited before the session came up (no pi_session_id was ever ` +
    `recorded), so the node produced no output. This is almost always a transient ` +
    `launch failure — e.g. resource pressure when several nodes boot at once — not ` +
    `a fault in the task itself.\n\n` +
    `If the work still needs doing, re-spawn it; if spawns keep dying, spawn fewer at a time.`;
  await pushUrgent(meta.node_id, body, { from: meta.node_id });
}

/** Wake an inbox-waiting PARENT when the daemon ends a child the child did NOT
 *  end itself — a mid-generation CRASH (the pane died inside a turn) or a quiet-
 *  turn FINALIZE (the pane was dismissed after the turn ended with nothing live
 *  to wait for). Mirrors surfaceBootFailure: a single push fanned to
 *  subscribersOf(child), so a purely-inbox-waiting parent is woken on the SAME
 *  channel as a `push final` — its live inbox-watcher, or this daemon's dormant-
 *  revive second pass. Without it a parent that delegated and just stopped hangs
 *  forever on these outcomes (D-1 finding: today only `push final` / never-booted
 *  wake it). The doctrine "delegate and stop; the runtime wakes you" requires
 *  EVERY terminal child outcome to reach the parent.
 *
 *  Fires ONLY on genuine death — NEVER on healthy dormancy. The CALLER owns that
 *  boundary: this is invoked from the crash + finalize branches only; a child
 *  that ended its turn still awaiting a live grandchild OR holding a pending
 *  self-wake routes to `release` (revivable) and never reaches here. A CRASH is
 *  URGENT (a fault, like a boot failure); a quiet FINALIZE is a normal update (a
 *  clean dismissal — wake the dormant parent without interrupting a live one
 *  mid-turn). */
async function surfaceChildDeath(meta: NodeMeta, cause: 'crash' | 'finalize'): Promise<void> {
  if (cause === 'crash') {
    await pushUrgent(
      meta.node_id,
      `⚠ Child died — \`${meta.name}\` (${meta.kind}) was killed mid-task.\n\n` +
        `Its pi vehicle went away mid-generation (the pane was closed or crashed while it was ` +
        `working), so it never pushed a final report. Re-spawn it if the work still needs doing.`,
      { from: meta.node_id },
    );
  } else {
    await pushUpdate(
      meta.node_id,
      `\`${meta.name}\` (${meta.kind}) ended without a final report.\n\n` +
        `Its turn ended and its pane was closed with nothing live left to wait for, so the runtime ` +
        `finalized it. It pushed no \`final\` — check its reports/ for anything it left, and re-spawn ` +
        `if the result is incomplete.`,
      { from: meta.node_id },
    );
  }
}

const DEFAULT_INTERVAL_MS = 2000;

// How long a node's pi may be observed dead-while-its-window-lives before the
// daemon revives it. MUST exceed worst-case pi boot time: a normal in-place
// refresh (reviveInPlace) transiently shows a dead OLD pid for the gap between
// the old pi dying and the fresh pi booting + re-recording its pid, and we must
// not double-spawn into that gap.
const REVIVE_GRACE_MS = 20_000;

// Per-node first-observed-dead timestamps, for the grace window above. In-memory
// only — a daemon restart resets it (worst case: one extra grace interval).
const unhealthySince = new Map<string, number>();

// Wake-failure dedup latch (third pass): wakeup_ids we've already fail-loud
// notified about, so a permanently-broken spawn-cron (or a quarantined recurrence)
// notifies the armer ONCE and then stays quiet until the next success or cancel —
// the unrotated, append-only inbox.jsonl must not be flooded (Min-9). In-memory
// only, like unhealthySince; a daemon restart resets it (worst case: one repeat
// notice). A successful spawn clears its entry so a future failure re-notifies.
const notifiedWakeFailures = new Set<string>();

export type LivenessVerdict = 'leave' | 'pending' | 'revive';

/** Decide what to do with a node whose tmux pane is alive, from its pi
 *  liveness and how long it's been dead. Pure — the time-and-tmux side effects
 *  live in handleLiveWindow; this is the unit-testable core.
 *    piPidAlive: true=alive, false=dead, null=no pid recorded (legacy node, or a
 *      relaunch in flight) — leave those to the pane-gone pass.
 *    deadFor: ms since first observed dead, or null on the first observation. */
export function livenessVerdict(piPidAlive: boolean | null, deadFor: number | null): LivenessVerdict {
  if (piPidAlive !== false) return 'leave';
  if (deadFor === null || deadFor < REVIVE_GRACE_MS) return 'pending';
  return 'revive';
}

/** A node whose tmux PANE is alive: pane-existence does NOT prove pi is
 *  alive (an inline root runs pi under a persistent login shell that survives
 *  pi's death), so gauge liveness on the recorded pid and revive a dead pi once
 *  it's been dead past the grace window. */
function handleLiveWindow(row: NodeRow, now: number, revivedThisTick: Set<string>): void {
  const id = row.node_id;
  // Defensive: an idle-release node whose pane is still alive must NOT be
  // grace-revived here — it is dormant BY CHOICE and is woken only by a worker's
  // inbox push (the second pass below); grace-reviving would pre-empt that and
  // churn the pane. (Focused-await nodes now stay pi-LIVE instead of releasing —
  // see the stophook awaiting branch — so reaching this with a live pane is rare;
  // the guard stays as a cheap safety net, e.g. a remain-on-exit pane frozen for
  // a done-node's manager handoff.)
  if (row.intent === 'idle-release') {
    unhealthySince.delete(id);
    return;
  }
  const pid = row.pi_pid;
  const piPidAlive = pid == null ? null : isPidAlive(pid);

  if (piPidAlive !== false) {
    unhealthySince.delete(id); // alive, or no pid to judge — nothing pending
    return;
  }

  const since = unhealthySince.get(id);
  const verdict = livenessVerdict(piPidAlive, since === undefined ? null : now - since);
  if (verdict === 'pending') {
    if (since === undefined) unhealthySince.set(id, now);
    return;
  }

  // 'revive' — pi has been dead past the grace window while its window lived on.
  unhealthySince.delete(id);
  // A refresh-yield wants fresh context (re-read the roadmap); any other death
  // resumes the saved conversation. reviveNode opens a fresh window and clears
  // pi_pid, so the next tick won't re-fire on this stale pid.
  const resume = row.intent !== 'refresh';
  process.stderr.write(
    `[crtrd] revive ${id} (pi dead, pane alive, intent=${String(row.intent)})\n`,
  );
  reviveNode(id, { resume });
  // Record for the third pass's bare double-spawn guard (Maj-4): this node's
  // pi_pid is now NULL until the fresh pi re-records it, so a same-tick bare wake
  // would otherwise read it as "not live" and double-spawn pi on the same .jsonl.
  revivedThisTick.add(id);
}

/** Fail loud for a drifted/broken wake (design §6.6/Q5): wake the ARMER DIRECTLY
 *  via appendInbox — NOT pushUrgent, which fans to subscribersOf(owner), and a
 *  DETACHED spawn has no subscribers (so the armer would never be reached); the
 *  literal {from:null} is also a type error for pushUrgent. Deduped per wakeup_id
 *  (notify once, suppress until the next success/cancel via notifiedWakeFailures)
 *  so a broken spawn-cron can't flood the unrotated inbox.jsonl. Falls back to a
 *  loud daemon-log line when the owner no longer resolves to a node. */
function failLoudWake(w: Wakeup, label: string, body: string): void {
  if (notifiedWakeFailures.has(w.wakeup_id)) return;
  notifiedWakeFailures.add(w.wakeup_id);
  if (getRow(w.owner_id) !== null) {
    appendInbox(w.owner_id, {
      from: null,
      tier: 'urgent',
      kind: 'urgent',
      label,
      data: { body },
    });
  } else {
    process.stderr.write(
      `[crtrd] wake ${w.wakeup_id} failed (owner ${w.owner_id} gone): ${body}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pidfile
// ---------------------------------------------------------------------------

function pidfilePath(): string {
  return join(crtrHome(), 'crtrd.pid');
}

function writePidfile(): void {
  // Ensure the canvas home exists before writing.
  mkdirSync(crtrHome(), { recursive: true });
  writeFileSync(pidfilePath(), String(process.pid), 'utf8');
}

function removePidfile(): void {
  try {
    rmSync(pidfilePath());
  } catch {
    // Already gone — nothing to do.
  }
}

/** Read the pid stored in the pidfile, or null if absent / malformed. */
export function readPidfile(): number | null {
  const p = pidfilePath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True if a process with `pid` is currently alive (signal-0 probe). `kill(pid,
 *  0)` throws ESRCH when the process is gone; EPERM means it exists but isn't
 *  ours — still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when a crtrd process is already running (pidfile exists + pid alive). */
export function isDaemonRunning(): boolean {
  const pid = readPidfile();
  return pid !== null && isPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Supervisor tick
// ---------------------------------------------------------------------------

export async function superviseTick(now: number = Date.now()): Promise<void> {
  let rows: NodeRow[];
  try {
    rows = listNodes({ status: ['active', 'idle'] });
  } catch (err) {
    process.stderr.write(
      `[crtrd] listNodes error: ${(err as Error).message}\n`,
    );
    return;
  }

  // Node-ids revived in pass 1 + pass 2 THIS tick — the third pass's bare branch
  // skips them so it never launches a second pi on the same .jsonl (Maj-4).
  const revivedThisTick = new Set<string>();

  for (const row of rows) {
    try {
      // Runtime (tmux_session, window, intent, pi_pid) is now authoritative IN
      // the row — no per-node getNode re-read. Only the boot-failure split below
      // still needs identity (pi_session_id), read on demand there.

      // Nodes with no tmux placement at all are inline roots — not daemon-
      // managed. Pane-anchored: a node still counts as placed if it has a pane
      // even when its derived window/session cache is null.
      if (row.tmux_session == null && row.window == null && row.pane == null) continue;

      if (hostFor(row).isAlive(row)) {
        // The pane is up — but that alone doesn't mean pi is. Reconcile first
        // (follow any manual pane move, and lazy-backfill a legacy row's pane
        // from its live window), then judge pi liveness off the fresh row. The
        // alive-gate means reconcile here only ever FOLLOWS/backfills — never
        // nulls the LOCATION out from under the gone-branches below.
        reconcile(row.node_id);
        handleLiveWindow(getRow(row.node_id) ?? row, now, revivedThisTick);
        continue;
      }

      // The pane is gone. Branch on why.
      unhealthySince.delete(row.node_id); // pane-gone path owns it now
      if (row.intent === 'refresh') {
        // The node set intent=refresh before stopping — a clean yield. Respawn
        // fresh so it re-reads its roadmap/context dir.
        process.stderr.write(`[crtrd] revive ${row.node_id} (refresh-yield)\n`);
        reviveNode(row.node_id, { resume: false });
        revivedThisTick.add(row.node_id); // third-pass bare double-spawn guard (Maj-4)
      } else if (row.intent === 'idle-release') {
        // The node freed its own window on purpose while dormant. Drop the stale
        // window ref and keep it 'idle'; the inbox-poll pass below revives it
        // (resume) the moment a subscribed worker delivers.
        setPresence(row.node_id, { tmux_session: row.tmux_session, window: null });
      } else {
        // The pane vanished without the node yielding or releasing — most often
        // the user CLOSED it (kill-pane/kill-window), which crtr cannot tell apart
        // from a window death. Closing a pane is a benign "get it off my screen",
        // NOT an orphan-the-work kill, so route on what the node was DOING and keep
        // anything with outstanding work REVIVABLE:
        //   • never-booted (pi_session_id null) → crash + surface boot failure.
        //     A spawn failure the parent was never told about — it had no turn to
        //     finish, so it can never be a finalize. (Boot-failed vs crashed turns
        //     on pi_session_id, an IDENTITY field — the one place this pass still
        //     reads meta; surfaceBootFailure also wants name/kind for its message.)
        //   • MID-GENERATION (busy marker present) → crash (→dead). agent_start
        //     touched the marker and agent_end never cleared it ⇒ the pane was
        //     killed inside a turn: a genuine mid-run death. (The pane is gone, so
        //     pi is dead; we read isBusy WITHOUT the usual AND-pidAlive guard on
        //     purpose — here a stale marker IS the proof it died mid-turn.)
        //   • finished its turn (busy ABSENT) but STILL WAITING — awaiting a LIVE
        //     child OR holding a pending self-wake → RELEASE (→idle + idle-release),
        //     NOT dead, and NO parent wake. This is HEALTHY DORMANCY (the same
        //     boundary the stop-guard draws): real orchestration / a scheduled
        //     clock is outstanding; killing it would orphan in-flight work, and
        //     waking its parent here would re-create the spurious-wake storm the
        //     wake doctrine exists to kill. Drop the stale window; the second /
        //     wakeups pass revives it on the next child push or clock fire.
        //   • finished its turn AND nothing live to wait for AND no pending clock →
        //     finalize (→done): it did its own work and the pane was closed to
        //     dismiss it. GENUINE death → wake the inbox-waiting parent.
        const meta = getNode(row.node_id);
        const neverBooted = meta !== null && meta.pi_session_id == null;
        const finishedTurn = !neverBooted && !isBusy(row.node_id);
        // The death-vs-dormancy boundary, drawn EXACTLY where the stop-guard draws
        // it (stop-guard.ts): a live active subscription OR a pending self-wake is
        // a legitimate wait. Only a finished node with NEITHER is genuinely done.
        const stillWaiting =
          hasActiveLiveSubscription(row.node_id) || hasPendingSelfWake(row.node_id);
        if (finishedTurn && !stillWaiting) {
          transition(row.node_id, 'finalize');
          process.stderr.write(
            `[crtrd] done ${row.node_id} (pane gone after turn end, nothing live to wait for)\n`,
          );
          // Wake the inbox-waiting parent: the child ended without a `push final`
          // and was dismissed; without this the daemon-finalize reaches no one
          // (D-1) and a purely-inbox-waiting parent hangs forever.
          if (meta !== null) {
            try {
              await surfaceChildDeath(meta, 'finalize');
            } catch (err) {
              process.stderr.write(
                `[crtrd] surfaceChildDeath(finalize) ${row.node_id} error: ${(err as Error).message}\n`,
              );
            }
          }
        } else if (finishedTurn) {
          // Still legitimately waiting (a live child OR a pending self-wake) →
          // revivable, NOT a death: closing the pane must not orphan in-flight
          // work, and healthy dormancy must NOT wake the parent. Clear the stale
          // window; the second / wakeups pass revives it.
          setPresence(row.node_id, { tmux_session: row.tmux_session, window: null, pane: null });
          transition(row.node_id, 'release');
          process.stderr.write(
            `[crtrd] release ${row.node_id} (pane gone while still waiting → revivable, no parent wake)\n`,
          );
        } else {
          transition(row.node_id, 'crash');
          if (neverBooted) {
            process.stderr.write(
              `[crtrd] boot-failed ${row.node_id} (pane gone before pi ever started)\n`,
            );
            try {
              await surfaceBootFailure(meta as NodeMeta);
            } catch (err) {
              process.stderr.write(
                `[crtrd] surfaceBootFailure ${row.node_id} error: ${(err as Error).message}\n`,
              );
            }
          } else {
            process.stderr.write(
              `[crtrd] dead ${row.node_id} (pane gone mid-generation, intent=${String(row.intent)})\n`,
            );
            // Wake the inbox-waiting parent on a GENUINE mid-run death (D-1): a
            // booted child whose pane died inside a turn is unambiguously dead
            // (busy marker present), never healthy dormancy.
            if (meta !== null) {
              try {
                await surfaceChildDeath(meta, 'crash');
              } catch (err) {
                process.stderr.write(
                  `[crtrd] surfaceChildDeath(crash) ${row.node_id} error: ${(err as Error).message}\n`,
                );
              }
            }
          }
        }
      }
    } catch (err) {
      // One bad node must never kill the loop.
      process.stderr.write(
        `[crtrd] error supervising ${row.node_id}: ${(err as Error).message}\n`,
      );
    }
  }

  // Second pass: revive idle-released nodes whose inbox has unseen entries.
  // The in-process inbox-watcher dies with pi, so the daemon owns wake-on-message
  // for dormant nodes. readCursor is the cursor the watcher persisted before
  // exit; any entry past it is undelivered work — resume the node to handle it.
  for (const row of rows) {
    try {
      // Re-read the ROW for fresh runtime (the first pass may have mutated it);
      // no meta needed — status/intent/window/tmux_session all live in the row.
      const r = getRow(row.node_id);
      if (r === null) continue;
      if (r.status !== 'idle' || r.intent !== 'idle-release') continue;
      // The in-process inbox-watcher only owns delivery while pi is actually LIVE.
      // A released node is pi-DEAD with no watcher — whether its pane is GONE
      // (unfocused release) or still ALIVE (a remain-on-exit pane frozen for a
      // done-node's manager handoff) — so the daemon must wake it. Gate the skip
      // on pi liveness, NOT pane presence (which would skip a frozen pane
      // forever, §3c).
      if (r.pi_pid != null && isPidAlive(r.pi_pid)) continue;

      const entries = readInboxSince(row.node_id, readCursor(row.node_id));
      if (entries.length > 0) {
        process.stderr.write(`[crtrd] revive ${row.node_id} (idle-release, inbox)\n`);
        reviveNode(row.node_id, { resume: true });
        revivedThisTick.add(row.node_id); // third-pass bare double-spawn guard (Maj-4)
      }
    } catch (err) {
      process.stderr.write(
        `[crtrd] error polling inbox ${row.node_id}: ${(err as Error).message}\n`,
      );
    }
  }

  // Third pass: FIRE DUE SCHEDULED WAKES (the wakeups engine, migration v7).
  // Runs immediately AFTER the inbox second pass — the ordering is load-bearing
  // (design §6.4): a same-tick inbox revive runs cancelDeadlinesFor (inside
  // reviveNode) BEFORE this pass's dueWakes query, so an event that wins a
  // deadline deletes its row before it can fire. The pass-2 inbox loop above is
  // otherwise untouched (design D3) — it stays the generic wake-on-message path
  // that noted/deadline rely on; the only addition is the revivedThisTick.add
  // observation that the bare branch below needs to avoid a double-spawn.
  // For each due row, in fire_at order, settle the row FIRST (advance-or-consume
  // — crash-safety, design D4) THEN enact by kind, wrapped per-row so one bad
  // wake never kills the tick.
  const nowIso = new Date(now).toISOString();
  const nowDate = new Date(now);
  let due: Wakeup[];
  try {
    due = dueWakes(nowIso);
  } catch (err) {
    process.stderr.write(`[crtrd] dueWakes error: ${(err as Error).message}\n`);
    due = [];
  }
  for (const w of due) {
    try {
      // 1. Advance-or-consume FIRST (design D4): settle the row's pending state
      //    before ANY side effect, so a daemon crash mid-fire can never double-
      //    fire (a double SPAWN is the worst case — structurally prevented here).
      if (w.recur == null) {
        consumeWake(w.wakeup_id);
      } else {
        let nextFire: string;
        try {
          nextFire = nextSlotAfter(w.recur, nowDate);
        } catch (err) {
          // The recur is unparseable (parseCadence validates at arm time, so this
          // is a rare backstop — a corrupted/foreign row). Leaving a past-fire_at
          // row pending would re-qualify it EVERY tick (silent CPU spin, enact
          // never reached), so quarantine it (consume) + fail loud ONCE; never
          // re-query it each tick (Min-8).
          consumeWake(w.wakeup_id);
          failLoudWake(
            w,
            '⚠ recurrence quarantined',
            `Scheduled wake ${w.wakeup_id} has an unparseable recurrence and was removed: ` +
              `${(err as Error).message}\n\nRe-arm it with a valid cadence.`,
          );
          continue;
        }
        advanceWake(w.wakeup_id, nextFire);
      }

      // 2. Enact by kind.
      if (w.kind === 'bare') {
        // A bare wake leaves NO inbox entry, so pass 2 can never wake it — it
        // must revive DIRECTLY with resume:false (re-reads roadmap; AC-N2).
        const target = w.node_id == null ? null : getRow(w.node_id);
        if (target === null) continue; // target gone (the FK cascade reaped it)
        // Same-tick double-spawn guard (Maj-4): pass 1/2 (or an earlier bare row
        // this pass) may have revived this node THIS tick — reviveNode clears
        // pi_pid to NULL before the fresh pi re-records it, so the pi_pid==null
        // liveness check below would falsely read "not live" and a second
        // reviveNode would launch a SECOND pi on the same .jsonl (corruption).
        // (Pane-existence is the WRONG guard — it would no-op a frozen-focus bare
        // wake, which is pane-alive/pi-dead by design.)
        if (revivedThisTick.has(target.node_id)) continue;
        // pi live → no-op (AC-E3 bare): an already-awake node needs no revive.
        if (target.pi_pid != null && isPidAlive(target.pi_pid)) continue;
        process.stderr.write(`[crtrd] wake ${target.node_id} (bare alarm)\n`);
        // wakeReason carries the timer provenance so the fresh-revive kickoff
        // leads with a <crtr-wake> block (Invariant B/D: the node learns a clock,
        // not an event, woke it) instead of a generic context-refresh framing.
        reviveNode(target.node_id, { resume: false, wakeReason: wakeOriginFrom(w) });
        revivedThisTick.add(target.node_id);
      } else if (w.kind === 'noted') {
        // Deliver the note; the UNMODIFIED pass 2 wakes the dormant target next
        // tick (AC-N1), or its live in-process watcher delivers it (AC-E3 noted).
        if (w.node_id == null) continue;
        const p = w.payload as NotedWakePayload;
        // Mark the delivery as a SCHEDULED wake (Invariant D): the woken node sees
        // only the rendered digest (inbox inlines label/body, never arbitrary
        // data keys), so the timer signal MUST ride the visible label — the same
        // ⏰ family deadline uses — so a noted wake is distinguishable from a plain
        // `node msg`, not indistinguishable from it.
        appendInbox(w.node_id, {
          from: w.owner_id ?? null,
          tier: 'normal',
          kind: 'message',
          label: `⏰ scheduled wake — ${p.label}`,
          data: { body: p.body },
        });
      } else if (w.kind === 'deadline') {
        // Same delivery as noted but URGENT tier. The woken node sees only the
        // RENDERED digest (inbox inlines label/body, NEVER arbitrary data keys),
        // so the timeout signal MUST ride the visible label/body (Maj-8);
        // data.timeout is a machine-readable mirror only. body is always non-
        // empty (the surface supplies a default timeout note when none is
        // authored, Maj-7). One-shot — already consumed in step 1.
        if (w.node_id == null) continue;
        const p = w.payload as DeadlineWakePayload;
        appendInbox(w.node_id, {
          from: w.owner_id ?? null,
          tier: 'urgent',
          kind: 'message',
          label: `⏰ deadline reached — ${p.label}`,
          data: { body: p.body, timeout: true },
        });
      } else if (w.kind === 'spawn') {
        // Re-derives LaunchSpec live (AC-W2); payload.parent is the non-null
        // resolved armer id (T2/T7 guarantee it), so spawnChild never throws the
        // "requires a calling node" error even for a --root recipe.
        const recipe = w.payload as SpawnChildOpts;
        try {
          // Spread in the wake provenance at fire time (in-memory only; never the
          // stored recipe) so the born node's kickoff leads with a <crtr-wake>
          // block — it learns, by construction, that a timer birthed it (and, for
          // a spawn-cron, that it is one run of a standing job).
          spawnChild({ ...recipe, wakeOrigin: wakeOriginFrom(w) });
          notifiedWakeFailures.delete(w.wakeup_id); // success clears the dedup latch
        } catch (err) {
          // Fail loud by waking the ARMER DIRECTLY (design §6.6/Q5). The row was
          // already settled in step 1, so this is never a hot retry loop; a
          // permanently-broken spawn-cron stays deduped-noisy until cancel.
          failLoudWake(
            w,
            '⚠ deferred spawn failed',
            `Deferred spawn (${recipe.kind} @ ${recipe.cwd}) failed: ` +
              `${(err as Error).message}\n\nRe-home (fix the cwd/parent) or re-arm the wake.`,
          );
        }
      }
    } catch (err) {
      // One bad wake never kills the tick.
      process.stderr.write(
        `[crtrd] error firing wake ${w.wakeup_id}: ${(err as Error).message}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// runDaemon — the public entry point
// ---------------------------------------------------------------------------

export interface DaemonOpts {
  /** Milliseconds between supervision polls. Default 2000. */
  intervalMs?: number;
}

/** Start the supervisor loop.
 *
 *  If a live crtrd is already running (pidfile + pid alive), exits immediately
 *  (exit 0 — idempotent, not an error). Otherwise, writes the pidfile, sets up
 *  signal handlers, and enters the poll loop.
 *
 *  Returns a teardown callback that stops the loop and removes the pidfile.
 *  (Mainly useful for tests; in production the daemon runs until signaled.) */
export function runDaemon(opts: DaemonOpts = {}): () => void {
  if (isDaemonRunning()) {
    const pid = readPidfile();
    process.stderr.write(`[crtrd] already running (pid ${pid ?? '?'})\n`);
    process.exit(0);
  }

  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  writePidfile();

  process.stderr.write(
    `[crtrd] started (pid ${process.pid}, interval ${interval}ms)\n`,
  );

  let running = true;

  // Cleanup — idempotent.
  const cleanup = (): void => {
    removePidfile();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', () => {
    cleanup();
  });

  // Recursive setTimeout keeps ticks sequential and avoids overlap on slow
  // canvases (a timer that fires while a prior tick is awaiting is dropped).
  const scheduleTick = (): void => {
    if (!running) return;
    superviseTick()
      .catch((err: unknown) => {
        process.stderr.write(
          `[crtrd] tick error: ${(err as Error).message}\n`,
        );
      })
      .finally(() => {
        if (running) setTimeout(scheduleTick, interval);
      });
  };

  const initialTimer = setTimeout(scheduleTick, interval);

  return (): void => {
    running = false;
    clearTimeout(initialTimer);
    cleanup();
  };
}

export default runDaemon;
