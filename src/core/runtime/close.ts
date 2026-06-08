// close.ts — the "close this node + its subtree" action behind `crtr node close`.
//
// Closing a node tears down the focused node and every descendant it
// EXCLUSIVELY owns, walking DOWN the subscribes_to spine (subscriptionsOf = a
// node's reports/children). Nothing is deleted: pi_session_id, the canvas
// edges, and all on-disk state persist, so any closed node can later be revived
// (`crtr canvas revive` / focus → `pi --session <id>`). A close is a pause, not a reap.
//
// Per node, in this order — the order matters twice:
//
//   1. Mark `canceled` + clear intent. Done BEFORE the window dies: the daemon
//      only ever revives an active|idle node, so flipping to canceled first
//      closes the race where the supervisor sees a window-gone live node and
//      either revives it or marks it dead (overwriting our canceled).
//   2. Kill its tmux PANE (the window closes once its last pane goes) — which
//      kills pi and, with it, the inbox watcher. Pane-granular so that nodes
//      the user co-located as panes in ONE window (via swap-pane focus) are not
//      all taken down when one of them is closed.
//   3. Append the cancellation notice to its inbox AFTER the watcher is gone.
//      The watcher advances its cursor when it READS an entry, so appending
//      while it is still live would let it consume + skip the notice (cursor
//      moves past it, never delivered). Killed first, the cursor stays put;
//      on the node's next resume a fresh watcher seeds from that frozen cursor,
//      finds the notice, and injects it — the agent learns its children died.
//
// The cascade is GUARDED: a descendant is closed only when EVERY node that
// subscribes to it (its managers, subscribersOf — active OR passive) is itself
// inside the closing set. A node still subscribed to by a manager outside the
// subtree is left running — "only kill the children if they are only subscribed
// to by the agent being closed", generalized to any depth via a fixpoint.

import {
  getNode,
  subscriptionsOf,
  subscribersOf,
} from '../canvas/index.js';
import { transition } from './lifecycle.js';
import { tearDownNode } from './placement.js';
import { appendInbox } from '../feed/inbox.js';
import { appendPassive } from '../feed/passive.js';

export interface CloseNodeResult {
  /** The focused node that was closed — the cascade root. */
  root: string;
  /** Every node torn down (root + cascaded descendants), in kill order
   *  (leaves first, root last). */
  closed: string[];
  /** Descendants left alive because a manager outside the subtree still
   *  subscribes to them. */
  spared: string[];
}

/** The set of nodes to close: the root plus every descendant reachable down the
 *  subscriptions spine, all of whose managers are themselves in the set. Grown
 *  to a fixpoint — a node added this pass can qualify its own children next
 *  pass. Cycle-safe via the membership skip. */
function closingSet(root: string): Set<string> {
  const closing = new Set<string>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const parent of [...closing]) {
      for (const sub of subscriptionsOf(parent)) {
        const child = sub.node_id;
        if (closing.has(child)) continue;
        // Close the child only if NOBODY outside the closing set subscribes to
        // it. (subscriptionsOf always yields child→parent, so `parent` is one
        // of child's managers and is in `closing` — the check is never vacuous.)
        if (subscribersOf(child).every((m) => closing.has(m.node_id))) {
          closing.add(child);
          changed = true;
        }
      }
    }
  }
  return closing;
}

/** BFS the closing set from root, then reverse: leaves die first, the focused
 *  root dies last ("cascades up"). The root being killed last also keeps the
 *  user's foreground window — the one they invoked the close from — open until
 *  every background descendant is gone. */
function killOrder(root: string, closing: Set<string>): string[] {
  const order: string[] = [];
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const sub of subscriptionsOf(id)) {
      if (closing.has(sub.node_id) && !seen.has(sub.node_id)) {
        seen.add(sub.node_id);
        queue.push(sub.node_id);
      }
    }
  }
  // Any closing node a cycle kept BFS from reaching still gets torn down.
  for (const id of closing) if (!seen.has(id)) order.push(id);
  return order.reverse();
}

