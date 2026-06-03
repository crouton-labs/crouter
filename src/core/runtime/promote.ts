// Promotion — terminal → resident, and the worker→orchestrator polymorph.
//
// Two stages (the pi-mode-switch pattern):
//   1. Promotion → guidance dump (mid-turn, ephemeral). This call flips the
//      node's mode/lifecycle, REWRITES its launch spec to the orchestrator
//      persona (so the next revive comes back as an orchestrator), seeds the
//      roadmap, and RETURNS the orchestration guidance — which enters the
//      current context so the node can write its roadmap before any refresh.
//   2. Refresh → persona swap (permanent). On the next fresh revive the node
//      starts with the orchestrator system prompt baked in (because the launch
//      spec now says orchestrator). The guidance dump bridges until then.
//
// Trigger is persistence-need (deliberate, or a refresh-yield with open work),
// never the mere act of spawning a child.

import { getNode, updateNode, hasActiveLiveSubscription, type NodeMeta } from '../canvas/index.js';
import { buildLaunchSpec } from './launch.js';
import { loadKernel } from '../personas/index.js';
import { hasRoadmap, seedRoadmap, readRoadmap, logProgress } from './roadmap.js';

export interface PromoteResult {
  meta: NodeMeta;
  /** Orchestration guidance to surface into the node's current context now. */
  guidance: string;
  roadmapWritten: boolean;
}

/** Build the mid-turn guidance dump: how to orchestrate, plus the node's
 *  current roadmap so it can extend it immediately. */
function orchestrationGuidance(nodeId: string): string {
  const kernel = loadKernel();
  const roadmap = readRoadmap(nodeId) ?? '(no roadmap yet — seed it now)';
  return [
    'You are now a RESIDENT ORCHESTRATOR. Your scarce resource is your own context window.',
    'Your job is to manage context and delegate — not to do the goal yourself.',
    '',
    kernel,
    '',
    'Maintain `context/roadmap.md` as the source of truth for your plan. Your current roadmap:',
    '',
    roadmap,
    '',
    'Next: refine the roadmap (scope assumptions, phases), then delegate each unit with `crtr node new`.',
    'When your context fills, run `crtr node yield` to refresh against this roadmap.',
  ].join('\n');
}

/** Promote a node to resident orchestrator. Idempotent: re-promoting just
 *  returns fresh guidance. Seeds a roadmap (mandatory for a manager) — uses
 *  `goal` when provided; otherwise a stub the node must fill in. */
export function promote(
  nodeId: string,
  opts: { goal?: string; exitCriteria?: string } = {},
): PromoteResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  // Rewrite the launch spec to the orchestrator persona so the *next* revive
  // comes back orchestrating (polymorph stage 2). nodeEnv reads meta.mode, so
  // CRTR_MODE flips immediately for the live process's children too.
  const { launch } = buildLaunchSpec(node.kind, 'orchestrator');

  // Seed the roadmap if absent (a boss with no map is a failure mode).
  let roadmapWritten = false;
  if (!hasRoadmap(nodeId)) {
    seedRoadmap(nodeId, opts.goal ?? '(state the high-level goal you are now owning)', opts.exitCriteria);
    roadmapWritten = true;
  } else if (opts.goal !== undefined) {
    logProgress(nodeId, `promotion goal: ${opts.goal}`);
  }

  const meta = updateNode(nodeId, { lifecycle: 'resident', mode: 'orchestrator', launch });
  return { meta, guidance: orchestrationGuidance(nodeId), roadmapWritten };
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
 *  so it comes back as an orchestrator. Sets intent='refresh'; the stophook
 *  shuts the process down on the next stop and the daemon revives it fresh. */
export function requestYield(nodeId: string, opts: { goal?: string } = {}): YieldResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  let promoted = false;
  if (node.lifecycle === 'terminal') {
    // Yielding with open work ⇒ must survive a context reset ⇒ promote.
    promote(nodeId, opts.goal !== undefined ? { goal: opts.goal } : {});
    promoted = true;
  } else if (opts.goal !== undefined) {
    logProgress(nodeId, `yield goal note: ${opts.goal}`);
  }

  // Mark the intent; the stophook enacts the shutdown, the daemon the revive.
  const meta = updateNode(nodeId, { intent: 'refresh' });
  void hasActiveLiveSubscription; // (open-work signal, reserved for future gating)
  return { meta, promoted, willRefresh: true };
}
