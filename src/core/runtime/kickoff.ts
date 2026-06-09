// The revive kickoff — the message auto-injected as a node's first turn when it
// comes back FRESH (a refresh-yield, or `canvas revive --fresh`). The node's
// in-memory context is gone, so this message IS its bearings: everything is
// read from disk and framed so the node can rebuild and continue without a
// round-trip. Resuming a saved conversation needs none of this (the
// conversation already holds the context).
//
// Layout (the framing a revived node sees):
//   <roadmap file=…>…</roadmap>            its evolving plan — the source of truth
//   <context-dir path=…>…</context-dir>    what artifacts exist on disk
//   <feed>Awaiting N nodes … digest</feed> who it waits on + unread reports
//   <yield-message>…</yield-message>       the note its prior self left on yield
//
// The roadmap (NOT the original spawn prompt) carries the goal on a refresh: its
// frozen core holds goal + exit criteria, its body the live plan. context/
// initial-prompt.md is NEVER injected into a node's prompts — it lives on disk
// purely as a log of the original mandate; by the time a node is running it is
// usually stale, and the roadmap is the doc the node keeps current. The
// yield-message is one-shot (consumed on the next revive).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  contextDir,
  reportsDir,
  getNode,
  subscriptionsOf,
  subscribersOf,
  type NodeMeta,
} from '../canvas/index.js';
import { readRoadmap, roadmapPath } from './roadmap.js';
import { buildWakeBearings, type WakeOrigin } from './bearings.js';
import { personaDrift, commitPersonaAck } from './persona.js';
import {
  readInboxSince,
  readCursor,
  writeCursor,
  coalesce,
} from '../feed/inbox.js';

// ---------------------------------------------------------------------------
// Companion context files: the goal (the spawning mandate) and the one-shot
// yield message (a note from the prior self to the revived self).
// ---------------------------------------------------------------------------

/** The goal file — the prompt/task a node was spawned with, persisted at birth
 *  so a fresh revive can re-read its mandate. */
export function goalPath(nodeId: string): string {
  return join(contextDir(nodeId), 'initial-prompt.md');
}

