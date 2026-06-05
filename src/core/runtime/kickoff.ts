// The revive kickoff — the message auto-injected as a node's first turn when it
// comes back FRESH (a refresh-yield, or `canvas revive --fresh`). The node's
// in-memory context is gone, so this message IS its bearings: everything is
// read from disk and framed so the node can rebuild and continue without a
// round-trip. Resuming a saved conversation needs none of this (the
// conversation already holds the context).
//
// Layout (the framing a revived node sees):
//   <goal file=…>…</goal>                  the mandate it was spawned with
//   <roadmap file=…>…</roadmap>            its evolving plan
//   <context-dir path=…>…</context-dir>    what artifacts exist on disk
//   <feed>Awaiting N nodes … digest</feed> who it waits on + unread reports
//   <yield-message>…</yield-message>       the note its prior self left on yield
//
// The goal + yield-message are companion files in the node's context dir; the
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
import {
  contextDir,
  getNode,
  subscriptionsOf,
  subscribersOf,
  type NodeMeta,
} from '../canvas/index.js';
import { readRoadmap, roadmapPath } from './roadmap.js';
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
// Feed block — who the node is awaiting, plus a drained digest of unread
// reports. Draining here advances the cursor: the revived node has now "read"
// the feed, so a later `crtr feed read` shows only what arrives afterward.
// ---------------------------------------------------------------------------

function feedBlock(nodeId: string): string {
  // Awaiting = active subscriptions whose publisher is still live (active|idle).
  const awaiting = subscriptionsOf(nodeId)
    .filter((s) => s.active)
    .map((s) => getNode(s.node_id))
    .filter((m): m is NodeMeta => m !== null && (m.status === 'active' || m.status === 'idle'));

  const lines: string[] = [];
  lines.push(`Awaiting ${awaiting.length} node${awaiting.length === 1 ? '' : 's'}.`);
  for (const m of awaiting) lines.push(`  - ${m.name} (${m.node_id}) — ${m.status}`);

  const cursor = readCursor(nodeId);
  const entries = readInboxSince(nodeId, cursor);
  if (entries.length > 0) {
    writeCursor(nodeId, entries[entries.length - 1]!.ts);
    lines.push('', coalesce(entries));
  } else {
    lines.push('', '(no unread reports)');
  }

  return `<feed>\n${lines.join('\n')}\n</feed>`;
}

// ---------------------------------------------------------------------------
// buildReviveKickoff — assemble the full fresh-revive first message.
// ---------------------------------------------------------------------------

/** Build the auto-injected first message for a FRESH revive of `meta`. Reads
 *  the node's goal, roadmap, context dir, feed, and one-shot yield message off
 *  disk and frames them so the revived node can rebuild its bearings in one
 *  turn. Side effects: consumes the yield message and advances the feed cursor
 *  (both are "read" by surfacing them here). */
export function buildReviveKickoff(meta: NodeMeta): string {
  const nodeId = meta.node_id;

  // Consume the one-shot yield note first so it never shows in the dir listing.
  const yieldMsg = consumeYieldMessage(nodeId);

  const parts: string[] = [
    `${REVIVE_KICKOFF_SENTINEL} — your previous in-memory ` +
      'context is gone, by design. Everything below was just read from disk; it is your ' +
      'full bearings. Rebuild from it and continue toward your goal.',
  ];

  const goal = readGoal(nodeId);
  if (goal !== null && goal.trim() !== '') {
    parts.push(`<goal file="${goalPath(nodeId)}">\n${goal.trim()}\n</goal>`);
  }

  const roadmap = readRoadmap(nodeId);
  parts.push(
    `<roadmap file="${roadmapPath(nodeId)}">\n${
      roadmap !== null && roadmap.trim() !== '' ? roadmap.trim() : '(no roadmap on disk yet)'
    }\n</roadmap>`,
  );

  const files = listContextDir(nodeId);
  parts.push(
    `<context-dir path="${contextDir(nodeId)}">\n${files.length > 0 ? files.join('\n') : '(empty)'}\n</context-dir>`,
  );

  parts.push(feedBlock(nodeId));

  parts.push(
    yieldMsg !== null
      ? `<yield-message>\n${yieldMsg.trim()}\n</yield-message>`
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
  // `node promote --node` on it), it never saw the turn_end injector. Surface
  // the guidance for its new persona here and commit the ack — the second (and
  // only other) delivery site. Idempotent: a clean fresh revive already has its
  // ack committed, so this fires only on a real external change.
  const drift = personaDrift(nodeId);
  if (drift !== null) {
    parts.push(
      `<persona-transition>\nYour role was changed while you were away. ${drift.guidance}\n</persona-transition>`,
    );
    commitPersonaAck(nodeId, drift.to);
  }

  return parts.join('\n\n');
}
