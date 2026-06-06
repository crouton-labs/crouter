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
// the three scoped memory stores, whose index pointer lines are inlined into
// <memory> (the how-to lives once in the kernel, not here).

import { contextDir, getNode } from '../canvas/index.js';
import {
  hasMemory,
  memoryDir,
  readMemory,
  hasUserMemory,
  userMemoryDir,
  readUserMemory,
  hasProjectMemory,
  projectMemoryDir,
  readProjectMemory,
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

/** One labeled store stanza inside <memory>: a compact `label · dir` header (the
 *  scope name + where to WRITE this kind of memory), then the LIVE pointer lines
 *  extracted fresh from the store's index — only lines matching `- [...` — with
 *  the index's how-to boilerplate dropped (it lives once in the kernel) and
 *  detail files loaded on demand. Falls back to `(empty)` when the index carries
 *  no pointers, which also covers the not-seeded / template-only case. */
function memoryStanza(label: string, dir: string, index: string | null): string {
  const pointers = (index ?? '')
    .split('\n')
    .filter((line) => /^\s*-\s*\[/.test(line))
    .map((line) => line.trim());
  const body = pointers.length > 0 ? pointers.join('\n') : '(empty)';
  return `${label} · ${dir}\n${body}`;
}

/** The <memory> block (orchestrators only): the scoped stores merged, each a
 *  `label · dir` header over its live index pointer lines. A memory's `type`
 *  decides which store it lands in — the mapping + the how-to live once in the
 *  orchestration kernel ("Your long-term memory"); here we carry only the live
 *  data + a one-line pointer back to it. user-global rides in when the node has
 *  a user store, project when it has a project store, node-local always (the
 *  orchestrator gate). */
export function buildMemoryBlock(nodeId: string, cwd: string): string {
  const stanzas: string[] = [];
  if (hasUserMemory()) {
    stanzas.push(memoryStanza('user-global', userMemoryDir(), readUserMemory()));
  }
  if (hasProjectMemory(cwd)) {
    stanzas.push(memoryStanza('project', projectMemoryDir(cwd), readProjectMemory(cwd)));
  }
  stanzas.push(memoryStanza('node-local', memoryDir(nodeId), readMemory(nodeId)));
  const n = stanzas.length;
  return (
    '<memory>\n' +
    `Long-term memory, ${n} scope${n === 1 ? '' : 's'}. Each line ` +
    '`- [Title](slug.md) — hook`; load a detail file by slug from the scope dir on demand. ' +
    'Write a new fact to the scope matching its `type` (see "Your long-term memory").\n\n' +
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
