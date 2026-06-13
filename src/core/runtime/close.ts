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
//   2. Tear down the broker ENGINE (the `shutdown` frame → SIGTERM fallback so
//      the broker process exits and releases the sole .jsonl writer; this also
//      ends the inbox watcher) AND proactively close the node's on-screen viewer
//      pane + registry row. The viewer teardown is explicit because attach
//      auto-reconnects: left to the socket drop alone, the viewer would sit in a
//      misleading "reconnecting…" state for ~30s on a deliberate close.
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
import { headlessBrokerHost } from './host.js';
import { tearDownNode, reapIfEmpty } from './placement.js';
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
 *  so the command can surface a clean not-found error.
 *
 *  `rootEvent` decides the ROOT's terminal status (descendants are always
 *  `cancel`led — they did not finish their own work, they were torn down with the
 *  parent):
 *    'cancel'   (default) — the node was abandoned/torn down  → canceled (⊜).
 *    'finalize'           — the user is marking it COMPLETE   → done (✓). Used by
 *      the canvas browser's `x` (close-out) action. A root already in a terminal
 *      status keeps it (finalize is only legal from a live status). */
export function closeNode(
  rootId: string,
  opts: { rootEvent?: 'cancel' | 'finalize' } = {},
): CloseNodeResult {
  if (getNode(rootId) === null) throw new Error(`closeNode: unknown node ${rootId}`);
  const rootEvent = opts.rootEvent ?? 'cancel';

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

      // Surviving managers captured BEFORE any teardown — a reap (below) deletes
      //    this node's edges, so the step-4 fan-out must read them up front.
      const survivors = subscribersOf(id).filter((s) => !closing.has(s.node_id));

      // 0) An EMPTY node (engine never produced an assistant message) is a useless
      //    shell — don't park it as a canceled husk, reap it outright (engine +
      //    viewer + row + dir). reapIfEmpty handles the teardown; when it fires we
      //    skip the cancel transition + resume notice (the node is gone) but still
      //    fan the "child gone" wake out to surviving managers below.
      if (!reapIfEmpty(id)) {
        // 1) Terminal status set BEFORE the window dies (daemon race). The root may
        //    finalize to `done` (a deliberate "mark complete" close-out); every
        //    descendant, and the root by default, `cancel`s. finalize is legal only
        //    from a live status — an already-terminal root keeps its status.
        if (id === rootId && rootEvent === 'finalize') {
          if (m.status === 'active' || m.status === 'idle') transition(id, 'finalize');
        } else {
          transition(id, 'cancel');
        }

        // 2) Tear the node's ENGINE down: send the `shutdown` frame so the broker
        //    PROCESS exits and releases the sole .jsonl writer. Then proactively
        //    close the viewer pane + registry row — attach auto-reconnects, so on a
        //    deliberate close the viewer must be torn down here or it lingers ~30s
        //    showing a misleading "reconnecting…" instead of going away at once.
        headlessBrokerHost.teardown(id);
        tearDownNode(id);

        // 3) Leave the resume notice AFTER the watcher is gone, so it survives.
        appendInbox(id, {
          from: null,
          tier: 'normal',
          kind: 'message',
          label: cancellationLabel(id === rootId, deadChildren),
          data: { reason: 'user-close', cascade_root: rootId, canceled_children: deadChildren },
        });
      }

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
      for (const sub of survivors) {
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
