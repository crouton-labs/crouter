// persona.ts — the CENTRALIZED persona-transition injector.
//
// A node has two orthogonal, independently switchable axes:
//   • mode      — base (hands-on, finishes in one window) ↔ orchestrator
//                 (delegates, holds a roadmap, survives refresh cycles + yields)
//   • lifecycle — terminal (owes a final up the spine, reaps when done) ↔
//                 resident (interactable, stays dormant, never forced to submit)
//
// Whenever EITHER axis changes from the value the node was last GIVEN guidance
// for, the node must be prompt-injected with guidance for its new state —
// automatically, here, not by each state-changing command. Commands just call
// `updateNode({ mode|lifecycle })`; this module is the single source of the
// transition prose, delivered from exactly two sites:
//   • the stophook turn_end hook (self-changes this turn + external changes
//     while the node is active), and
//   • the revive kickoff (external changes made while the node was dormant).
//
// The `persona_ack` meta field records the last {mode,lifecycle} the node was
// given guidance for (born equal to its initial persona at spawn, so a fresh
// worker never gets spurious guidance). `personaDrift` compares live meta to it;
// the caller delivers the guidance, then commits the ack.

import { getNode, updateNode, type Mode, type Lifecycle } from '../canvas/index.js';
import { loadKernel, loadPersona } from '../personas/index.js';
import { resolveSkill } from '../resolver.js';
import { readText } from '../fs-utils.js';
import { parseFrontmatter } from '../frontmatter.js';
import { readRoadmap, roadmapPath } from './roadmap.js';
import { readGoal, goalPath } from './kickoff.js';
import { orchestratorContextNote } from './bearings.js';
import {
  memoryPath, memoryDir,
  userMemoryPath, userMemoryDir,
  projectMemoryPath, projectMemoryDir,
} from './memory.js';

/** The two-axis persona state the injector keys on. */
export interface Persona {
  mode: Mode;
  lifecycle: Lifecycle;
}

export interface PersonaDriftResult {
  from: Persona;
  to: Persona;
  /** The built transition guidance to inject for `to`. */
  guidance: string;
}

// ---------------------------------------------------------------------------
// base→orchestrator guidance (the roadmap-shaping dump) — MOVED here from
// promote.ts so the injector is the one place that builds it.
// ---------------------------------------------------------------------------

/** Load a skill's body text by name, or null if it can't be resolved. Used to
 *  inline a kind's roadmap-shaping skill into the orchestration guidance. */
function loadSkillBody(name: string): string | null {
  try {
    const skill = resolveSkill(name, {});
    return parseFrontmatter(readText(skill.path)).body.trim();
  } catch {
    return null;
  }
}

/** The base→orchestrator guidance dump, specialized to the node's kind: the
 *  shared kernel + that kind's roadmap-shaping skill + the roadmap scaffold the
 *  node must author + the orchestrator context-dir framing + the three memory
 *  stores. The node is now a delegator whose scarce resource is its own context
 *  window. (Lifecycle is left to its own section — promotion no longer forces
 *  resident, so this never asserts residency.) */