export function readGoal(nodeId: string): string | null {
  const p = goalPath(nodeId);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Persist the spawning prompt as the node's goal. No-op for an empty prompt
 *  (e.g. a bare root). Idempotent enough — call once at spawn/boot. */
export function writeGoal(nodeId: string, text: string): void {
  const body = text.trim();
  if (body === '') return;
  mkdirSync(contextDir(nodeId), { recursive: true });
  writeFileSync(goalPath(nodeId), body + '\n', 'utf8');
}

/** Write the goal ONLY if the node has none yet. This is how a bare root (no
 *  spawn prompt) acquires its mandate: the first real user message becomes the
 *  goal. Returns true when it wrote one, false when a goal already existed or
 *  the text was empty. Guarded so a later message never clobbers the mandate. */
export function captureGoalIfAbsent(nodeId: string, text: string): boolean {
  const existing = readGoal(nodeId);
  if (existing !== null && existing.trim() !== '') return false;
  const body = text.trim();
  if (body === '') return false;
  writeGoal(nodeId, body);
  return true;
}

/** Sentinel opening the fresh-revive kickoff message (see buildReviveKickoff).
 *  The goal-capture extension skips any input starting with this so a kickoff
 *  prompt is never mistaken for a user's first mandate. */
export const REVIVE_KICKOFF_SENTINEL = 'You have been revived fresh after a context refresh';

/** The yield-message file — a short note `crtr node yield` records for the next
 *  revive ("on wake, do X"). Consumed (deleted) when the revive reads it. */
export function yieldMessagePath(nodeId: string): string {
  return join(contextDir(nodeId), 'yield-message.md');
}

export function writeYieldMessage(nodeId: string, text: string): void {
  const body = text.trim();
  if (body === '') return;
  mkdirSync(contextDir(nodeId), { recursive: true });
  writeFileSync(yieldMessagePath(nodeId), body + '\n', 'utf8');
}

/** Read AND delete the yield message — it is a one-shot handoff to the next
 *  revive, so a later crash-revive never resurfaces a stale note. */
export function consumeYieldMessage(nodeId: string): string | null {
  const p = yieldMessagePath(nodeId);
  if (!existsSync(p)) return null;
  const body = readFileSync(p, 'utf8');
  try { rmSync(p); } catch { /* best-effort */ }
  return body.trim() !== '' ? body : null;
}

/** List the node's context/ dir (filenames, sorted). Empty when absent. */
export function listContextDir(nodeId: string): string[] {
  const dir = contextDir(nodeId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

// ---------------------------------------------------------------------------
// Revive bearings — the CONSUMING half of a fresh revive.
//
// A fresh revive surfaces three one-shot things that are "read" by being shown:
// the yield note (deleted on read), the unread feed (the cursor advances past
// it), and any external persona drift (its ack is committed). Draining them is a
// STATE MUTATION, kept OUT of buildReviveKickoff so that stays a PURE string
// assembler. The revive paths call drainBearings ONCE, then hand the result to
// buildReviveKickoff.
// ---------------------------------------------------------------------------

export interface ReviveBearings {
  /** The one-shot yield note left by the prior self (already consumed/deleted). */
  yieldMsg: string | null;
  /** Coalesced digest of unread reports, or null when the feed was empty. The
   *  cursor has already been advanced past these. */
  unreadDigest: string | null;
  /** Persona-transition guidance to surface when the node's role was changed
   *  while it was away (its ack has already been committed), else null. */
  driftGuidance: string | null;
}

/** Drain the one-shot revive bearings for `meta`: consume the yield note, advance
 *  the feed cursor past the unread reports, and capture+commit any external
 *  persona drift. The CONSUMING step of a fresh revive — the revive paths call it
 *  ONCE, then pass the result to buildReviveKickoff (which is then pure; building
 *  twice eats nothing). Calling drainBearings a second time would drain an
 *  already-empty note/feed, so ONLY the revive paths call it. */
export function drainBearings(meta: NodeMeta): ReviveBearings {
  const nodeId = meta.node_id;

  // Consume the one-shot yield note (deleted on read) BEFORE the kickoff lists
  // the context dir, so it never shows up there.
  const yieldMsg = consumeYieldMessage(nodeId);

  // Drain the feed: read unread since the cursor and advance it past them, so a
  // later `crtr feed read` shows only what arrives afterward.
  const cursor = readCursor(nodeId);
  const entries = readInboxSince(nodeId, cursor);
  let unreadDigest: string | null = null;
  if (entries.length > 0) {
    writeCursor(nodeId, entries[entries.length - 1]!.ts);
    unreadDigest = coalesce(entries);
  }

  // Capture + commit any external persona drift (the second of the two delivery
  // sites). Committing the ack here is the mutation; the guidance is surfaced by
  // the pure builder from this captured value.
  const drift = personaDrift(nodeId);
  let driftGuidance: string | null = null;
  if (drift !== null) {
    driftGuidance = drift.guidance;
    commitPersonaAck(nodeId, drift.to);
  }

  return { yieldMsg, unreadDigest, driftGuidance };
}

// Fresh-revive catch-up bug: on a refresh-yield (resume:false) the old
// conversation is gone AND the monotonic inbox cursor has already advanced past
// everything drained pre-yield, so the revived node loses sight of reports its
// subscriptions pushed BEFORE the yield. The bodies are never lost — they persist
// at reports/<ts>-<kind>.md forever — but nothing pointed the revived node at
// them. reportHistoryLines renders those existing on-disk paths so it can catch
// up; PATHS ONLY (the node dereferences what it needs), no body read, no parse.
const REPORT_HISTORY_PER_SOURCE = 5;
const REPORT_HISTORY_TOTAL_CAP = 20;

/** Collapse the home-dir prefix of an absolute path to a leading `~`, so report
 *  paths render as `~/.crouter/canvas/nodes/<id>/reports/<ts>.md` instead of
 *  repeating the long absolute home prefix on every catch-up line — cheaper
 *  context, still dereferenceable by the revived node. A path NOT under the home
 *  dir (e.g. a CRTR_HOME / project-scope home elsewhere) is returned unchanged,
 *  so we never mangle a non-home path. */
function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Recent report file PATHS (most-recent-first), grouped by publisher, for each
 *  ACTIVE subscription of `nodeId` — independent of publisher liveness, so a
 *  finished worker's history still surfaces for catch-up. Skips subscriptions
 *  whose reports dir is empty/missing. Returns [] when the node has no active
 *  subscriptions or none have reports yet (caller renders nothing extra). */
function reportHistoryLines(nodeId: string): string[] {
  const lines: string[] = [];
  let total = 0;
  for (const sub of subscriptionsOf(nodeId).filter((s) => s.active)) {
    if (total >= REPORT_HISTORY_TOTAL_CAP) break;
    const dir = reportsDir(sub.node_id);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort() // YYYYMMDDTHHmmss-<kind>.md — lexical sort = chronological
      .reverse() // most recent first
      .slice(0, REPORT_HISTORY_PER_SOURCE);
    if (files.length === 0) continue;
    const pub = getNode(sub.node_id);
    lines.push(`  ${pub !== null ? `${pub.name} (${sub.node_id})` : sub.node_id}:`);
    for (const f of files) {
      if (total >= REPORT_HISTORY_TOTAL_CAP) break;
      lines.push(`    ${tildify(join(dir, f))}`);
      total++;
    }
  }
  return lines;
}

/** Render the <feed> block PURELY: the live "awaiting" roster (a read), the
 *  already-drained unread digest (from drainBearings), and the on-disk report
 *  history of this node's subscriptions (catch-up pointers). No cursor write. */
function feedBlock(nodeId: string, unreadDigest: string | null): string {
  // Awaiting = active subscriptions whose publisher is still live (active|idle).
  const awaiting = subscriptionsOf(nodeId)
    .filter((s) => s.active)
    .map((s) => getNode(s.node_id))
    .filter((m): m is NodeMeta => m !== null && (m.status === 'active' || m.status === 'idle'));

  const lines: string[] = [];
  if (awaiting.length > 0) {
    const n = awaiting.length;
    const subj = n === 1 ? 'it is' : 'they are';
    const pron = n === 1 ? 'it' : 'they';
    const verb = n === 1 ? 'pushes' : 'push';
    // State aliveness + the automatic wake at the source. Bare status ("— active")
    // left earlier revives unsure whether the worker was really live, so they
    // burned a turn on `feed read`/`feed peek` to confirm. Asserting it here
    // removes the reason to check.
    lines.push(
      `Awaiting ${n} node${n === 1 ? '' : 's'} — ${subj} alive and running right now, and will wake you the moment ${pron} ${verb}. The wake is automatic; nothing to check, poll, or verify.`,
    );
    for (const m of awaiting) lines.push(`  - ${m.name} (${m.node_id}) — ${m.status}`);
    lines.push(
      '',
      unreadDigest ??
        '(no unread reports yet — expected while they run: a worker leaves no pointer until it pushes, so an empty feed means still working, not stalled)',
    );
  } else {
    lines.push('Awaiting 0 nodes.');
    lines.push('', unreadDigest ?? '(no unread reports)');
  }

  // Catch-up history. The unread digest above only covers what arrived since the
  // cursor; on a refresh-revive the cursor has already passed everything drained
  // pre-yield, so point the node at the durable report history that persists on
  // disk. Renders nothing when the node has no active subscriptions with reports.
  const history = reportHistoryLines(nodeId);
  if (history.length > 0) {
    lines.push(
      '',
      'Report history on disk — the nodes you subscribe to keep every push they made; ' +
        'these persist across your context refresh (the unread digest above only covers ' +
        'what arrived since your cursor). Most recent first; dereference any you need. ' +
        '`crtr feed read --all` replays the full inbox history, cursor-independent.',
      ...history,
    );
  }

  return `<feed>\n${lines.join('\n')}\n</feed>`;
}

// ---------------------------------------------------------------------------
// buildReviveKickoff — assemble the full fresh-revive first message.
// ---------------------------------------------------------------------------

/** Assemble the auto-injected first message for a FRESH revive of `meta` from its
 *  already-drained `bearings` (see drainBearings) plus pure on-disk reads of the
 *  node's goal, roadmap, and context dir, framed so the revived node can rebuild
 *  its bearings in one turn. PURE: no state mutation, so calling it twice yields
 *  the same string and consumes nothing — drainBearings owns the one-shot reads. */
export function buildReviveKickoff(
  meta: NodeMeta,
  bearings: ReviveBearings,
  wakeReason?: WakeOrigin,
): string {
  const nodeId = meta.node_id;

  const parts: string[] = [
    `${REVIVE_KICKOFF_SENTINEL} — your previous in-memory ` +
      'context is gone, by design. Everything below was just read from disk; it is your ' +
      'full bearings. Rebuild from it and continue toward your goal.',
  ];

  // Wake provenance (Invariant B/D): when a scheduled bare self-alarm fired this
  // revive, the <crtr-wake> block reframes the generic "you were revived" above
  // into "a TIMER woke you" — placed right after the sentinel (so the kickoff
  // still STARTS with REVIVE_KICKOFF_SENTINEL, which goal-capture keys on) and
  // before the roadmap/disk bearings, so "why you woke" precedes "what to rebuild
  // from". Only the daemon's bare-wake branch passes wakeReason.
  if (wakeReason !== undefined) parts.push(buildWakeBearings(wakeReason));

  // The roadmap is the source of truth on a fresh revive: its frozen core holds
  // the goal/exit criteria, its body the live plan the node kept current. The
  // original spawn prompt (context/initial-prompt.md) is deliberately NOT injected
  // — it lives on disk only as a log, and by now it is usually stale.
  const roadmap = readRoadmap(nodeId);
  const hasRoadmapBody = roadmap !== null && roadmap.trim() !== '';
  parts.push(
    `<roadmap file="${roadmapPath(nodeId)}">\n${
      hasRoadmapBody ? roadmap.trim() : '(no roadmap on disk yet)'
    }\n</roadmap>`,
  );

  // With NO roadmap the kickoff above carries no mandate at all, and an
  // amnesiac fresh boot just stops (and is auto-finalized by the stop-guard) —
  // observed when the daemon relaunches a spawned-but-never-launched node
  // (audit 2026-06-09, Bug 4: mq45b6ch-9ecc2f03), whose only mandate on disk IS
  // the goal. Surface the goal then. When a roadmap exists it stays the sole
  // source of truth (the goal is usually stale by comparison) — unchanged.
  if (!hasRoadmapBody) {
    const goal = readGoal(nodeId);
    if (goal !== null && goal.trim() !== '') {
      parts.push(`<goal file="${goalPath(nodeId)}">\n${goal.trim()}\n</goal>`);
    }
  }

  const files = listContextDir(nodeId);
  parts.push(
    `<context-dir path="${contextDir(nodeId)}">\n${files.length > 0 ? files.join('\n') : '(empty)'}\n</context-dir>`,
  );

  parts.push(feedBlock(nodeId, bearings.unreadDigest));

  parts.push(
    bearings.yieldMsg !== null
      ? `<yield-message>\n${bearings.yieldMsg.trim()}\n</yield-message>`
      : '<yield-message/>',
  );

  // A node that reports UP the spine (has subscribers awaiting its result)
  // finishes with `push final`. A human-attended node (no subscribers — a root
  // conversation working directly with the user) has no result to submit and
  // must not be told to finish: it stays resident and keeps working with the
  // user.
  const reportsUp = subscribersOf(nodeId).length > 0;
  parts.push(
    reportsUp
      ? 'If there is work to do, perform it. Otherwise stop — `crtr push final "<result>"` ' +
          'if the goal is met, or end your turn to stay dormant awaiting your workers.'
      : 'If there is work to do, perform it. Otherwise end your turn — you are working ' +
          'directly with the user, so stay available and continue the conversation when they ' +
          'write back.',
  );

  // Persona-transition catch-up. If the node's mode/lifecycle was changed
  // EXTERNALLY while it was dormant (e.g. a human ran `crtr node lifecycle` /
  // `node promote --node` on it), it never saw the turn_end injector. drainBearings
  // captured the guidance for its new persona and committed the ack (the second
  // and only other delivery site); we just surface it. A clean fresh revive has
  // no drift, so this is empty unless a real external change happened.
  if (bearings.driftGuidance !== null) {
    parts.push(
      `<persona-transition>\nYour role was changed while you were away. ${bearings.driftGuidance}\n</persona-transition>`,
    );
  }

  return parts.join('\n\n');
}