/** The inbox notice a closed node reads on its next resume. */
function cancellationLabel(isRoot: boolean, deadChildren: string[]): string {
  const who = isRoot
    ? 'You were CLOSED by the user from the canvas'
    : 'You were CANCELED — an ancestor of yours was closed from the canvas';
  if (deadChildren.length === 0) {
    return `${who}. Your pi session is preserved; this resume reopened it.`;
  }
  const names = deadChildren.slice(0, 4).map((c) => {
    const n = getNode(c);
    return n !== null ? `${n.name} (${c})` : c;
  });
  const more =
    deadChildren.length > names.length ? ` +${deadChildren.length - names.length} more` : '';
  return (
    `${who}. ${deadChildren.length} child node(s) you subscribe to were canceled with you and are no ` +
    `longer running: ${names.join(', ')}${more}. Resuming will NOT restore them — re-spawn if you ` +
    `still need that work.`
  );
}

/** Close `rootId` and its exclusive subtree. Best-effort throughout: a tmux/db
 *  failure on one node never aborts the cascade. Throws only on an unknown root
 *  so the command can surface a clean not-found error. */
export function closeNode(rootId: string): CloseNodeResult {
  if (getNode(rootId) === null) throw new Error(`closeNode: unknown node ${rootId}`);

  const closing = closingSet(rootId);
  const order = killOrder(rootId, closing);

  // Descendants reachable from the subtree but kept alive (shared managers).
  const spared: string[] = [];
  for (const id of closing) {
    for (const sub of subscriptionsOf(id)) {
      if (!closing.has(sub.node_id) && !spared.includes(sub.node_id)) {
        spared.push(sub.node_id);
      }
    }
  }

  const closed: string[] = [];

  for (const id of order) {
    try {
      const m = getNode(id);
      if (m === null) continue;

      // This node's reports that are dying with it (for the resume notice).
      const deadChildren = subscriptionsOf(id)
        .map((s) => s.node_id)
        .filter((c) => closing.has(c));

      // 1) Canceled + intent cleared BEFORE the window dies (daemon race).
      transition(id, 'cancel');

      // 2) Tear the node off its placement (pane-keyed): close any focus row it
      //    occupies, kill its PANE (the window closes once its last pane goes, so
      //    sibling nodes the user co-located in one window survive), and null its
      //    LOCATION (closing the focus row is the record — no pointer to clear).
      tearDownNode(id);

      // 3) Leave the resume notice AFTER the watcher is gone, so it survives.
      appendInbox(id, {
        from: null,
        tier: 'normal',
        kind: 'message',
        label: cancellationLabel(id === rootId, deadChildren),
        data: { reason: 'user-close', cascade_root: rootId, canceled_children: deadChildren },
      });

      // 4) Wake any SURVIVING manager subscribed to this node — the doctrine wake.
      //    A node going dormant trusts the runtime to wake it on a child's
      //    terminal outcome; D-1 found that `node close` notified ONLY the closed
      //    node itself, never its subscribers, so a parent that delegated then
      //    just stopped hangs forever when its child is closed out from under it.
      //    Only the close ROOT can have a surviving subscriber (closingSet adds a
      //    non-root node only when EVERY subscriber is itself closing), so this
      //    reaches the still-living manager(s) of a deliberately-closed child and
      //    never fires inside a self-contained cascade. Active → inbox (wakes a
      //    dormant manager via its live watcher / the daemon's dormant-revive
      //    second pass); passive → passive accumulator (delivered, not woken).
      for (const sub of subscribersOf(id)) {
        if (closing.has(sub.node_id)) continue; // also being torn down — pointless
        const notice = {
          from: id,
          tier: 'normal' as const,
          kind: 'message' as const,
          label: `Child closed — ${m.name} (${id}) was closed from the canvas and is no longer running.`,
          data: { reason: 'child-closed', child: id },
        };
        if (sub.active) appendInbox(sub.node_id, notice);
        else appendPassive(sub.node_id, notice);
      }

      closed.push(id);
    } catch {
      /* one bad node never aborts the cascade */
    }
  }

  return { root: rootId, closed, spared };
}
