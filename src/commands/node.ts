// `crtr node` — the canvas-native command surface.
//
// A node is the unit of the runtime: an agent with its own identity, context
// dir, and pi vehicle, pinned to a cwd. This subtree spawns terminal workers
// onto the canvas (`new`), inspects the graph (`inspect list|show`), and walks
// the spine (`focus`/`msg`). The push/feed half lives under `crtr push`.

import { defineLeaf, defineBranch, type BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { spawnChild, bootRoot } from '../core/runtime/spawn.js';
import { promote, requestYield } from '../core/runtime/promote.js';
import { writeYieldMessage } from '../core/runtime/kickoff.js';
import { reviveNode } from '../core/runtime/revive.js';
import { focusNodeInPlace } from '../core/runtime/presence.js';
import { demoteNode } from '../core/runtime/demote.js';
import { windowAlive, windowOfPane, currentTmux } from '../core/runtime/tmux.js';
import { appendInbox, type InboxTier } from '../core/feed/inbox.js';
import { availableKinds } from '../core/personas/index.js';
import {
  getNode,
  listNodes,
  subscribe,
  unsubscribe,
  subscriptionsOf,
  subscribersOf,
  type Mode,
  type NodeStatus,
} from '../core/canvas/index.js';

/** Validate a `--kind` against the installed personas; throws a listing InputError. */
function assertKind(kind: string): void {
  const kinds = availableKinds();
  if (!kinds.includes(kind)) {
    throw new InputError({ error: 'unknown_kind', message: `unknown kind: ${kind}`, field: 'kind', next: `Valid kinds: ${kinds.join(', ')}.` });
  }
}

// ---------------------------------------------------------------------------
// node new — spawn a terminal worker as a background window under the root
// ---------------------------------------------------------------------------

const nodeNew = defineLeaf({
  name: 'new',
  help: {
    name: 'node new',
    summary: 'spawn a terminal worker onto the canvas as a background window — returns its node id',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'First user message for the spawned node. Piped on stdin or passed as a positional.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind — match the work: explore (map/investigate a codebase), spec (write a spec), design (architect a solution), plan (break work into steps), developer (implement a change), review (validate/critique), general (anything else).' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode. Almost always base; orchestrator is reserved for promoted/resident nodes.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir the node is pinned to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name (tmux window + resume picker). Defaults to the kind.' },
      { kind: 'flag', name: 'parent', type: 'string', required: false, constraint: 'Parent node id. Defaults to the calling node (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The new node id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Display name.' },
      { name: 'window', type: 'string', required: false, constraint: 'tmux window id of the background window.' },
      { name: 'session', type: 'string', required: true, constraint: 'The shared crtr tmux session the node was placed in.' },
      { name: 'status', type: 'string', required: true, constraint: 'Always "active" on spawn.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Decision road sign for the caller: the child runs independently and its finish wakes you on its own, so never wait or poll on it — either pick up other work now or end your turn. Read it, then act.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a node under ~/.crtr/nodes/<id>/ and indexes it in canvas.db.',
      'Parent auto-subscribes (active) to the child so it is woken on the child\'s pushes.',
      'Opens a background (non-focus-stealing) tmux window running pi.',
    ],
  },
  run: async (input) => {
    const prompt = (input['prompt'] as string | undefined) ?? '';
    if (prompt.trim() === '') {
      throw new InputError({ error: 'empty_prompt', message: 'a prompt is required (stdin or positional)', next: 'Pipe a task on stdin or pass it as an argument.' });
    }
    const kind = (input['kind'] as string | undefined) ?? 'general';
    const mode = ((input['mode'] as string | undefined) ?? 'base') as Mode;
    const cwd = (input['cwd'] as string | undefined) ?? process.cwd();
    const name = input['name'] as string | undefined;
    const parent = input['parent'] as string | undefined;

    const res = spawnChild({ kind, mode, cwd, name, prompt, parent });
    return {
      node_id: res.node.node_id,
      name: res.node.name,
      window: res.window ?? undefined,
      session: res.session,
      status: res.node.status,
      follow_up:
        "Do not wait or poll on this child — there is no result to await and stopping will not strand you. You're auto-subscribed, so its finish wakes you on its own. Two moves only: pick up other independent work right now, or stop and end your turn — the wake brings you back. Sitting idle to watch it is wasted; pick one and act.",
    };
  },
  render: (r) =>
    `<spawned name="${r['name']}" id="${r['node_id']}" status="${r['status']}">\n${r['follow_up']}\n</spawned>`,
});

// ---------------------------------------------------------------------------
// node list — the active canvas (or a status slice)
// ---------------------------------------------------------------------------

const nodeList = defineLeaf({
  name: 'list',
  help: {
    name: 'node inspect list',
    summary: 'list nodes on the canvas, optionally by status',
    params: [
      { kind: 'flag', name: 'status', type: 'string', required: false, constraint: 'Filter: active | idle | done | dead. Comma-separated for several.' },
    ],
    output: [
      { name: 'nodes', type: 'object[]', required: true, constraint: 'Rows: {node_id, name, kind, mode, lifecycle, status, cwd, parent, created}.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: queries canvas.db.'],
  },
  run: async (input) => {
    const raw = input['status'] as string | undefined;
    const status = raw !== undefined && raw !== '' ? (raw.split(',').map((s) => s.trim()) as NodeStatus[]) : undefined;
    const nodes = listNodes(status !== undefined ? { status } : undefined);
    return { nodes };
  },
});

// ---------------------------------------------------------------------------
// node show — a node + its place in the spine
// ---------------------------------------------------------------------------

const nodeShow = defineLeaf({
  name: 'show',
  help: {
    name: 'node inspect show',
    summary: 'show a node\'s meta plus its subscriptions (reports) and subscribers (managers)',
    params: [
      { kind: 'positional', name: 'node', required: true, constraint: 'Node id.' },
    ],
    output: [
      { name: 'node', type: 'object', required: true, constraint: 'The node meta.' },
      { name: 'reports', type: 'object[]', required: true, constraint: 'Who this node subscribes to (its reports/down).' },
      { name: 'managers', type: 'object[]', required: true, constraint: 'Who subscribes to this node (its managers/up).' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads the node meta + canvas.db edges.'],
  },
  run: async (input) => {
    const id = input['node'] as string;
    const node = getNode(id);
    if (node === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    }
    return { node, reports: subscriptionsOf(id), managers: subscribersOf(id) };
  },
});

// ---------------------------------------------------------------------------
// node inspect — read the graph (list + show)
// ---------------------------------------------------------------------------

const nodeInspect = defineBranch({
  name: 'inspect',
  help: {
    name: 'node inspect',
    summary: 'read the canvas graph — enumerate nodes or inspect one with its spine neighbors',
    children: [
      { name: 'list', desc: 'list nodes on the canvas', useWhen: 'surveying what exists' },
      { name: 'show', desc: 'show a node + its spine neighbors', useWhen: 'inspecting one node' },
    ],
  },
  children: [nodeList, nodeShow],
});

// ---------------------------------------------------------------------------
// node focus — bring a node's window forefront (across roots if needed)
// ---------------------------------------------------------------------------

const nodeFocus = defineLeaf({
  name: 'focus',
  help: {
    name: 'node focus',
    summary: 'bring a node into your CURRENT pane in place (swap-pane) — the agent appears where you are instead of navigating you to its window',
    params: [
      { kind: 'positional', name: 'node', required: true, constraint: 'Node id to focus.' },
    ],
    output: [
      { name: 'focused', type: 'boolean', required: true, constraint: 'True when the node was brought into view.' },
      { name: 'session', type: 'string', required: false, constraint: 'The tmux session the node lives in.' },
      { name: 'revived', type: 'boolean', required: true, constraint: 'True when a dormant node was revived to be focused.' },
      { name: 'in_place', type: 'boolean', required: true, constraint: 'True when the node was swapped into the caller pane; false when it fell back to window focus (no caller pane).' },
    ],
    outputKind: 'object',
    effects: ['Swaps the node\'s pane into the caller\'s current pane (tmux swap-pane -d) and updates the focus pointer.', 'Falls back to select-window (+ switch-client across roots) when there is no caller pane.', 'Revives a dormant node (resume) if it has no live window, then focuses it.'],
  },
  run: async (input) => {
    const id = input['node'] as string;
    const node = getNode(id);
    if (node === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    // A dormant node (done/dead/window released) has no live window — revive it
    // (resume the saved conversation) so there is something to focus.
    let revived = false;
    if (!windowAlive(node.tmux_session, node.window)) {
      try { reviveNode(id, { resume: true }); revived = true; } catch { /* fall through; focus reports focused:false */ }
    }
    const res = focusNodeInPlace(id);
    return { focused: res.focused, session: res.session, revived, in_place: res.inPlace };
  },
});

// ---------------------------------------------------------------------------
// node demote — detach the agent in your pane to the background session
// ---------------------------------------------------------------------------

/** First live node whose window id is `win` (each node owns one window). The
 *  queryable row projection omits `window`, so resolve full meta per candidate. */
function nodeByWindow(win: string): string | undefined {
  for (const row of listNodes({ status: ['active', 'idle'] })) {
    if (getNode(row.node_id)?.window === win) return row.node_id;
  }
  return undefined;
}

/** The live node occupying a tmux pane (pane → window → node), or undefined.
 *  Defaults to $TMUX_PANE / the caller's current pane when `pane` is omitted —
 *  shared by `node demote` and `node cycle`, both of which act on "the agent in
 *  front of you". */
function nodeInPane(pane?: string): string | undefined {
  const resolvePane = pane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  const win = resolvePane !== undefined && resolvePane !== '' ? windowOfPane(resolvePane) : null;
  return win !== null ? nodeByWindow(win) : undefined;
}

const nodeDemote = defineLeaf({
  name: 'demote',
  help: {
    name: 'node demote',
    summary: 'finish the agent in your current pane and recycle the pane — push its last message as a final report to everyone waiting on it, mark it done, then boot a fresh crtr root in the same pane',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to finish. Defaults to the node occupying --pane (or your current pane).' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id to recycle. Defaults to $TMUX_PANE / your current pane. The Alt+C menu passes this for you.' },
    ],
    output: [
      { name: 'demoted', type: 'boolean', required: true, constraint: 'True when the pane was recycled into a fresh root.' },
      { name: 'node_id', type: 'string', required: false, constraint: 'The finished node.' },
      { name: 'finalized', type: 'boolean', required: false, constraint: 'True when a final report was pushed to its subscribers.' },
      { name: 'delivered', type: 'number', required: false, constraint: 'How many subscribers/managers received the final report.' },
      { name: 'new_root', type: 'string', required: false, constraint: 'The fresh root node booted into the pane.' },
    ],
    outputKind: 'object',
    effects: ['Pushes a final report from the node (fans out to all subscribers) and marks it done.', 'Kills the agent\'s pi and respawns a fresh resident root in the same tmux pane.'],
  },
  run: async (input) => {
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    let id = input['node'] as string | undefined;
    if (id === undefined || id === '') {
      // Derive the node from the pane: which node's window holds it?
      id = nodeInPane(pane);
    }
    if (id === undefined || id === '') {
      throw new InputError({ error: 'no_node', message: 'no node found in this pane to finish', next: 'Pass --node <id>, or run from inside the agent\'s pane.' });
    }
    if (getNode(id) === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    }
    const res = await demoteNode(id, pane);
    return { demoted: res.demoted, node_id: id, finalized: res.finalized, delivered: res.delivered.length, new_root: res.newRoot ?? undefined };
  },
  render: (r) =>
    r['demoted'] === true
      ? `<demoted id="${r['node_id']}" finalized="${r['finalized']}" delivered="${r['delivered']}" new_root="${r['new_root'] ?? ''}"/>`
      : `<demote-failed id="${r['node_id'] ?? ''}">not in tmux, or no agent in this pane</demote-failed>`,
});

// ---------------------------------------------------------------------------
// node cycle — DFS-walk the canvas one window at a time (Alt+] / Alt+[)
// ---------------------------------------------------------------------------

/** Every live node in DFS pre-order across the whole forest. The spawn tree is
 *  the `parent` field; children inherit their parent's row order (created), so
 *  the walk descends into a node's children before moving to its siblings —
 *  exactly "next in pre-order is your first child". Roots are live nodes with no
 *  live parent (a done/dead parent orphans its live children up to the top).
 *  Cycle-safe: a final pass appends any node a cycle kept from being reached. */
function liveDfsOrder(): string[] {
  const rows = listNodes({ status: ['active', 'idle'] }); // ORDER BY created
  const liveIds = new Set(rows.map((r) => r.node_id));
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.parent;
    if (p != null && liveIds.has(p)) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(r.node_id);
      childrenOf.set(p, arr);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) visit(c);
  };
  for (const r of rows) if (r.parent == null || !liveIds.has(r.parent)) visit(r.node_id);
  for (const r of rows) visit(r.node_id); // stragglers (parent cycles)
  return out;
}

const nodeCycle = defineLeaf({
  name: 'cycle',
  help: {
    name: 'node cycle',
    summary:
      'focus the next/previous live node in DFS pre-order — the canvas walked one window at a time, descending into a node\'s children before its siblings (bound to Alt+] forward / Alt+[ back)',
    params: [
      { kind: 'flag', name: 'dir', type: 'enum', choices: ['next', 'prev'], required: false, default: 'next', constraint: 'Direction along the pre-order: next (Alt+], rightward/deeper into children) or prev (Alt+[, back). Wraps at the ends.' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane to cycle FROM. Defaults to $TMUX_PANE / your current pane. The Alt+] / Alt+[ bindings pass this for you.' },
    ],
    output: [
      { name: 'focused', type: 'boolean', required: true, constraint: 'True when the neighbor was brought into view.' },
      { name: 'node_id', type: 'string', required: false, constraint: 'The node now in front of you.' },
      { name: 'name', type: 'string', required: false, constraint: 'Its display name.' },
      { name: 'from', type: 'string', required: false, constraint: 'The node you cycled away from.' },
    ],
    outputKind: 'object',
    effects: ['Swaps the neighbor\'s pane into the caller pane (like `node focus`); the node you were viewing drops to the background.', 'Revives the neighbor first if its window was released.'],
  },
  run: async (input) => {
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane ?? undefined;
    const dir = ((input['dir'] as string | undefined) ?? 'next') as 'next' | 'prev';

    const fromId = nodeInPane(pane);
    if (fromId === undefined) return { focused: false };

    const order = liveDfsOrder();
    const i = order.indexOf(fromId);
    if (i === -1 || order.length < 2) return { focused: false, node_id: fromId, from: fromId };

    const step = dir === 'next' ? 1 : -1;
    const targetId = order[(i + step + order.length) % order.length] as string;
    const target = getNode(targetId);
    if (target === null) return { focused: false, from: fromId };

    // A live node may have had its window released — revive (resume) so there is
    // a window to swap in, mirroring `node focus`.
    if (!windowAlive(target.tmux_session, target.window)) {
      try { reviveNode(targetId, { resume: true }); } catch { /* fall through */ }
    }
    const res = focusNodeInPlace(targetId, pane, fromId);
    return { focused: res.focused, node_id: targetId, name: target.name, from: fromId };
  },
  render: (r) =>
    r['focused'] === true
      ? `<cycled to="${r['node_id']}" name="${r['name'] ?? ''}" from="${r['from'] ?? ''}"/>`
      : `<cycle-noop>no other live node to focus</cycle-noop>`,
});

// ---------------------------------------------------------------------------
// node session — boot a NEW root in its own tmux session (the explicit form)
// ---------------------------------------------------------------------------

const nodeSession = defineLeaf({
  name: 'session',
  help: {
    name: 'node session',
    summary: 'start a fresh root node as its own window in the shared crtr session (use from inside a node to start a new root without taking your pane)',
    params: [
      { kind: 'stdin', name: 'prompt', required: false, constraint: 'Optional starter prompt; a root needs none.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind for the root.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir to pin the root to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The root node id.' },
      { name: 'session', type: 'string', required: true, constraint: 'The shared crtr tmux session this root\'s window was placed in.' },
      { name: 'window', type: 'string', required: false, constraint: 'The root node\'s window id.' },
    ],
    outputKind: 'object',
    effects: ['Opens a detached window in the shared crtr session and runs pi in it as a resident root node.'],
  },
  run: async (input) => {
    const prompt = input['prompt'] as string | undefined;
    const kind = (input['kind'] as string | undefined) ?? 'general';
    const cwd = (input['cwd'] as string | undefined) ?? process.cwd();
    const name = input['name'] as string | undefined;
    const meta = bootRoot({ cwd, kind, name, prompt, placement: 'session' });
    return { node_id: meta.node_id, session: meta.tmux_session ?? '', window: meta.window ?? undefined };
  },
});

// ---------------------------------------------------------------------------
// node msg — direct-address any node at a wake tier (wakes a dormant target)
// ---------------------------------------------------------------------------

const nodeMsg = defineLeaf({
  name: 'msg',
  help: {
    name: 'node msg',
    summary: 'send a direct message to any node\'s inbox at a wake tier — a direct message wakes the node regardless of subscriptions (reviving it if dormant)',
    params: [
      { kind: 'positional', name: 'node', required: true, constraint: 'Target node id.' },
      { kind: 'stdin', name: 'body', required: true, constraint: 'Message body. Positional (after the node id is consumed) or stdin.' },
      { kind: 'flag', name: 'tier', type: 'enum', choices: ['critical', 'urgent', 'normal', 'deferred'], required: false, default: 'normal', constraint: 'How it lands: critical = interrupt + new turn; urgent = steer mid-turn; normal = follow-up; deferred = read on next cycle.' },
    ],
    output: [
      { name: 'delivered', type: 'boolean', required: true, constraint: 'True when the message was appended to the target inbox.' },
      { name: 'node_id', type: 'string', required: true, constraint: 'Target node.' },
      { name: 'woke', type: 'boolean', required: true, constraint: 'True when a dormant target was revived to receive it.' },
    ],
    outputKind: 'object',
    effects: ['Appends a message entry to the target inbox.jsonl.', 'Revives the target (resume) if it has no live window.'],
  },
  run: async (input) => {
    const id = input['node'] as string;
    const target = getNode(id);
    if (target === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    const body = ((input['body'] as string | undefined) ?? '').trim();
    if (body === '') throw new InputError({ error: 'empty_body', message: 'a message body is required', field: 'body', next: 'Pass the message after the node id or on stdin.' });
    const tier = ((input['tier'] as string | undefined) ?? 'normal') as InboxTier;
    const from = process.env['CRTR_NODE_ID'] ?? 'human';

    appendInbox(id, { from, tier, kind: 'message', label: body.split('\n')[0]!.slice(0, 120), data: { body } });

    // A direct message wakes any node: if the target has no live window
    // (done/dead/idle-released), revive it so its inbox-watcher delivers this.
    let woke = false;
    if (!windowAlive(target.tmux_session, target.window)) {
      try { reviveNode(id, { resume: true }); woke = true; } catch { /* best-effort wake */ }
    }
    return { delivered: true, node_id: id, woke };
  },
});

// ---------------------------------------------------------------------------
// node subscribe / unsubscribe — wire the subscribes_to spine between any pair
// ---------------------------------------------------------------------------

/** Resolve the subscriber: explicit --subscriber wins, else the calling node. */
function resolveSubscriber(input: Record<string, unknown>): string {
  const sub = (input['subscriber'] as string | undefined) ?? process.env['CRTR_NODE_ID'];
  if (sub === undefined || sub === '') {
    throw new InputError({ error: 'no_subscriber', message: 'no subscriber (set CRTR_NODE_ID or pass --subscriber)', field: 'subscriber', next: 'Run from inside a node, or pass --subscriber <id>.' });
  }
  return sub;
}

const nodeSubscribe = defineLeaf({
  name: 'subscribe',
  help: {
    name: 'node subscribe',
    summary: 'wire a subscribes_to edge so one node receives another\'s pushes — the subscriber can be you (default) or, with --subscriber, ANY node, to ANY publisher. Re-running flips an existing edge\'s active/passive mode.',
    params: [
      { kind: 'positional', name: 'publisher', required: true, constraint: 'The node to subscribe TO — whose pushes get delivered to the subscriber.' },
      { kind: 'flag', name: 'subscriber', type: 'string', required: false, constraint: 'Who receives the pushes. Defaults to the calling node (CRTR_NODE_ID). Pass any node id to wire a third party.' },
      { kind: 'flag', name: 'passive', type: 'bool', required: false, constraint: 'Passive subscription: pushes ACCUMULATE without waking the subscriber, then auto-inject as timestamped XML pre-text on its next message. Omit for an active (wake-on-push) subscription.' },
    ],
    output: [
      { name: 'subscribed', type: 'boolean', required: true, constraint: 'True when the edge was created/updated.' },
      { name: 'subscriber', type: 'string', required: true, constraint: 'The receiving node.' },
      { name: 'publisher', type: 'string', required: true, constraint: 'The node being subscribed to.' },
      { name: 'mode', type: 'string', required: true, constraint: '"active" (wakes on push) or "passive" (accumulates, no wake).' },
    ],
    outputKind: 'object',
    effects: ['Upserts a subscribes_to edge in canvas.db (active flag set from --passive).', 'Passive edges never wake the subscriber and do not hold it alive (excluded from the stop-guard).'],
  },
  run: async (input) => {
    const publisher = input['publisher'] as string;
    const subscriber = resolveSubscriber(input);
    const passive = input['passive'] === true;
    if (subscriber === publisher) {
      throw new InputError({ error: 'self_subscribe', message: 'a node cannot subscribe to itself', next: 'Pick a different publisher.' });
    }
    if (getNode(subscriber) === null) throw new InputError({ error: 'not_found', message: `no node: ${subscriber}`, field: 'subscriber', next: 'List nodes with `crtr node inspect list`.' });
    if (getNode(publisher) === null) throw new InputError({ error: 'not_found', message: `no node: ${publisher}`, field: 'publisher', next: 'List nodes with `crtr node inspect list`.' });
    subscribe(subscriber, publisher, !passive);
    return { subscribed: true, subscriber, publisher, mode: passive ? 'passive' : 'active' };
  },
  render: (r) =>
    `<subscribed subscriber="${r['subscriber']}" publisher="${r['publisher']}" mode="${r['mode']}"/>`,
});

const nodeUnsubscribe = defineLeaf({
  name: 'unsubscribe',
  help: {
    name: 'node unsubscribe',
    summary: 'drop a subscribes_to edge — the subscriber (you by default, or any node via --subscriber) stops receiving the publisher\'s pushes.',
    params: [
      { kind: 'positional', name: 'publisher', required: true, constraint: 'The node to stop subscribing to.' },
      { kind: 'flag', name: 'subscriber', type: 'string', required: false, constraint: 'Who to detach. Defaults to the calling node (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'unsubscribed', type: 'boolean', required: true, constraint: 'True when the edge was removed (idempotent — also true if none existed).' },
      { name: 'subscriber', type: 'string', required: true, constraint: 'The detached node.' },
      { name: 'publisher', type: 'string', required: true, constraint: 'The node it stopped subscribing to.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the subscribes_to edge from canvas.db.'],
  },
  run: async (input) => {
    const publisher = input['publisher'] as string;
    const subscriber = resolveSubscriber(input);
    unsubscribe(subscriber, publisher);
    return { unsubscribed: true, subscriber, publisher };
  },
  render: (r) => `<unsubscribed subscriber="${r['subscriber']}" publisher="${r['publisher']}"/>`,
});

// ---------------------------------------------------------------------------
// node promote — become a resident orchestrator (terminal → resident polymorph)
// ---------------------------------------------------------------------------

const nodePromote = defineLeaf({
  name: 'promote',
  help: {
    name: 'node promote',
    summary: 'promote yourself to a resident orchestrator — do this when your task outgrows one context window (many phases to delegate and persist across refreshes); not for work that fits one window, and not merely because you spawned a child',
    params: [
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'Specialize as this kind of orchestrator: developer (own feature delivery), review, spec, design, plan, explore, general. Defaults to your current kind. Promoting from a generic kind? CHOOSE a concrete one — it sets the orchestrator persona you revive into.' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to promote. Defaults to the caller (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The promoted node.' },
      { name: 'kind', type: 'string', required: true, constraint: 'The kind it now orchestrates as.' },
      { name: 'mode', type: 'string', required: true, constraint: 'Now "orchestrator".' },
      { name: 'roadmap_written', type: 'boolean', required: true, constraint: 'True if a roadmap scaffold was seeded by this call.' },
      { name: 'roadmap_path', type: 'string', required: true, constraint: 'Absolute path to your roadmap doc (context/roadmap.md) — edit it to author your plan.' },
      { name: 'goal_path', type: 'string', required: true, constraint: 'Absolute path to your goal doc (context/initial-prompt.md) — the mandate you were spawned with.' },
      { name: 'guidance', type: 'string', required: true, constraint: 'Instructions for your new role — read and act on them this turn.' },
    ],
    outputKind: 'object',
    effects: ['Flips lifecycle→resident, mode→orchestrator, kind→chosen; rewrites the launch spec to that kind\'s orchestrator persona; seeds context/roadmap.md scaffold if absent.'],
  },
  run: async (input) => {
    const id = (input['node'] as string | undefined) ?? process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node to promote (set CRTR_NODE_ID or pass --node)', next: 'Run from inside a node, or pass --node <id>.' });
    const kind = input['kind'] as string | undefined;
    if (kind !== undefined) assertKind(kind);
    const res = promote(id, kind !== undefined ? { kind } : {});
    return { node_id: res.meta.node_id, kind: res.meta.kind, mode: res.meta.mode, roadmap_written: res.roadmapWritten, roadmap_path: res.roadmapPath, goal_path: res.goalPath, guidance: res.guidance };
  },
});

// ---------------------------------------------------------------------------
// node yield — refresh: discard context, revive fresh against the roadmap
// ---------------------------------------------------------------------------

const nodeYield = defineLeaf({
  name: 'yield',
  help: {
    name: 'node yield',
    summary: 'request a context refresh — you will be respawned fresh against your roadmap on your next stop (a terminal node auto-promotes to resident first)',
    params: [
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'If this yield auto-promotes a terminal node, specialize it as this kind of orchestrator (developer, review, spec, design, plan, explore, general). Defaults to your current kind.' },
      { kind: 'stdin', name: 'message', required: false, constraint: 'A short note to your future self — what to do (if anything) the moment you wake fresh. Surfaced as <yield-message> in the next revive. Pass as a positional or pipe via heredoc.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The yielding node.' },
      { name: 'promoted', type: 'boolean', required: true, constraint: 'True if this yield promoted a terminal node to resident.' },
      { name: 'will_refresh', type: 'boolean', required: true, constraint: 'Always true: end your turn and you will revive fresh against your roadmap.' },
    ],
    outputKind: 'object',
    effects: ['Sets intent=refresh; the stophook shuts the process down on next stop and the daemon revives it fresh.'],
  },
  run: async (input) => {
    const id = process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node to yield (CRTR_NODE_ID unset)', next: 'Run from inside a node.' });
    const kind = input['kind'] as string | undefined;
    if (kind !== undefined) assertKind(kind);
    const message = typeof input['message'] === 'string' ? (input['message'] as string).trim() : '';
    if (message !== '') writeYieldMessage(id, message);
    const res = requestYield(id, kind !== undefined ? { kind } : {});
    return { node_id: res.meta.node_id, promoted: res.promoted, will_refresh: res.willRefresh };
  },
});

export function registerNode(): BranchDef {
  return defineBranch({
    name: 'node',
    rootEntry: {
      concept: 'a unit of the agent runtime — an agent on the canvas with its own context dir and pi vehicle. Spawning nodes is how work gets done here, not an optimization you reach for late',
      desc: 'spawn, inspect, and navigate nodes on the canvas',
      useWhen:
        'delegating work, or walking the subscription graph. CRITICAL, and your default reflex — spawning a child is the first move on almost any task, not a fallback. Your own context window is the scarce resource: before you read files into it to understand, implement, debug, or change code you do not already know, hand that to a fresh node and get back just the conclusion (`crtr node new "<task>" --kind <explore|spec|design|plan|developer|review>`). Keep inline only a fact you already know. Fan out independent units as CONCURRENT children — a wake with idle workers is wasted; serialize only true dependencies, and never let two live children edit the same files. Once you delegate a unit, do not also run it yourself: you auto-subscribe on spawn, so its finish wakes you. Spawn + collect mechanics: `crtr node -h`.',
    },
    help: {
      name: 'node',
      summary: 'spawn and navigate canvas nodes',
      model:
        'Every agent is a node in one directed graph (the canvas); `subscribes_to` is the spine — spawn a child and you auto-subscribe (active) to it, so its finish wakes you.\n\n' +
        'WHEN TO DELEGATE: hand any self-contained unit of work to a child instead of doing it inline — it keeps your own context window (your scarce resource) free for steering. Spawn independent units in PARALLEL; a wake with idle workers is wasted. Serialize only true dependencies, and never let two live children edit the same files.\n\n' +
        'HOW: `crtr node new "<task>" --kind <kind>` returns a node id immediately and runs the worker in a background window. Match the kind to the work (see `node new -h`). You are woken when a child finishes; absorb what your children reported with `crtr feed read` (coalesced pointers — dereference the report paths that matter, don\'t act on a one-line summary). Integrate, then either delegate the next units or finish.\n\n' +
        'FINISH: a worker ends its own work with `crtr push final "<result>"` (writes the canonical result, marks done, closes the window) — stopping without it is not finishing. For a job too big for one context window, `node promote` to a resident orchestrator (holds a roadmap, delegates phases); when context fills, `node yield` to refresh against that roadmap.',
      children: [
        { name: 'new', desc: 'spawn a terminal worker as a background window', useWhen: 'delegating a self-contained unit of work', tier: 'important' },
        { name: 'inspect', desc: 'read the graph (list nodes / show one)', useWhen: 'surveying the canvas or inspecting a node' },
        { name: 'focus', desc: 'bring a node window forefront', useWhen: 'jumping to a node to watch or steer it' },
        { name: 'cycle', desc: 'DFS-walk to the next/prev live node in place', useWhen: 'sweeping the canvas one window at a time (Alt+] forward / Alt+[ back)' },
        { name: 'demote', desc: 'finish the agent in your pane + recycle it into a fresh root', useWhen: 'wrapping up the agent in front of you and starting fresh (Alt+C → d)' },
        { name: 'session', desc: 'open a fresh root in its own tmux session', useWhen: 'starting a new top-level session from inside a node' },
        { name: 'msg', desc: 'direct-message any node at a wake tier', useWhen: 'steering or pinging a specific node (wakes it)' },
        { name: 'subscribe', desc: 'wire a subscribes_to edge between any pair (active or --passive)', useWhen: 'making a node (you or another) receive another node\'s pushes' },
        { name: 'unsubscribe', desc: 'drop a subscribes_to edge', useWhen: 'detaching a subscriber from a publisher' },
        { name: 'promote', desc: 'become a resident orchestrator of a chosen kind', useWhen: 'your task is bigger than one context window and you must delegate + persist', tier: 'important' },
        { name: 'yield', desc: 'refresh your context against your roadmap', useWhen: 'your context window is filling up' },
      ],
    },
    children: [nodeNew, nodeInspect, nodeFocus, nodeCycle, nodeDemote, nodeSession, nodeMsg, nodeSubscribe, nodeUnsubscribe, nodePromote, nodeYield],
  });
}
