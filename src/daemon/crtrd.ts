// crtrd — the thin supervisor daemon. One instance per canvas.
//
// Sole responsibility: supervise engine exit and revive nodes. No orchestration
// logic lives here. The daemon is a process-lifecycle watcher.
//
// Model (broker-is-the-only-host): EVERY node runs on a detached headless broker
// process; a tmux pane, when present, is only a VIEWER of that engine and never
// hosts it. So liveness is pid-only — the broker pid the stophook records on
// session_start. A viewer window closing is not a node death; the daemon never
// reaps a node on pane/window state. All node liveness routes through
// handleNodeLiveness:
//   • Poll every intervalMs (default 2000ms).
//   • pid alive → leave; but enforce a stuck refresh-yield (§H, see below).
//   • pid null + pi_session_id set → relaunch in flight; leave.
//   • pid null + pi_session_id null → after a boot grace, crash + surface boot
//     failure (the broker exited before session_start).
//   • pid dead + intent==='refresh' → fresh respawn (node asked to yield).
//   • pid dead + intent==='idle-release' → dormant by choice; the second pass
//     revives (resume) when its inbox gains an unseen entry.
//   • pid dead + any other intent → grace-revive RESUME on the saved session.
//
// §H refresh-authority: a stale in-process stophook (pi extensions never reload,
// so a days-old resident carries an old hook) can leave intent='refresh' on a
// LIVE engine forever — the hook never calls shutdown, so the pid never dies and
// the normal dead-pid refresh path never fires. The daemon is the authority:
// when intent='refresh' persists on a live engine whose turn is over, past a
// grace, it force-kills the engine itself (handleYieldStall) so the dead-pid
// refresh path then revives it fresh.
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
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { crtrHome, nodeDir, jobDir } from '../core/canvas/paths.js';
import {
  listNodes,
  getRow,
  getNode,
  dueWakes,
  consumeWake,
  advanceWake,
  listFocuses,
  closeFocusRow,
  type NodeRow,
  type NodeMeta,
  type Wakeup,
  type NotedWakePayload,
  type DeadlineWakePayload,
} from '../core/canvas/index.js';
import { transition } from '../core/runtime/lifecycle.js';
import { isBusy } from '../core/runtime/busy.js';
import { isPidAlive } from '../core/canvas/pid.js';
import { listLivePanes, tearDownNode } from '../core/runtime/placement.js';
import { reviveNode } from '../core/runtime/revive.js';
import { spawnChild, type SpawnChildOpts } from '../core/runtime/spawn.js';
import { wakeOriginFrom } from '../core/runtime/bearings.js';
import { pushUrgent } from '../core/feed/feed.js';
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

const DEFAULT_INTERVAL_MS = 2000;

// How long a node's broker pid may be observed dead before the daemon revives
// it. MUST exceed worst-case broker boot time: a refresh / crash-revive
// transiently shows a dead OLD pid for the gap between the old broker exiting
// and the fresh broker booting + re-recording its pid, and we must not
// double-spawn into that gap.
const REVIVE_GRACE_MS = 20_000;

// Per-node first-observed-dead timestamps, for the grace window above. In-memory
// only — a daemon restart resets it (worst case: one extra grace interval).
const unhealthySince = new Map<string, number>();

// §H refresh-authority grace: how long a node may sit with intent='refresh', its
// turn OVER (busy marker absent) and its engine still ALIVE before the daemon
// concludes the refresh stalled and force-kills the engine. The healthy window is
// seconds: a sound stophook calls shutdown() the instant the refresh turn ends,
// the engine pid dies, and the dead-pid refresh path revives fresh. Minutes of
// that state means the engine never exited — either the shutdown/respawn path
// hung (observed at ~200k-token contexts) OR a STALE in-process stophook (pi
// extensions never reload, so a days-old resident carries an old hook that
// ignores intent='refresh' at stop) never called shutdown at all. Nothing else
// will ever unstick it — the daemon only revives DEAD engines — so the daemon is
// the authority: kill the engine here, then the dead-pid path revives.
export const YIELD_STALL_GRACE_MS = 3 * 60_000;

// After a yield-stall SIGTERM, how long the pi gets to die gracefully before
// escalating to SIGKILL (a pi hung at context overflow may not run handlers).
const KILL_ESCALATE_MS = 20_000;

