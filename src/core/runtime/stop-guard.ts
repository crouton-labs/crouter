// The stop-guard — no stalled agents.
//
// Every time a node's pi process stops, we ask one question: is this node
// *legitimately waiting*? A node is legitimately waiting iff it holds an ACTIVE
// subscription to a node that's still live (active|idle) — something that can
// actually wake it. (A passive sub won't wake you, so it doesn't count.)
//
//   • waiting        → stopping is correct; it's a dormant orchestrator awaiting
//                      its workers. Let it sleep; a child's push wakes it.
//   • finished/asked → it pushed --final (done) or called `crtr ask` this turn.
//                      Also fine.
//   • otherwise      → it has nothing live to wait for and hasn't resolved.
//                      Re-prompt it to finish or escalate. Stalls are impossible.

import { hasActiveLiveSubscription, getNode } from '../canvas/index.js';

export interface StopSignals {
  /** Did the node call `push --final` (finish) this turn? */
  pushedFinal: boolean;
  /** Did the node call `crtr ask` (escalate to the human) this turn? */
  askedHuman: boolean;
}

export type StopAction =
  | { action: 'allow'; reason: 'awaiting' | 'finished' | 'escalated' | 'attended' }
  | { action: 'reprompt'; reason: 'stalled'; message: string };

export const STALL_REPROMPT =
  "You've stopped but you're not waiting on anyone and haven't finished. " +
  'Run `crtr push final "<result>"` if the work is done, or `crtr human ask` if you are blocked or need the user.';

/** Decide what to do when a node stops. Pure given the canvas + this turn's
 *  signals — the stophook supplies the signals and enacts the action. */
export function evaluateStop(nodeId: string, signals: StopSignals): StopAction {
  if (signals.pushedFinal) return { action: 'allow', reason: 'finished' };
  if (signals.askedHuman) return { action: 'allow', reason: 'escalated' };
  // A user-opened root (no parent) is human-attended: the human is its wake
  // source, so stopping to await input is always legitimate — never nag it.
  const node = getNode(nodeId);
  if (node !== null && (node.parent === null || node.parent === undefined)) {
    return { action: 'allow', reason: 'attended' };
  }
  if (hasActiveLiveSubscription(nodeId)) return { action: 'allow', reason: 'awaiting' };
  return { action: 'reprompt', reason: 'stalled', message: STALL_REPROMPT };
}
