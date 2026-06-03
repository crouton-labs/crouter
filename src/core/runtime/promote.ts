// Promotion — terminal → resident, and the worker→orchestrator polymorph.
//
// Two stages (the pi-mode-switch pattern):
//   1. Promotion → guidance dump (mid-turn, ephemeral). This call flips the
//      node's mode/lifecycle and (optionally) its KIND, REWRITES its launch
//      spec to that kind's orchestrator persona (so the next revive comes back
//      as that orchestrator), seeds a roadmap scaffold, and RETURNS kind-
//      specific orchestration + roadmap-shaping guidance — which enters the
//      current context so the node can author its roadmap before any refresh.
//   2. Refresh → persona swap (permanent). On the next fresh revive the node
//      starts with the orchestrator system prompt baked in (because the launch
//      spec now says orchestrator). The guidance dump bridges until then.
//
// Trigger is persistence-need (deliberate, or a refresh-yield with open work),
// never the mere act of spawning a child.

import { getNode, updateNode, hasActiveLiveSubscription, type NodeMeta } from '../canvas/index.js';
import { buildLaunchSpec } from './launch.js';
import { loadKernel, loadPersona } from '../personas/index.js';
import { resolveSkill } from '../resolver.js';
import { readText } from '../fs-utils.js';
import { parseFrontmatter } from '../frontmatter.js';
import { hasRoadmap, seedRoadmap, readRoadmap, roadmapPath } from './roadmap.js';
import { readGoal, goalPath } from './kickoff.js';

export interface PromoteResult {
  meta: NodeMeta;
  /** Orchestration guidance to surface into the node's current context now. */
  guidance: string;
  roadmapWritten: boolean;
  /** Absolute path to the node's roadmap doc (context/roadmap.md). */
  roadmapPath: string;
  /** Absolute path to the node's goal doc (context/initial-prompt.md). */
  goalPath: string;
}

/** Load a skill's body text by name, or null if it can't be resolved. Used to
 *  inline a kind's roadmap-shaping skill into the promotion guidance dump. */
function loadSkillBody(name: string): string | null {
  try {
    const skill = resolveSkill(name, {});
    return parseFrontmatter(readText(skill.path)).body.trim();
  } catch {
    return null;
  }
}

/** Build the mid-turn guidance dump, specialized to the node's (possibly
 *  just-chosen) kind: the shared kernel + that kind's roadmap-shaping skill
 *  (auto-loaded now, before the persona swap bakes in on revive) + the roadmap
 *  scaffold the node must author. No goal is assumed — writing it is step one. */
function orchestrationGuidance(nodeId: string, kind: string): string {
  const kernel = loadKernel();
  const orch = loadPersona(kind, 'orchestrator');
  const roadmapSkill =
    typeof orch?.frontmatter?.['roadmapSkill'] === 'string'
      ? (orch.frontmatter['roadmapSkill'] as string)
      : undefined;
  const skillBody = roadmapSkill ? loadSkillBody(roadmapSkill) : null;
  const roadmap = readRoadmap(nodeId) ?? '(no roadmap yet)';
  const rmPath = roadmapPath(nodeId);
  const goal = readGoal(nodeId);

  const parts: string[] = [
    `You are now a RESIDENT ${kind.toUpperCase()} ORCHESTRATOR. Your scarce resource is your own context window.`,
    'Your job is to manage context and delegate — not to do the goal yourself.',
    '',
    kernel,
  ];
  if (goal !== null && goal.trim() !== '') {
    parts.push('', `--- Your goal (${goalPath(nodeId)}) ---`, '', goal.trim());
  }
  if (skillBody) {
    parts.push('', `--- How to shape a ${kind} roadmap (skill: ${roadmapSkill}) ---`, '', skillBody);
  }
  parts.push(
    '',
    `Your roadmap scaffold (\`${rmPath}\`) — author it now: state the goal, exit criteria, and the phase skeleton, using the approach above. Current contents:`,
    '',
    roadmap,
    '',
    'Then delegate each phase with `crtr node new --kind <kind>`. When your context fills, run `crtr node yield` to refresh against this roadmap.',
  );
  return parts.join('\n');
}

/** Promote a node to resident orchestrator, optionally specializing its kind
 *  (e.g. a `general` worker becoming a `developer.orchestrator`). Idempotent:
 *  re-promoting just rewrites the spec + returns fresh guidance. Seeds a
 *  roadmap SCAFFOLD if absent (a boss with no map is a failure mode) — no goal
 *  is forced here; authoring the goal + roadmap is the node's next act. */
export function promote(nodeId: string, opts: { kind?: string } = {}): PromoteResult {
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

  const meta = updateNode(nodeId, { kind: targetKind, lifecycle: 'resident', mode: 'orchestrator', launch });
  return {
    meta,
    guidance: orchestrationGuidance(nodeId, targetKind),
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
export function requestYield(nodeId: string, opts: { kind?: string } = {}): YieldResult {
  const node = getNode(nodeId);
  if (node === null) throw new Error(`unknown node: ${nodeId}`);

  let promoted = false;
  if (node.lifecycle === 'terminal') {
    // Yielding with open work ⇒ must survive a context reset ⇒ promote
    // (optionally specializing the kind).
    promote(nodeId, opts.kind !== undefined ? { kind: opts.kind } : {});
    promoted = true;
  }

  // Mark the intent; the stophook enacts the shutdown, the daemon the revive.
  const meta = updateNode(nodeId, { intent: 'refresh' });
  void hasActiveLiveSubscription; // (open-work signal, reserved for future gating)
  return { meta, promoted, willRefresh: true };
}
