// bearings.ts — the boot-intro prose (the <crtr-identity> assertion + the
// <crtr-context> framing), shared by the paths that deliver it so they can
// never drift:
//
//   • the context-intro pi-extension injects buildContextBearings() as the
//     node's first session message in every brand-new chat. It opens with a
//     <crtr-identity> block (buildIdentityAssertion) that names the node (id,
//     kind, mode), draws a mini-map of its place in the graph (ancestry trunk
//     up + immediate children with statuses, via buildGraphMap), and,
//     ONLY for a fork, disowns the source's copied first-person narrative as
//     inherited context — the fix for the `--fork-from` bug where a fork copies
//     the source's whole conversation and then impersonates it. A non-fork
//     node's bearings are its FIRST entry, so there is nothing earlier to
//     disown; it gets only the declarative identity line;
//   • promote.ts folds orchestratorContextNote() into the promotion guidance
//     dump, so a node that becomes an orchestrator MID-LIFE gets the
//     orchestrator framing it never received at spawn — it spawned as a base
//     worker, and the bearings already in its history carry only the base note.
//
// Base framing (every node): the context dir is durable, shared scratch — the
// one place other nodes on the canvas can read from, so it is for documents
// worth a shared reference, NOT a task tracker, and NOT a "future memory-wiped
// you" stash (a terminal worker has no future cycle — that framing only makes
// sense once a node is a resident orchestrator). The `<knowledge>` block
// (substrate knowledge docs + node-local docs) rides into the context message.
//
// Orchestrator addendum (gated on orchestrator MODE): the dir ALSO survives
// refresh cycles, so it is where a future cycle of the orchestrator resumes.
// This across-cycles note is the ONE thing a terminal worker's bearings drop.

import {
  contextDir,
  getNode,
  fullName,
  subscriptionsOf,
  type NodeMeta,
  type NodeStatus,
  type WakeKind,
  type Wakeup,
} from '../canvas/index.js';
import { cadenceDisplay } from '../wake.js';
import { renderKnowledgeBlock } from '../substrate/index.js';

/** Base framing — present for every node. No path baked in: the caller carries
 *  the dir in the `<crtr-context dir="…">` attribute. */
export const BASE_CONTEXT_NOTE =
  'This is your context directory — durable scratch space on disk, and the one place the other ' +
  'nodes on the canvas can read from. Put documents here that you want to share by reference ' +
  'instead of re-explaining them in a prompt: specs, designs, findings, notes worth pointing a ' +
  'sibling, child, or parent at. It is a shared document store, not a task tracker.';

/** Orchestrator-only framing: a resident orchestrator survives refresh cycles,
 *  so its context dir is also where a future cycle of itself resumes the work.
 *  Used inside the bearings block AND in the promotion guidance dump, so a
 *  promoted node gets the same note a born-orchestrator gets. */
export function orchestratorContextNote(nodeId: string): string {
  return (
    `Because you persist across refresh cycles, your context directory (${contextDir(nodeId)}) is ` +
    `also where a future cycle of you resumes the work — keep the working notes and decisions a ` +
    `refreshed you would need there, alongside the docs you share with the nodes you spawn.`
  );
}

// ---------------------------------------------------------------------------
// Graph mini-map — the node's place in the canvas, rendered into the identity
// block so a node boots oriented: who is above it (its ancestry trunk, root
// first) and who is directly below it (its immediate children + their statuses).
// Not the full subtree — just the load-bearing spine up and one level down.
// ---------------------------------------------------------------------------

/** Live-first sibling ordering, so running children surface above finished ones. */
function statusRank(status: NodeStatus | undefined): number {
  switch (status) {
    case 'active':   return 0;
    case 'idle':     return 1;
    case 'done':     return 2;
    case 'canceled': return 3;
    case 'dead':     return 4;
    default:         return 5;
  }
}

/** One relative's line in the map: `<id> — <kind> · <status>`, plus the node's
 *  task description when it carries one (orientation: what that relative is for). */
function relativeLabel(meta: NodeMeta): string {
  const desc = fullName(meta);
  const descPart = desc !== '' && desc !== meta.kind && desc !== meta.name ? ` — ${desc}` : '';
  return `${meta.node_id} (${meta.kind} · ${meta.status})${descPart}`;
}

/** Ancestry trunk from the root DOWN to (but excluding) `nodeId`, climbing the
 *  spine `parent` edge. Cycle-guarded. Root first. */
function ancestorTrunk(nodeId: string): NodeMeta[] {
  const trunk: NodeMeta[] = [];
  const seen = new Set<string>([nodeId]);
  let cur = getNode(nodeId)?.parent ?? null;
  while (cur !== null && cur !== '' && !seen.has(cur)) {
    seen.add(cur);
    const m = getNode(cur);
    if (m === null) break;
    trunk.unshift(m);
    cur = m.parent ?? null;
  }
  return trunk;
}

