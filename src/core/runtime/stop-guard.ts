// The stop-guard — no stalled agents.
//
// Every time a node's pi process stops, we ask one question: is this node
// *legitimately waiting*? A node is legitimately waiting iff it holds an ACTIVE
// subscription to a node that's still live (active|idle) — something that can
// actually wake it. (A passive sub won't wake you, so it doesn't count.)
//
//   • resident       → an interactable / human-driven node is NEVER forced to
//                      submit a final: stopping to go dormant is always
//                      legitimate (woken by inbox/human). Keyed on the LIFECYCLE
//                      value, not on parent/mode — what matters is residency.
//   • waiting        → a TERMINAL node holding an active live subscription is a
//                      dormant orchestrator awaiting its workers. Let it sleep;
//                      a child's push wakes it (and idle-releases its window).
//   • finished/asked → it pushed --final (done) or called `crtr ask` this turn.
//                      Also fine.
//   • otherwise      → a TERMINAL node with nothing live to wait for and no
//                      final pushed. Re-prompt it to finish or escalate.

import { hasActiveLiveSubscription, getNode } from '../canvas/index.js';

export interface StopSignals {
  /** Did the node call `push --final` (finish) this turn? */
  pushedFinal: boolean;
  /** Did the node call `crtr ask` (escalate to the human) this turn? */
  askedHuman: boolean;
}

export type StopAction =
  | { action: 'allow'; reason: 'awaiting' | 'finished' | 'escalated' | 'dormant' }
  | { action: 'reprompt'; reason: 'stalled'; message: string };

export const STALL_REPROMPT =
  "You've stopped but you're not waiting on anyone and haven't finished. " +
  'Run `crtr push final "<result>"` if the work is done, or `crtr human ask` if you are blocked or need the user.';

/** Decide what to do when a node stops. Pure given the canvas + this turn's
 *  signals — the stophook supplies the signals and enacts the action. */
export function evaluateStop(nodeId: string, signals: StopSignals): StopAction {
  if (signals.pushedFinal) return { action: 'allow', reason: 'finished' };
  if (signals.askedHuman) return { action: 'allow', reason: 'escalated' };
  // A RESIDENT node is interactable / human-driven and is never forced to submit
  // a final: stopping to go dormant is always legitimate (the inbox or the human
  // wakes it). Keyed on lifecycle, not parent — whether it has a parent doesn't
  // matter, only whether it's resident. Roots are resident by birth default, so
  // this still covers "don't nag the human's root" while generalizing it.
  const node = getNode(nodeId);
  if (node !== null && node.lifecycle === 'resident') {
    return { action: 'allow', reason: 'dormant' };
  }
  // A terminal node holding something live to wake it is legitimately awaiting.
  if (hasActiveLiveSubscription(nodeId)) return { action: 'allow', reason: 'awaiting' };
  // A terminal node with nothing live and no final pushed has stalled.
  return { action: 'reprompt', reason: 'stalled', message: STALL_REPROMPT };
}
