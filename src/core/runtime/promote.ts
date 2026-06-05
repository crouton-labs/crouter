// Promotion — the worker→orchestrator polymorph (mode→orchestrator).
//
// Two stages (the pi-mode-switch pattern):
//   1. Promotion → mode flips to orchestrator (mid-turn). This call flips the
//      node's mode and (optionally) its KIND, REWRITES its launch spec to that
//      kind's orchestrator persona (so the next revive comes back as that
//      orchestrator), and seeds a roadmap scaffold + the three memory stores.
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

import { getNode, updateNode, setIntent, type NodeMeta } from '../canvas/index.js';
import { buildLaunchSpec } from './launch.js';
import { hasRoadmap, seedRoadmap, roadmapPath } from './roadmap.js';
import {
  seedMemory, memoryPath,
  seedUserMemory, userMemoryPath,
  seedProjectMemory, projectMemoryPath,
} from './memory.js';
import { readGoal, goalPath } from './kickoff.js';

export interface PromoteResult {
  meta: NodeMeta;
  roadmapWritten: boolean;
  /** Absolute path to the node's roadmap doc (context/roadmap.md). */
  roadmapPath: string;
  /** Absolute path to the node's goal doc (context/initial-prompt.md). */
  goalPath: string;
  /** Absolute path to the node-local memory index (context/memory/MEMORY.md). */
  memoryPath: string;
  /** Absolute path to the user-global memory index (<crtrHome>/memory/MEMORY.md). */
  userMemoryPath: string;
  /** Absolute path to the project memory index (<crtrHome>/projects/<key>/memory/MEMORY.md). */
  projectMemoryPath: string;
}

/** Promote a node to an orchestrator (mode→orchestrator), optionally
 *  specializing its kind (e.g. a `general` worker becoming a
 *  `developer.orchestrator`) and optionally also making it resident. Idempotent:
 *  re-promoting just rewrites the spec. Seeds a roadmap SCAFFOLD if absent (a
 *  boss with no map is a failure mode) — no goal is forced here; authoring the
 *  goal + roadmap is the node's next act. The transition guidance is injected
 *  centrally by the persona injector at the next turn boundary, not returned. */
export function promote(nodeId: string, opts: { kind?: string; resident?: boolean } = {}): PromoteResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  // The node may specialize as it promotes; default to its current kind.
  const targetKind = opts.kind ?? node.kind;

  // Rewrite the launch spec to the target kind's orchestrator persona so the
  // *next* revive comes back orchestrating in that kind (polymorph stage 2).
  // nodeEnv reads meta.{kind,mode}, so CRTR_KIND/CRTR_MODE flip immediately for
  // the live process's children too.
  const { launch } = buildLaunchSpec(targetKind, 'orchestrator');

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

  // Seed all three scoped memory stores alongside the roadmap — user-global,
  // project (keyed off this node's cwd), and node-local. Each is a durable,
  // refresh-surviving artifact; each guarded so a re-seed never clobbers an
  // evolved memory.
  seedUserMemory();
  seedProjectMemory(node.cwd);
  seedMemory(nodeId);

  // Flip mode→orchestrator + kind + launch spec. Lifecycle is independent:
  // only set resident when the caller asked for it (the common self-promotion
  // stays terminal/orchestrator — it still reports up + reaps).
  const meta = updateNode(nodeId, {
    kind: targetKind,
    mode: 'orchestrator',
    launch,
    ...(opts.resident === true ? { lifecycle: 'resident' as const } : {}),
  });
  return {
    meta,
    roadmapWritten,
    roadmapPath: roadmapPath(nodeId),
    goalPath: goalPath(nodeId),
    memoryPath: memoryPath(nodeId),
    userMemoryPath: userMemoryPath(),
    projectMemoryPath: projectMemoryPath(node.cwd),
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
export function requestYield(nodeId: string, opts: { kind?: string } = {}): YieldResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  let promoted = false;
  if (node.mode !== 'orchestrator') {
    // A yield needs a ROADMAP to refresh against — i.e. orchestrator mode, not
    // resident lifecycle. Ensure orchestrator (which seeds the roadmap + memory)
    // WITHOUT forcing resident: a terminal/orchestrator yields fine, since the
    // daemon's refresh-revive keys on intent='refresh', not lifecycle.
    promote(nodeId, opts.kind !== undefined ? { kind: opts.kind } : {});
    promoted = true;
  }

  // Mark the intent; the stophook enacts the shutdown, the daemon the revive.
  setIntent(nodeId, 'refresh');
  const meta = getNode(nodeId) as NodeMeta;
  return { meta, promoted, willRefresh: true };
}
