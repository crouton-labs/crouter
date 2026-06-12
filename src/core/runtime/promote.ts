// Promotion — the worker→orchestrator polymorph (mode→orchestrator).
//
// Two stages (the pi-mode-switch pattern):
//   1. Promotion → mode flips to orchestrator (mid-turn). This call flips the
//      node's mode and (optionally) its KIND, REWRITES its launch spec to that
//      kind's orchestrator persona (so the next revive comes back as that
//      orchestrator), and seeds a roadmap scaffold.
//      The transition guidance the node needs is injected CENTRALLY by the
//      persona injector (runtime/persona.ts) at the turn boundary — promote()
//      itself no longer returns or hand-emits guidance.
//   2. Refresh → persona swap (permanent). On the next fresh revive the node
//      starts with the orchestrator system prompt baked in (because the launch
//      spec now says orchestrator). The injected guidance bridges until then.
//
// Mode and lifecycle are ORTHOGONAL: promotion flips mode only. Lifecycle stays
// whatever it was (a promoted child is terminal/orchestrator — still reports up
// + reaps) unless the caller passes `resident:true` to also make it resident.
//
// Trigger is persistence-need (deliberate, or a refresh-yield with open work),
// never the mere act of spawning a child.

import { getNode, updateNode, type NodeMeta } from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { buildLaunchSpec } from './launch.js';
import { hasRoadmap, seedRoadmap, roadmapPath } from './roadmap.js';
import { readGoal, goalPath } from './kickoff.js';

export interface PromoteResult {
  meta: NodeMeta;
  roadmapWritten: boolean;
  /** Absolute path to the node's roadmap doc (context/roadmap.md). */
  roadmapPath: string;
  /** Absolute path to the node's goal doc (context/initial-prompt.md). */
  goalPath: string;
}

/** Promote a node to an orchestrator (mode→orchestrator), optionally
 *  specializing its kind (e.g. a `general` worker becoming a
 *  `developer.orchestrator`) and optionally also making it resident. Idempotent:
 *  re-promoting just rewrites the spec. Seeds a roadmap SCAFFOLD if absent (a
 *  boss with no map is a failure mode) — no goal is forced here; authoring the
 *  goal + roadmap is the node's next act. The transition guidance is injected
 *  centrally by the persona injector at the next turn boundary, not returned. */
export function promote(nodeId: string, opts: { kind?: string; resident?: boolean; model?: string } = {}): PromoteResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  // The node may specialize as it promotes; default to its current kind.
  const targetKind = opts.kind ?? node.kind;
  // ...and may raise/change its model tier; default to its current pin (so a
  // promote with no --model preserves whatever it was running on).
  const targetModel = opts.model ?? node.model_override ?? undefined;

  // Rewrite the launch spec to the target kind's orchestrator persona so the
  // *next* revive comes back orchestrating in that kind (polymorph stage 2).
  // nodeEnv reads meta.{kind,mode}, so CRTR_KIND/CRTR_MODE flip immediately for
  // the live process's children too.
  // Bake the node's post-promote lifecycle + spine into the rebuilt prompt:
  // lifecycle becomes resident only when the caller asked (else it keeps its
  // current value); spine is fixed by parent-ness (immutable).
  const { launch } = buildLaunchSpec(targetKind, 'orchestrator', {
    lifecycle: opts.resident === true ? 'resident' : node.lifecycle,
    hasManager: node.parent !== null,
    // A model tier chosen on this call (opts.model) overrides the persona
    // default and is persisted below; absent one, the existing pin carries
    // across the polymorph (the persona default is recomputed fresh for
    // targetKind).
    model: targetModel,
  });

  // Seed a barebones roadmap scaffold if absent so the file exists for a
  // refresh. Pre-fill its Goal from the node's goal doc when present (set at
  // spawn, or captured from the first user message); the node fleshes out the
  // body next, guided by the kind skill dumped below.
  let roadmapWritten = false;
  if (!hasRoadmap(nodeId)) {
    const goal = readGoal(nodeId);
    seedRoadmap(nodeId, goal !== null && goal.trim() !== '' ? { goal: goal.trim() } : {});
    roadmapWritten = true;
  }

  // Flip mode→orchestrator + kind + launch spec. Lifecycle is independent:
  // only set resident when the caller asked for it (the common self-promotion
  // stays terminal/orchestrator — it still reports up + reaps).
  const meta = updateNode(nodeId, {
    kind: targetKind,
    mode: 'orchestrator',
    launch,
    // Persist a newly-chosen tier so it is durable across future revives; omit
    // when unchanged so the existing pin (or persona default) stands.
    ...(opts.model !== undefined ? { model_override: opts.model } : {}),
    ...(opts.resident === true ? { lifecycle: 'resident' as const } : {}),
  });
  return {
    meta,
    roadmapWritten,
    roadmapPath: roadmapPath(nodeId),
    goalPath: goalPath(nodeId),
  };
}

export interface YieldResult {
  meta: NodeMeta;
  promoted: boolean;
  /** Always true on success — the node will refresh-revive on its next stop. */
  willRefresh: boolean;
}

/** Request a refresh-yield: discard in-memory context and revive fresh against
 *  the roadmap. A *terminal* node that yields is choosing to persist — it
 *  promotes first (refresh-with-open-work is the canonical promotion trigger),
 *  so it comes back as an orchestrator, optionally specializing its kind. Sets
 *  intent='refresh'; the stophook shuts the process down on the next stop and
 *  the daemon revives it fresh. */
export function requestYield(nodeId: string, opts: { kind?: string; model?: string } = {}): YieldResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  // A yield may also RESHAPE the node as it refreshes — change kind and/or raise
  // model tier. promote() is idempotent (on an already-orchestrator node it just
  // rewrites the launch spec), so it doubles as the apply-path for that reshape.
  const reshaping = opts.kind !== undefined || opts.model !== undefined;
  const wasBase = node.mode !== 'orchestrator';
  let promoted = false;
  if (wasBase || reshaping) {
    // A yield needs a ROADMAP to refresh against — i.e. orchestrator mode, not
    // resident lifecycle. Ensure orchestrator (which seeds the roadmap + memory)
    // WITHOUT forcing resident: a terminal/orchestrator yields fine, since the
    // daemon's refresh-revive keys on intent='refresh', not lifecycle.
    promote(nodeId, {
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    // "promoted" means a base node became an orchestrator — not a mere reshape
    // of an already-orchestrator node.
    promoted = wasBase;
  }

  // Mark the intent; the stophook enacts the shutdown, the daemon the revive.
  transition(nodeId, 'yield');
  const meta = getNode(nodeId) as NodeMeta;
  return { meta, promoted, willRefresh: true };
}
