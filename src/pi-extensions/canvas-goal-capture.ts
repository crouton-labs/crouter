// canvas-goal-capture.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// A node spawned with a prompt has its goal persisted at birth (writeGoal in
// spawn.ts). A bare root (`crtr` with no prompt) starts goal-less — its mandate
// only arrives when the human types their first message. This extension closes
// that gap: on the FIRST interactive user message, if the node has no goal yet,
// it persists that message as context/initial-prompt.md. Subsequent messages
// never clobber it (captureGoalIfAbsent is guarded), and a fresh-revive kickoff
// prompt is skipped via its sentinel so it can never be mistaken for a mandate.
//
// Pure observation — it writes the goal file as a side effect and always lets
// the message through unchanged (returns nothing ⇒ continue). Registered before
// canvas-passive-context so it reads the raw user text, not a backlog-prepended
// transform.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { captureGoalIfAbsent, REVIVE_KICKOFF_SENTINEL } from '../core/runtime/kickoff.js';

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

      // Only a genuine human-typed prompt seeds the mandate — never an RPC or an
      // extension-injected message (inbox wakes, steering nudges, kickoffs).
      if (event.source !== 'interactive') return;

      const text = (event.text ?? '').trim();
      if (text === '') return;

      // A fresh-revive kickoff is delivered as the launch prompt; never let it
      // masquerade as the user's first mandate.
      if (text.startsWith(REVIVE_KICKOFF_SENTINEL)) return;

      captureGoalIfAbsent(nodeId, text);
    } catch {
      // Best-effort: a capture failure must never drop or alter the message.
    }
  });
}

export default registerCanvasGoalCapture;