// Per-node yield-stall clocks (audit 2026-06-09, Bug 1). In-memory like
// unhealthySince — a daemon restart resets them (worst case: one extra grace).
const yieldStallSince = new Map<string, number>();
const yieldTermAt = new Map<string, number>();

// Wake-failure dedup latch (third pass): wakeup_ids we've already fail-loud
// notified about, so a permanently-broken spawn-cron (or a quarantined recurrence)
// notifies the armer ONCE and then stays quiet until the next success or cancel —
// the unrotated, append-only inbox.jsonl must not be flooded (Min-9). In-memory
// only, like unhealthySince; a daemon restart resets it (worst case: one repeat
// notice). A successful spawn clears its entry so a future failure re-notifies.
const notifiedWakeFailures = new Set<string>();

/** Refresh-stall decision (§H refresh-authority; audit 2026-06-09, Bug 1 — node
 *  mq5v9hfa-74493d45 and siblings; stuck-refresh — parent mq7s5o93): a `node
 *  yield` / refresh records intent='refresh' and relies on the in-process
 *  stophook to call shutdown at stop, but the engine can be left ALIVE — either
 *  it HANGS instead of exiting (very large contexts) or a STALE stophook (pi
 *  extensions never reload) ignores intent='refresh' entirely and never calls
 *  shutdown. Either way: engine alive, turn over, intent pending forever. The
 *  daemon only revives DEAD engines, so without this verdict the node is
 *  permanently stuck (no revive, no wake). Pure core, mirroring livenessVerdict;
 *  the kill side effects live in handleYieldStall.
 *
 *  'kill' ONLY when ALL of: engine alive, intent='refresh', the turn is over
 *  (busy marker absent — a node may legitimately keep working for many minutes
 *  after running `node yield` mid-turn, and a working engine must never be
 *  killed), and the state has persisted past YIELD_STALL_GRACE_MS. */
export function yieldStallVerdict(
  piPidAlive: boolean | null,
  intent: NodeRow['intent'],
  busy: boolean,
  stalledFor: number | null,
): 'leave' | 'pending' | 'kill' {
  if (piPidAlive !== true) return 'leave';
  if (intent !== 'refresh') return 'leave';
  if (busy) return 'leave';
  if (stalledFor === null || stalledFor < YIELD_STALL_GRACE_MS) return 'pending';
  return 'kill';
}

/** Enact a refresh-stall (§H refresh-authority): clock the stalled state, then
 *  SIGTERM the hung engine (escalating to SIGKILL if it survives
 *  KILL_ESCALATE_MS — an engine hung at context overflow, or a stale hook that
 *  never wired shutdown, may never run its handlers, so a graceful frame can't be
 *  trusted; the signal escalation is what guarantees the engine actually dies).
 *  Once the engine is dead the ORDINARY machinery finishes the job: the dead-pid
 *  refresh branch in handleNodeLiveness revives with resume=false (intent is
 *  still 'refresh'), i.e. the fresh roadmap-revive the yield asked for. Safe
 *  against a graceful shutdown racing us: markCleanExitDone no-ops while intent
 *  is pending, so a dying engine can't mis-finalize the node. */