/** The node's immediate children — the nodes it subscribes to (its reports) —
 *  with human-ask control-plane nodes dropped, sorted live-first. */
function childNodes(nodeId: string): NodeMeta[] {
  return subscriptionsOf(nodeId)
    .map((s) => getNode(s.node_id))
    .filter((m): m is NodeMeta => m !== null && m.kind !== 'human')
    .sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

/** The graph mini-map: the ancestry trunk (root first), then this node marked
 *  `● you`, then its immediate children. Returns '' for a lone root with no
 *  children (nothing to map). Exported for testing. */
export function buildGraphMap(nodeId: string): string {
  const meta = getNode(nodeId);
  if (meta === null) return '';
  const trunk = ancestorTrunk(nodeId);
  const children = childNodes(nodeId);
  if (trunk.length === 0 && children.length === 0) return '';

  const indent = (depth: number): string => '  '.repeat(depth);
  const lines: string[] = [
    'Your place in the canvas graph (ancestry above you, your direct children below):',
  ];
  trunk.forEach((m, i) => {
    lines.push(`${indent(i)}${i === 0 ? '' : '└ '}${relativeLabel(m)}`);
  });
  const selfDepth = trunk.length;
  lines.push(`${indent(selfDepth)}${selfDepth === 0 ? '' : '└ '}● you: ${nodeId} (${meta.kind}, ${meta.mode})`);
  children.forEach((m, i) => {
    const conn = i === children.length - 1 ? '└ ' : '├ ';
    lines.push(`${indent(selfDepth + 1)}${conn}${relativeLabel(m)}`);
  });
  return lines.join('\n');
}

/** The IDENTITY assertion that opens every boot intro — the load-bearing fix
 *  for the `--fork-from` impersonation bug. A fork copies the SOURCE node's
 *  entire first-person conversation into its own session, so without an explicit
 *  re-assertion the forked agent reads that copied narrative as its own and
 *  impersonates the source (it kept "monitoring itself" as a phantom child).
 *  This block names the node unambiguously. ONLY when the node IS a fork does it
 *  additionally name the source AND disown the copied first-person narrative as
 *  inherited reference material — a non-fork node's bearings are its first session
 *  entry, so there is no earlier narrative to disown (emitting a disown line there
 *  is dead weight that reads as a contradiction with no referent). Always the FIRST
 *  thing the node reads. Exported for testing. */
export function buildIdentityAssertion(nodeId: string): string {
  const meta = getNode(nodeId);
  const kind = meta?.kind ?? 'general';
  const mode = meta?.mode ?? 'base';
  const lines = [
    '<crtr-identity>',
    `You are node ${nodeId} — kind ${kind}, mode ${mode}.`,
  ];
  const forkFrom = meta?.fork_from;
  if (forkFrom !== undefined && forkFrom !== null && forkFrom !== '') {
    // Name the source: a known node id gets its human label; a raw path/uuid
    // passes through as-is.
    const src = getNode(forkFrom);
    const sourceLabel = src !== null ? `${forkFrom} ("${fullName(src)}")` : forkFrom;
    lines.push(
      `You are a FORK of ${sourceLabel}: at spawn pi COPIED that node's conversation into your ` +
        `session as a starting point. You are NOT ${sourceLabel}. Everything earlier in this ` +
        'conversation is THEIR first-person history — inherited reference material, not your own ' +
        'past. Do not speak or act as them, do not continue their task as if it were yours, and do ' +
        'not "monitor yourself" as though you were a child they spawned.',
    );
  }
  const map = buildGraphMap(nodeId);
  if (map !== '') lines.push('', map);
  lines.push('</crtr-identity>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Wake provenance — the <crtr-wake> block (Invariant B/C/D: a node woken or
// born by a TIMER learns, by construction, that a clock — not an event — caused
// it, what kind of wake, who armed it + when, and (if recurring) the cadence.
// Delivered at two seams: prepended to a born node's kickoff (spawn/spawn-cron,
// in spawn.ts) and to a bare self-alarm's fresh-revive kickoff (buildReviveKickoff).
// noted/deadline self-mark at the message seam (the inbox label), not here.
// ---------------------------------------------------------------------------

/** Why a node woke or was born, as carried from the fired wakeup row to the
 *  injection seam. `ownerName` is the armer's resolved display name when it
 *  still exists (a reaped cron's armer renders as a bare id, never crashes). */
export interface WakeOrigin {
  /** The firing kind. The <crtr-wake> block is rendered for 'spawn' (birth) and
   *  'bare' (revive); 'noted'/'deadline' self-mark at the message seam instead. */
  kind: WakeKind;
  /** The armer node id (wakeups.owner_id), or null if somehow absent. */
  ownerId: string | null;
  /** The armer's display name, resolved if it still exists. */
  ownerName?: string;
  /** wakeups.created — when the wake was armed (ISO). */
  armedAt: string;
  /** wakeups.recur JSON when recurring, else null/undefined for a one-shot. */
  recur?: string | null;
}

/** Build a WakeOrigin from a fired wakeup row, resolving the armer's display
 *  name if the node still exists. The daemon calls this at fire time for the
 *  bare-revive and spawn-birth seams. */
export function wakeOriginFrom(w: Wakeup): WakeOrigin {
  const owner = w.owner_id != null ? getNode(w.owner_id) : null;
  return {
    kind: w.kind,
    ownerId: w.owner_id ?? null,
    ownerName: owner !== null ? fullName(owner) : undefined,
    armedAt: w.created,
    recur: w.recur,
  };
}

/** The armer rendered for prose, ROLE-explicit so a newborn never mistakes the
 *  id for its own: `node <id> ("<name>")` when the name resolved, `node <id>
 *  (now gone)` when the armer was reaped, `an unknown node` only if the owner id
 *  is somehow absent (owner_id is NOT NULL on every real row — defensive). */
function armerPhrase(origin: WakeOrigin): string {
  if (origin.ownerId === null || origin.ownerId === '') return 'an unknown node';
  if (origin.ownerName !== undefined) return `node ${origin.ownerId} ("${origin.ownerName}")`;
  return `node ${origin.ownerId} (now gone)`;
}

/** The <crtr-wake> provenance block — load-bearing agent-facing prose read by
 *  every wake-born or wake-woken node. Decision-first: it leads with the fact a
 *  TIMER (not a message/event) caused this turn, names the wake kind, surfaces
 *  the cadence for a recurrence (so the agent knows it is one run of a standing
 *  job, not a one-off), and ends with the directive. The spawn (birth) variant
 *  names the ARMER explicitly ("armed by node X") so the newborn never reads that
 *  id as its own; the bare (revive) variant drops armer attribution entirely — a
 *  bare wake can be armed for a node by ANOTHER (`--node`), and who armed it is
 *  not decision-relevant to a timed re-check. No timestamp is rendered ("to fire
 *  now" / the cadence already carry the signal; a raw ISO instant is noise an
 *  agent cannot cheaply turn into an elapsed delta). Rendered for 'spawn' and
 *  'bare'; other kinds self-mark elsewhere. */
export function buildWakeBearings(origin: WakeOrigin): string {
  const recurring = origin.recur !== null && origin.recur !== undefined && origin.recur !== '';
  const cadence = recurring ? cadenceDisplay(origin.recur) : null;
  let body: string;
  if (origin.kind === 'spawn') {
    const armer = armerPhrase(origin);
    body = recurring
      ? `You were BORN by a scheduled wake, not spawned on demand — a recurring spawn-cron armed by ` +
        `${armer}, firing ${cadence}. The runtime re-births a fresh node like you on this cadence whether ` +
        `or not earlier runs survived: you are one run of a standing job, not a one-off, and you inherit ` +
        `nothing from prior runs but this task. Your task follows.`
      : `You were BORN by a scheduled wake, not spawned on demand — a one-shot deferred birth armed by ` +
        `${armer} to fire now. You are its only run, not a recurring job. Your task follows.`;
  } else {
    // bare scheduled alarm (the only kind delivered through this block at the
    // revive seam; noted/deadline self-mark via their inbox label instead).
    body = recurring
      ? `You woke because a recurring scheduled alarm fired (${cadence}) — a timer, NOT a new message or ` +
        `request. This is one tick of a standing re-check: re-read your roadmap and the disk bearings below ` +
        `and decide what this moment calls for.`
      : `You woke because a scheduled alarm fired — a timer, NOT a new message or request. This is a timed ` +
        `re-check, not a new task: re-read your roadmap and the disk bearings below and decide what this ` +
        `moment calls for.`;
  }
  return `<crtr-wake>\n${body}\n</crtr-wake>`;
}

/** The full boot intro: the IDENTITY assertion (always first, so it overrides
 *  any copied-in persona) followed by the `<crtr-context>` bearings block. Base
 *  framing rides for EVERY node; the across-cycles context-dir note is added
 *  ONLY for an orchestrator (by mode) — the one node whose dir a future cycle
 *  resumes from. The `<knowledge>` block carries the substrate knowledge docs
 *  + node-local docs. */
export function buildContextBearings(nodeId: string): string {
  const identity = buildIdentityAssertion(nodeId);
  const dir = contextDir(nodeId);
  const node = getNode(nodeId);
  const parts = [BASE_CONTEXT_NOTE];
  // Orchestrator-only: the across-cycles framing (a terminal has no future cycle).
  if (node?.mode === 'orchestrator') parts.push(orchestratorContextNote(nodeId));
  // The substrate knowledge block: eligible `knowledge` docs at their
  // system-prompt rung + node-local memory docs; dropped (returns '') when
  // nothing is eligible.
  const knowledge = renderKnowledgeBlock(nodeId);
  if (knowledge !== '') parts.push(knowledge);
  return `${identity}\n<crtr-context dir="${dir}">\n${parts.join('\n')}\n</crtr-context>`;
}
