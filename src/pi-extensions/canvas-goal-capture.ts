// canvas-goal-capture.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// Two first-message jobs, both keyed off the node's first real `input` event:
//
//   1. Goal capture (bare roots). A node spawned with a prompt has its goal
//      persisted at birth (writeGoal in spawn.ts). A bare root (`crtr` with no
//      prompt) starts goal-less — its mandate only arrives when the human types
//      their first message; this persists that as context/initial-prompt.md.
//      Guarded so later messages never clobber it.
//
//   2. Naming (every node). Naming is async + event-driven — it does NOT run on
//      the spawn path (that blocking LLM call froze the caller's terminal for
//      2-3s on every spawn). On the first real message, if the node has no name
//      yet, ask pi headlessly (async, non-blocking) for a kebab-case name and
//      live-update the editor label. The first message may be a human's line OR
//      a delegated child's kickoff task — naming off the agent prompt is fine.
//
// Both skip extension-injected messages (inbox wakes, steering) and the
// fresh-revive kickoff (its sentinel), so neither is mistaken for a first input.
//
// Pure observation — it writes the goal file as a side effect and always lets
// the message through unchanged (returns nothing ⇒ continue). Registered before
// canvas-passive-context so it reads the raw user text, not a backlog-prepended
// transform.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { captureGoalIfAbsent, REVIVE_KICKOFF_SENTINEL } from '../core/runtime/kickoff.js';
import { generateAndPersistName } from '../core/runtime/naming.js';
import { editorLabel, getNode } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*).
// Mirrors the InputEvent shape used by canvas-passive-context.ts.
// ---------------------------------------------------------------------------

interface InputEventLike {
  type: 'input';
  text: string;
  images?: unknown[];
  source: 'interactive' | 'rpc' | 'extension';
}

interface PiLike {
  on: (event: 'input', handler: (event: InputEventLike, ctx: any) => void) => void;
  /** Update the live session display name (pi's editor label). Present in
   *  interactive mode; optional so the extension stays inert where it's not. */
  setSessionName?: (name: string) => void;
}

/**
 * Register the goal-capture handler on `pi`.
 *
 * Returns immediately (inert) when CRTR_NODE_ID is absent. The `input` handler
 * is the whole extension: on the first interactive message of a goal-less node,
 * persist it as the goal.
 */
export function registerCanvasGoalCapture(pi: PiLike): void {
  pi.on('input', (event: InputEventLike): void => {
    try {
      const nodeId = process.env['CRTR_NODE_ID'];
      if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

      const text = (event.text ?? '').trim();
      if (text === '') return;

      // Never seed a mandate or a name from an extension-injected message (inbox
      // wakes, steering nudges) or a fresh-revive kickoff (the node is already
      // named). Both would otherwise masquerade as the node's first real input.
      if (event.source === 'extension') return;
      if (text.startsWith(REVIVE_KICKOFF_SENTINEL)) return;

      // Goal capture is bare-root only: a delegated child already had its goal
      // persisted at birth (writeGoal), so only a genuine human-typed prompt
      // seeds a mandate here.
      if (event.source === 'interactive') captureGoalIfAbsent(nodeId, text);

      // Naming: name the node from its FIRST real message — a human's first line
      // OR a delegated child's kickoff task (naming off the agent prompt is
      // fine) — whenever it has no name yet. Async headless `pi -p` with no
      // canvas extensions, so it never recurses into another spawn/name. The
      // onNamed callback live-updates THIS session's label instead of waiting
      // for the next cycle. The unnamed-guard keeps it to one call per node.
      const meta = getNode(nodeId);
      if (meta !== null && (meta.description ?? '').trim() === '') {
        generateAndPersistName(nodeId, text, (named) => {
          try { pi.setSessionName?.(editorLabel(named)); } catch { /* best-effort */ }
        });
      }
    } catch {
      // Best-effort: a capture failure must never drop or alter the message.
    }
  });
}

export default registerCanvasGoalCapture;