function handleYieldStall(row: NodeRow, pid: number, now: number): void {
  const id = row.node_id;
  if (row.intent !== 'refresh' || isBusy(id)) {
    yieldStallSince.delete(id);
    yieldTermAt.delete(id);
    return;
  }
  const since = yieldStallSince.get(id);
  if (since === undefined) {
    yieldStallSince.set(id, now);
    return;
  }
  if (yieldStallVerdict(true, row.intent, false, now - since) !== 'kill') return;
  const termed = yieldTermAt.get(id);
  if (termed === undefined) {
    process.stderr.write(
      `[crtrd] kill ${id} (yield-stall: pi ${pid} still alive ${Math.round((now - since) / 1000)}s after its refresh-yield turn ended — SIGTERM)\n`,
    );
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    yieldTermAt.set(id, now);
  } else if (now - termed >= KILL_ESCALATE_MS) {
    process.stderr.write(`[crtrd] kill ${id} (yield-stall: pi ${pid} survived SIGTERM — SIGKILL)\n`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export type LivenessVerdict = 'leave' | 'pending' | 'revive';

/** Decide what to do with a node whose engine pid is DEAD, from how long it's
 *  been dead. Pure — the time/revive side effects live in handleNodeLiveness;
 *  this is the unit-testable core. (piPidAlive carries dead/alive/unknown, but
 *  only `false` ever reaches a revive decision here — alive and null are routed
 *  upstream by handleNodeLiveness.)
 *    deadFor: ms since first observed dead, or null on the first observation. */
export function livenessVerdict(piPidAlive: boolean | null, deadFor: number | null): LivenessVerdict {
  if (piPidAlive !== false) return 'leave';
  if (deadFor === null || deadFor < REVIVE_GRACE_MS) return 'pending';
  return 'revive';
}

/** The ONE liveness path for EVERY node. Every node runs on a detached headless
 *  broker; a tmux pane is only a viewer and is never consulted here — liveness is
 *  the recorded engine pid (signal-0) alone. Reuses the existing supervision
 *  primitives, now universal: pid signal-0 + REVIVE_GRACE_MS grace +
 *  unhealthySince + revivedThisTick. A viewer window closing is NOT a node death.
 *  Cases:
 *    • pid alive → leave; clear any stale grace timer. THEN enforce a stuck
 *      refresh (§H): handleYieldStall self-guards (no-op unless intent='refresh'
 *      with the turn over) and, once the engine has sat alive past the grace,
 *      kills it — so the daemon, not the (possibly stale) in-process stophook, is
 *      the authority on refresh, and the dead-pid refresh branch below then
 *      revives it fresh.
 *    • pid null + pi_session_id set (a relaunch in flight — reviveNode clears
 *      pi_pid right after launch) → leave; the fresh engine re-records its pid.
 *    • pid null + pi_session_id null (NEVER booted) → normally the sub-second SDK
 *      boot gap, but a broker that throws BEFORE session_start records no pid and
 *      no session ever — so after a boot grace with STILL nothing, crash +
 *      surfaceBootFailure up the spine (M-1).
 *    • pid dead + intent==='refresh' → clean yield (or the §H force-kill above
 *      just landed): respawn FRESH immediately, no grace wait.
 *    • pid dead + intent==='idle-release' → dormant by choice; leave, the second
 *      pass revives (resume) on the next unseen inbox entry.
 *    • pid dead + any other intent (a crash) → grace-revive RESUME on the saved
 *      session (livenessVerdict → REVIVE_GRACE_MS → unhealthySince). */
async function handleNodeLiveness(
  row: NodeRow,
  now: number,
  revivedThisTick: Set<string>,
): Promise<void> {
  const id = row.node_id;
  const pid = row.pi_pid;

  // The engine is live → nothing pending; clear any boot/grace timer. THEN
  // enforce §H: handleYieldStall no-ops unless this node yielded (intent=refresh),
  // its turn is over, and the engine never exited — past the grace it kills the
  // engine so the dead-pid refresh branch below revives it fresh.
  if (pid != null && isPidAlive(pid)) {
    unhealthySince.delete(id);
    handleYieldStall(row, pid, now);
    return;
  }

  if (pid == null) {
    // No supervised pid recorded. Two very different cases turn on pi_session_id:
    //   • a relaunch in flight — reviveNode clears pi_pid right after launch, but
    //     the node ALREADY booted once (pi_session_id captured), so the fresh
    //     engine re-records its pid within a tick or two; leave it.
    //   • a NEVER-BOOTED broker (pi_session_id null) — normally the sub-second SDK
    //     boot gap, BUT a broker that THROWS before session_start (malformed
    //     broker-launch.json, SessionManager.open on a missing .jsonl, a loader/
    //     registry/createAgentSession failure, the fork / bare-id guards, or
    //     broker-cli's own fatal catch) records NO pid and NO session — EVER.
    //     With pid==null read unconditionally as "still booting" that strands the
    //     node 'active' with no engine forever and its parent waits on a dead
    //     child. After a boot grace with STILL no pid AND no session, crash +
    //     surfaceBootFailure up the spine (M-1).
    const meta = getNode(id);
    if (meta === null || meta.pi_session_id != null) {
      unhealthySince.delete(id); // relaunch in flight (or identity already bound)
      return;
    }
    const since = unhealthySince.get(id);
    if (since === undefined) {
      unhealthySince.set(id, now); // start the boot-grace clock
      return;
    }
    if (now - since < REVIVE_GRACE_MS) return; // still inside the boot grace
    // Boot grace elapsed, still no pid and no session → the broker never booted.
    unhealthySince.delete(id);
    process.stderr.write(`[crtrd] boot-failed ${id} (broker exited before session_start)\n`);
    transition(id, 'crash');
    try {
      await surfaceBootFailure(meta);
    } catch (err) {
      process.stderr.write(
        `[crtrd] surfaceBootFailure ${id} error: ${(err as Error).message}\n`,
      );
    }
    return;
  }

  // The engine pid is DEAD — any pending refresh-stall clock is moot (the dead-
  // pid paths below own recovery now). Branch on intent.
  yieldStallSince.delete(id);
  yieldTermAt.delete(id);

  if (row.intent === 'refresh') {
    // Clean yield — or the §H force-kill above just landed — → respawn FRESH,
    // immediately (no grace wait).
    process.stderr.write(`[crtrd] revive ${id} (refresh-yield)\n`);
    reviveNode(id, { resume: false });
    revivedThisTick.add(id); // third-pass bare double-spawn guard (Maj-4)
    return;
  }
  if (row.intent === 'idle-release') {
    // Freed itself while dormant → leave idle; the second pass revives it
    // (resume) the moment its inbox gains an unseen entry.
    unhealthySince.delete(id);
    return;
  }
  // Any other intent → a crash: grace-revive RESUME on the saved session.
  // reviveNode clears pi_pid until the fresh engine re-records it, so the next
  // tick won't re-fire on this stale pid.
  const since = unhealthySince.get(id);
  const verdict = livenessVerdict(false, since === undefined ? null : now - since);
  if (verdict === 'pending') {
    if (since === undefined) unhealthySince.set(id, now);
    return;
  }
  unhealthySince.delete(id);
  process.stderr.write(
    `[crtrd] revive ${id} (engine dead, intent=${String(row.intent)})\n`,
  );
  reviveNode(id, { resume: true });
  revivedThisTick.add(id); // third-pass bare double-spawn guard (Maj-4)
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

// How long a dead node's on-disk record must have been QUIET (no meta/telemetry
// write) before its leftover placement is reaped. A fresh crash keeps its pane
// around this long so a human can read the corpse; a long-dead node's orphaned
// pane is torn down on sight.
export const DEAD_REAP_GRACE_MS = 10 * 60_000;

/** ms since the node's durable record was last written (meta.json / job/
 *  telemetry.json mtimes — the files every live cycle touches). Infinity when
 *  neither exists: no disk evidence reads as ancient, not fresh. Deliberately
 *  NOT inbox.jsonl — children keep appending to a dead manager's inbox, which
 *  must not hold its corpse un-reapable forever. */
function msSinceDiskActivity(nodeId: string, now: number): number {
  let latest = 0;
  for (const p of [join(nodeDir(nodeId), 'meta.json'), join(jobDir(nodeId), 'telemetry.json')]) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* absent — contributes nothing */
    }
  }
  return latest === 0 ? Number.POSITIVE_INFINITY : now - latest;
}

/** Reap the leftover PLACEMENT of long-dead nodes (audit 2026-06-09, Bug 3 —
 *  node mq3l84it-40f6e8ac, a dead resident whose orphaned pane + focus row sat
 *  untouched for ~36h). The daemon supervises only active|idle rows, so a node
 *  that lands `dead` while still holding a pane is invisible to every pass and
 *  its residue leaks forever.
 *
 *  Deliberate REAP-not-REVIVE decision: a dead node is NOT auto-revived. `dead`
 *  means crashed — auto-resurrecting a crashed RESIDENT (a human conversation)
 *  would pop dead chats back open unbidden, and the daemon's contract is to
 *  supervise live nodes, not to undo terminal states. A dead resident's wake
 *  sources remain the human ones (`node msg --tier critical`, focus, `canvas
 *  revive`), all of which still work after this reap. What we DO reclaim is the
 *  physical residue: kill the orphaned pane, drop the focus row, null the
 *  LOCATION (tearDownNode). The node row, its edges, and all on-disk state stay
 *  intact, so a later manual revive keeps its full graph — the leak was the
 *  pane/focus/presence, not the row. Grace: only after DEAD_REAP_GRACE_MS of
 *  disk quiet, so a just-crashed pane survives long enough to be inspected. */
function reapDeadResidue(now: number): void {
  let rows: NodeRow[];
  try {
    rows = listNodes({ status: ['dead'] });
  } catch (err) {
    process.stderr.write(`[crtrd] reapDeadResidue list error: ${(err as Error).message}\n`);
    return;
  }
  for (const row of rows) {
    try {
      if (row.pane == null && row.window == null && row.tmux_session == null) continue;
      if (msSinceDiskActivity(row.node_id, now) < DEAD_REAP_GRACE_MS) continue;
      process.stderr.write(
        `[crtrd] reap ${row.node_id} (dead, placement leaked: pane=${String(row.pane)} window=${String(row.window)})\n`,
      );
      tearDownNode(row.node_id);
    } catch (err) {
      process.stderr.write(
        `[crtrd] error reaping ${row.node_id}: ${(err as Error).message}\n`,
      );
    }
  }
}

/** GC stale focus rows (audit 2026-06-09, Bug 5): nothing else deletes a focuses
 *  row when its pane dies outside the sanctioned teardown paths (a user
 *  kill-pane, a tmux server restart, a crashed swap), so dead-pane rows
 *  accumulate forever — the audit found 15 of 21 rows pointing at gone panes,
 *  and a stale row both lies to graphSurfaceTarget and blocks its node from
 *  being adopted into a fresh viewport (UNIQUE node_id). Sweep them here: one
 *  batched `list-panes -a` probe (never a per-row display-message), deleting
 *  rows whose recorded pane no longer exists. A pane-less row (a bridge/unplaced
 *  viewport) has nothing to verify and is left alone. On a FAILED probe (tmux
 *  unreachable — daemon racing a server restart) we skip the sweep entirely:
 *  "can't tell" must never mass-delete every viewport. */
function gcStaleFocuses(): void {
  try {
    const rows = listFocuses();
    if (rows.length === 0) return;
    const live = listLivePanes();
    if (live === null) return; // probe failed — never GC on "can't tell"
    for (const f of rows) {
      if (f.pane === null || live.has(f.pane)) continue;
      process.stderr.write(
        `[crtrd] gc focus ${f.focus_id} (pane ${f.pane} gone, occupant ${f.node_id})\n`,
      );
      closeFocusRow(f.focus_id);
    }
  } catch (err) {
    process.stderr.write(`[crtrd] gcStaleFocuses error: ${(err as Error).message}\n`);
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

// isPidAlive now lives in canvas/pid.ts (the one shared signal-0 probe at the
// lowest layer, so canvas/, runtime/, AND daemon/ all import it down). Re-
// exported here to preserve the public surface consumed by commands/daemon.ts
// and the grace-clock test.
export { isPidAlive };

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
      // Every node is broker-hosted (host_kind always 'broker'; pane/window/
      // tmux_session always NULL) and supervised by its engine pid alone. A tmux
      // pane, if any, is just a viewer — the daemon never consults it and a viewer
      // closing is not a node death. There is no inline-root carve-out and no
      // pane-gone reaping: one liveness path for all.
      await handleNodeLiveness(row, now, revivedThisTick);
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
      // no meta needed — status/intent live in the row.
      const r = getRow(row.node_id);
      if (r === null) continue;
      if (r.status !== 'idle' || r.intent !== 'idle-release') continue;
      // The in-process inbox-watcher only owns delivery while the engine is LIVE.
      // A released node's broker is DEAD (it freed itself while dormant), so it
      // has no watcher and the daemon must wake it. Gate the skip on engine
      // liveness alone — viewer panes are irrelevant here.
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

  // Fourth pass: reap the leftover placement of long-dead nodes (Bug 3), then
  // sweep focus rows whose pane died outside the sanctioned teardown paths
  // (Bug 5). Reap first so the GC also catches any focus row a reaped pane
  // strands; last overall so neither races a focus a same-tick revive just
  // re-anchored.
  reapDeadResidue(now);
  gcStaleFocuses();
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