function orchestrationGuidance(nodeId: string, kind: string, cwd: string): string {
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
    `You are now a ${kind.toUpperCase()} ORCHESTRATOR. Your scarce resource is your own context window.`,
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
    // The orchestrator framing for the context dir — the missing guidance a
    // promoted node never got at spawn (it spawned as a base worker). Same note
    // a born-orchestrator gets in its <crtr-context> bearings block.
    orchestratorContextNote(nodeId),
    '',
    'Your long-term memory now exists across three seeded stores (write to them directly), each a different scope per "Your long-term memory" above:',
    `  • user-global \`${userMemoryDir()}\` (index \`${userMemoryPath()}\`) — who the human is, how they like to work; loaded into every orchestrator everywhere.`,
    `  • project \`${projectMemoryDir(cwd)}\` (index \`${projectMemoryPath(cwd)}\`) — facts bound to this repo; loaded into every orchestrator working here.`,
    `  • node-local \`${memoryDir(nodeId)}\` (index \`${memoryPath(nodeId)}\`) — facts specific to this goal; they die with this node.`,
    'A memory\'s `type` decides which store it lands in (see "Your long-term memory"). These same paths ride into every future wake in your `<crtr-context>` block.',
    '',
    'Then delegate each phase with `crtr node new --kind <kind>`. When your context fills, run `crtr node yield` to refresh against this roadmap.',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// The other three transitions — short, prescriptive, audience = the node's
// agent (decision-first; one well-placed "don't").
// ---------------------------------------------------------------------------

/** orchestrator → base (demote): hands-on again, finish in-window. */
function baseModeGuidance(): string {
  return (
    'You are HANDS-ON again — base mode. Do the work yourself in THIS window and finish it here; ' +
    'stop delegating by default. You no longer drive a roadmap, so `crtr node yield` is not your exit. ' +
    'Spawn a child only for a cleanly separable unit, never as your first move.'
  );
}

/** terminal → resident: interactable, never forced to submit. */
function residentLifecycleGuidance(): string {
  return (
    'You are RESIDENT and interactable now. You are NEVER forced to submit a final result: stopping is ' +
    'legitimate — you go dormant and wake on an inbox message or the human. Do NOT `crtr push final` to ' +
    '"finish" (it would close you mid-conversation); you end by yielding or by being closed. End your turn ' +
    'whenever you have nothing in hand — a wake brings you back.'
  );
}

/** resident → terminal: owes a final up the spine, reaps when done. */
function terminalLifecycleGuidance(): string {
  return (
    'You are TERMINAL now: you owe a final result UP the spine and you reap when done. Drive the work to ' +
    'completion, then `crtr push final "<result>"` — that records the canonical result and closes you. ' +
    'Don\'t sit dormant: stopping with nothing live to await and no final pushed is a stall, and you\'ll be ' +
    're-prompted to finish or escalate (`crtr human ask`).'
  );
}

/** Build the injected transition prompt for a `from → to` persona change.
 *  Concatenates the relevant section per changed axis (both when both changed).
 *  Pure read of the node's roadmap/goal/memory for the base→orchestrator case. */
export function transitionGuidance(nodeId: string, from: Persona, to: Persona): string {
  const sections: string[] = [];

  if (from.mode !== to.mode) {
    if (to.mode === 'orchestrator') {
      const node = getNode(nodeId);
      sections.push(orchestrationGuidance(nodeId, node?.kind ?? 'general', node?.cwd ?? process.cwd()));
    } else {
      sections.push(baseModeGuidance());
    }
  }

  if (from.lifecycle !== to.lifecycle) {
    sections.push(to.lifecycle === 'resident' ? residentLifecycleGuidance() : terminalLifecycleGuidance());
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Detector + ack commit.
// ---------------------------------------------------------------------------

/** Compare a node's live {mode,lifecycle} against its `persona_ack` (the last
 *  state it was given guidance for). Returns the transition + built guidance
 *  when they differ, else null. Does NOT mutate — the caller delivers the
 *  guidance, then `commitPersonaAck`s the new state. An unset `persona_ack`
 *  (legacy node) defaults to the current persona, so it reads as no drift and
 *  never fabricates spurious guidance. */
export function personaDrift(nodeId: string): PersonaDriftResult | null {
  const meta = getNode(nodeId);
  if (meta === null) return null;
  const to: Persona = { mode: meta.mode, lifecycle: meta.lifecycle };
  const from: Persona = meta.persona_ack ?? { mode: meta.mode, lifecycle: meta.lifecycle };
  if (from.mode === to.mode && from.lifecycle === to.lifecycle) return null;
  return { from, to, guidance: transitionGuidance(nodeId, from, to) };
}

/** Commit the persona state the node has now been given guidance for. */
export function commitPersonaAck(nodeId: string, to: Persona): void {
  updateNode(nodeId, { persona_ack: to });
}
