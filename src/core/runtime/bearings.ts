// bearings.ts — the <crtr-context> framing prose, shared by the two paths that
// deliver it so they can never drift:
//
//   • the context-intro pi-extension injects buildContextBearings() as the
//     node's first session message in every brand-new chat;
//   • promote.ts folds orchestratorContextNote() into the promotion guidance
//     dump, so a node that becomes an orchestrator MID-LIFE gets the
//     orchestrator framing it never received at spawn — it spawned as a base
//     worker, and the bearings already in its history carry only the base note.
//
// Base framing (every node): the context dir is durable, shared scratch — the
// one place other nodes on the canvas can read from, so it is for documents
// worth a shared reference, NOT a task tracker, and NOT a "future memory-wiped
// you" stash (a terminal worker has no future cycle — that framing only makes
// sense once a node is a resident orchestrator).
//
// Orchestrator addendum (resident orchestrators — i.e. nodes that have a
// node-local memory store): the dir ALSO survives refresh cycles, so it is where
// a future cycle of the orchestrator resumes; durable cross-goal lessons live in
// the three scoped memory stores, whose indexes are inlined into <memory>.

import { contextDir, getNode } from '../canvas/index.js';
import {
  hasMemory,
  memoryDir,
  memoryPath,
  readMemory,
  hasUserMemory,
  userMemoryDir,
  userMemoryPath,
  readUserMemory,
  hasProjectMemory,
  projectMemoryDir,
  projectMemoryPath,
  readProjectMemory,
  projectKey,
} from './memory.js';

/** Base framing — present for every node. No path baked in: the caller carries
 *  the dir in the <crtr-context dir="…"> attribute. */
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

/** One labeled store stanza inside <memory>: a scope heading + one-line blurb,
 *  the store's ABSOLUTE dir + index paths (so the node knows where to WRITE this
 *  kind), and the live index read fresh from disk (pointer lines only — detail
 *  files are NOT inlined; they load on demand). */
function memoryStanza(label: string, blurb: string, dir: string, idx: string, index: string | null): string {
  const body = index !== null && index.trim() !== '' ? index.trim() : '(store not seeded)';
  return `[${label}] ${blurb}\n  dir: ${dir}\n  index: ${idx}\n${body}`;
}

/** The <memory> block (orchestrators only): the three scoped stores merged, each
 *  labeled with its scope, its absolute dir + index paths, and its index read
 *  fresh from disk. A memory's `type` decides which store it lands in — the
 *  mapping lives in the orchestration kernel; here we just show the node where
 *  each store is. user-global is always present; project rides in when the node
 *  has a project store; node-local is the gate, so always present. */
export function buildMemoryBlock(nodeId: string, cwd: string): string {
  const stanzas: string[] = [];
  if (hasUserMemory()) {
    stanzas.push(memoryStanza(
      'user-global',
      'who the human is and how they like to work — loaded into every orchestrator, everywhere.',
      userMemoryDir(), userMemoryPath(), readUserMemory(),
    ));
  }
  if (hasProjectMemory(cwd)) {
    stanzas.push(memoryStanza(
      'project',
      `facts bound to this repo (key ${projectKey(cwd)}) — loaded into every orchestrator working here.`,
      projectMemoryDir(cwd), projectMemoryPath(cwd), readProjectMemory(cwd),
    ));
  }
  stanzas.push(memoryStanza(
    'node-local',
    'facts specific to THIS goal — they die with this node.',
    memoryDir(nodeId), memoryPath(nodeId), readMemory(nodeId),
  ));
  return (
    '<memory>\n' +
    'Your long-term memory spans three scopes. Read each index below on wake; load a detail file on ' +
    "demand. A memory's `type` decides its store (see \"Your long-term memory\" in your instructions); " +
    'write each fact into the matching store\'s dir.\n\n' +
    stanzas.join('\n\n') +
    '\n</memory>'
  );
}

/** The full <crtr-context> bearings block: base framing always, plus the
 *  orchestrator addendum + the merged three-store <memory> block when the node
 *  has a node-local memory store (the orchestrator gate). */
export function buildContextBearings(nodeId: string): string {
  const dir = contextDir(nodeId);
  if (!hasMemory(nodeId)) {
    // A terminal worker (no memory store): base framing only, no memory block.
    return `<crtr-context dir="${dir}">\n${BASE_CONTEXT_NOTE}\n</crtr-context>`;
  }
  // An orchestrator: across-cycles framing + the merged three-store memory. The
  // project store is keyed off the node's cwd (its working dir on disk).
  const cwd = getNode(nodeId)?.cwd ?? process.cwd();
  return (
    `<crtr-context dir="${dir}">\n` +
    `${BASE_CONTEXT_NOTE}\n${orchestratorContextNote(nodeId)}\n${buildMemoryBlock(nodeId, cwd)}\n` +
    '</crtr-context>'
  );
}
