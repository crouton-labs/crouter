// `crtr node` — the canvas-native command surface.
//
// A node is the unit of the runtime: an agent with its own identity, context
// dir, and pi vehicle, pinned to a cwd. This subtree spawns terminal workers
// onto the canvas (`new`), inspects the graph (`inspect list|show`), and walks
// the spine (`focus`/`msg`). The push/feed half lives under `crtr push`.

import { defineLeaf, defineBranch, type BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { spawnChild } from '../core/runtime/spawn.js';
import { promote, requestYield } from '../core/runtime/promote.js';
import { writeYieldMessage } from '../core/runtime/kickoff.js';
import { reviveNode } from '../core/runtime/revive.js';

import { demoteNode } from '../core/runtime/demote.js';
import { detachToBackground, focus as placementFocus } from '../core/runtime/placement.js';
import { buildLaunchSpec } from '../core/runtime/launch.js';
import { closeNode } from '../core/runtime/close.js';
import { windowAlive, windowOfPane, currentTmux } from '../core/runtime/tmux.js';
import { appendInbox, type InboxTier } from '../core/feed/inbox.js';
import { availableKinds } from '../core/personas/index.js';
import {
  getNode,
  updateNode,
  listNodes,
  subscribe,
  unsubscribe,
  subscriptionsOf,
  subscribersOf,
  readContextTokens,
  type Mode,
  type Lifecycle,
  type NodeStatus,
} from '../core/canvas/index.js';

// Past this much context, an ORCHESTRATOR that spawns a managed child is better
// off yielding than holding its fat window open for the child's result: the
// child's finish revives it fresh against its roadmap, so a clean window absorbs
// the result instead of this bloated one. Below the steering bands (130k+) on
// purpose — catch it at spawn, before the window is critically full.
const YIELD_NUDGE_THRESHOLD = 100_000;

const STD_CHILD_FOLLOW_UP =
  "Do not wait or poll on this child — there is no result to await and stopping will not strand you. You're auto-subscribed, so its finish wakes you on its own. Two moves only: continue other independent work right now, or stop and end your turn — the wake brings you back.";

/** Decision road sign for a managed (non-root) child. Normally STD_CHILD_FOLLOW_UP,
 *  but when the SPAWNER is an orchestrator whose context has already grown past
 *  YIELD_NUDGE_THRESHOLD, steer it to yield now and let its fresh revive handle
 *  the child's result. */
export function childFollowUp(spawnerId: string | undefined): string {
  if (spawnerId === undefined || spawnerId === '') return STD_CHILD_FOLLOW_UP;
  const spawner = getNode(spawnerId);
  if (spawner === null || spawner.mode !== 'orchestrator') return STD_CHILD_FOLLOW_UP;
  const ctxTokens = readContextTokens(spawnerId);
  if (ctxTokens === null || ctxTokens < YIELD_NUDGE_THRESHOLD) return STD_CHILD_FOLLOW_UP;
  const k = Math.round(ctxTokens / 1000);
  return `Child spawned — you're auto-subscribed, so its finish wakes you on its own; never wait or poll. But you're an orchestrator already carrying ~${k}k of context: rather than hold this window open for the result, checkpoint context/roadmap.md and \`crtr node yield\` now. Yielding ends this turn, and the child's completion then revives you fresh against your roadmap — let that clean revive absorb the result instead of this bloated context.`;
}

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
  description: 'spawn a node — a managed child (default), or an independent root with --root',
  whenToUse: 'you have a self-contained unit of work — reach for this instead of doing it inline, so the reading and the tokens land in a fresh window and only the conclusion comes back: mapping an unfamiliar part of the codebase, writing a spec, designing an approach, breaking a job into a plan, implementing a change, or running a review. Match `--kind` to the work (explore/spec/design/plan/developer/review/general) and fan independent units out as concurrent children. Default is a managed child you auto-subscribe to, so its finish wakes you; pass `--mode orchestrator` when the unit is itself too big for one window (e.g. a large multi-area review) so it boots as a sub-orchestrator with its own roadmap instead of a base worker you hope promotes itself; pass `--root` to hand off an INDEPENDENT node you neither manage nor get woken by (e.g. one a human will sit and drive), not for ordinary delegation',
  tier: 'important',
  help: {
    name: 'node new',
    summary: 'spawn a terminal worker onto the canvas as a background window — returns its node id',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'First user message for the spawned node. Piped on stdin or passed as a positional.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind — match the work: explore (map/investigate a codebase), spec (write a spec), design (architect a solution), plan (break work into steps), developer (implement a change), review (validate/critique), general (anything else).' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode. base for a worker that finishes in one window; orchestrator to create the child directly as a sub-orchestrator (it boots with the orchestrator persona + a seeded roadmap and fans its scope out) — use it when the unit is too large for one window, e.g. a big review, instead of spawning a base worker and counting on it to promote itself.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir the node is pinned to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name (tmux window + resume picker). Defaults to the kind.' },
      { kind: 'flag', name: 'parent', type: 'string', required: false, constraint: 'Parent node id. Defaults to the calling node (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'root', type: 'bool', required: false, constraint: 'Spawn an INDEPENDENT root instead of a managed child: no parent (top-level on the canvas), NO subscription back to you (you are NOT woken by it), resident lifecycle. It records spawned_by=you for provenance and is brought forefront so it can be driven directly. Use for a node you hand off and do not manage (e.g. a sub-orchestrator a human will discuss with).' },
      { kind: 'flag', name: 'fork-from', type: 'string', required: false, constraint: 'FORK the new node from an existing pi conversation instead of starting it fresh: pass a node id (forks from that node\'s session), an absolute session `.jsonl` path, or a partial pi session uuid. pi copies that whole history into a NEW session for the child (the source is untouched), then the prompt is delivered as the next message — i.e. the child wakes up as a continuation of that conversation. Use to branch exploratory work off a node that already built up the context you need, instead of re-deriving it. One-shot at birth: the fork resumes its own session thereafter.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The new node id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Display name.' },
      { name: 'window', type: 'string', required: false, constraint: 'tmux window id of the background window.' },
      { name: 'session', type: 'string', required: true, constraint: 'The tmux session the node was placed in — the shared crtr session for a child; your current session for an in-tmux --root.' },
      { name: 'status', type: 'string', required: true, constraint: 'Always "active" on spawn.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Decision road sign for the caller: the child runs independently and its finish wakes you on its own, so never wait or poll on it — either pick up other work now or end your turn. If you are an orchestrator already deep in context (>100k), it instead steers you to `crtr node yield` now so your fresh revive absorbs the child\'s result. Read it, then act.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a node under ~/.crtr/nodes/<id>/ and indexes it in canvas.db.',
      'Default (managed child): parent auto-subscribes (active) and is woken on the child\'s pushes. With --root: no subscription — records a spawned_by edge for provenance only.',
      'Opens a tmux window running pi: a background (non-focus-stealing) window in the shared crtr session for a child; with --root, a new window in your current session (in-tmux) or the shared session (outside tmux), with the client switched to it.',
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
    const root = input['root'] === true;
    const forkFrom = input['forkFrom'] as string | undefined;

    const res = spawnChild({ kind, mode, cwd, name, prompt, parent, root, forkFrom });
    return {
      node_id: res.node.node_id,
      name: res.node.name,
      window: res.window ?? undefined,
      session: res.session,
      status: res.node.status,
      follow_up: root
        ? "Independent root spawned — it is NOT under you. You are not subscribed, so its finish will NOT wake you and it does not hold you alive; it carries spawned_by=you for lineage only. It opened in its own window and the client was switched to it so it can be driven directly. Hand it off and move on — you will not be notified of its progress."
        : childFollowUp(parent ?? process.env['CRTR_NODE_ID']),
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
  description: 'list nodes on the canvas',
  whenToUse: 'you want a flat roster of the nodes on the canvas, optionally sliced by status (active/idle/done/dead/canceled): a quick read of what exists and what is still running. Use `node inspect show` instead to drill into one node and its spine neighbors, `canvas dashboard` for the tree SHAPE, and `canvas attention` to find which nodes are blocked on a human',
  help: {
    name: 'node inspect list',
    summary: 'list nodes on the canvas, optionally by status',
    params: [
      { kind: 'flag', name: 'status', type: 'string', required: false, constraint: 'Filter: active | idle | done | dead | canceled. Comma-separated for several.' },
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
  description: 'show a node + its spine neighbors',
  whenToUse: 'you want one node in depth: its meta plus its spine neighbors — who it reports to (subscriptions) and who manages it (subscribers). Use `node inspect list` instead for the flat roster of every node, or `canvas dashboard` to see the whole-tree shape',
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
  description: 'read the graph (list nodes / show one)',
  whenToUse: 'reading the graph: enumerate the nodes on the canvas (`list`) or drill into one and its spine neighbors (`show`). Use `canvas dashboard` instead to render the tree SHAPE, or `canvas attention` to find which nodes are blocked on a human',
  help: {
    name: 'node inspect',
    summary: 'read the canvas graph — enumerate nodes or inspect one with its spine neighbors',
  },
  children: [nodeList, nodeShow],
});

// ---------------------------------------------------------------------------
// node focus — bring a node's window forefront (across roots if needed)
// ---------------------------------------------------------------------------

const nodeFocus = defineLeaf({
  name: 'focus',
  description: 'bring a node window forefront',
  whenToUse: 'you want to bring a specific node into view — swapped into your current pane — to watch or steer it directly, reviving it first if dormant. Use `node cycle` instead to walk neighbors one window at a time rather than jump to a named node, and `node msg` to steer a node without leaving where you are',
  help: {
    name: 'node focus',
    summary: 'bring a node into your CURRENT pane in place (swap-pane) — the agent appears where you are instead of navigating you to its window',
    params: [
      { kind: 'positional', name: 'node', required: true, constraint: 'Node id to focus.' },
      { kind: 'flag', name: 'new-pane', type: 'bool', required: false, constraint: 'Open the node in a NEW viewport SIDE-BY-SIDE with your current pane (a second focus) instead of swapping it into your pane. Two agents on screen at once (F4).' },
    ],
    output: [
      { name: 'focused', type: 'boolean', required: true, constraint: 'True when the node was brought into view.' },
      { name: 'session', type: 'string', required: false, constraint: 'The tmux session the node lives in.' },
      { name: 'revived', type: 'boolean', required: true, constraint: 'True when a dormant node was revived to be focused.' },
      { name: 'in_place', type: 'boolean', required: true, constraint: 'True when the node was swapped into the caller pane; false when it fell back to window focus (no caller pane).' },
    ],
    outputKind: 'object',
    effects: ['Swaps the node\'s pane into the caller\'s current pane (tmux swap-pane -d) and retargets the caller\'s focus to it (focus pointer updated).', 'With --new-pane: splits a new viewport beside the caller (a second live focus) instead of swapping in place.', 'Revives a dormant node (resume) into the backstage if it has no live pane, then swaps it into the focus.'],
  },
  run: async (input) => {
    const id = input['node'] as string;
    const node = getNode(id);
    if (node === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    // Placement owns the whole act (§2.3): resolve the caller's focus (or open a
    // new viewport with --new-pane), revive the target into the backstage if it
    // is dormant, then hot-swap it onto the focus. The reviver is injected so
    // placement need not import revive.ts.
    const res = placementFocus(id, {
      newPane: input['newPane'] === true,
      callerNode: process.env['CRTR_NODE_ID'],
      revive: (nid) => { reviveNode(nid, { resume: true }); },
    });
    return { focused: res.focused, session: res.session, revived: res.revived, in_place: res.inPlace };
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
 *  front of you". Exported for the `canvas chord` / `canvas tmux-spread` leaves,
 *  which resolve the active pane's node the same way. */
export function nodeInPane(pane?: string): string | undefined {
  const resolvePane = pane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  const win = resolvePane !== undefined && resolvePane !== '' ? windowOfPane(resolvePane) : null;
  return win !== null ? nodeByWindow(win) : undefined;
}

const nodeDemote = defineLeaf({
  name: 'demote',
  description: 'finish the agent in your pane + recycle it into a fresh root',
  whenToUse: 'you are at an agent\'s pane and done with it: finish it cleanly and recycle the pane in one move — push its last message as a final report to everyone waiting on it, mark it done, then boot a fresh crtr root in the same pane to keep working. The human-driver way to end an agent and immediately start over in place. Use `node close` instead to tear a node and its subtree down WITHOUT finishing (no report, revivable), and `push final` when the agent should finish ITSELF from inside its own turn',
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
// node close — close a node + cascade-cancel its exclusive subtree (Alt+C → x)
// ---------------------------------------------------------------------------

const nodeClose = defineLeaf({
  name: 'close',
  description: 'close a node + cascade-cancel its exclusive subtree (revivable)',
  whenToUse: 'you want to tear a node down WITHOUT finishing it, cascade-cancelling every descendant it exclusively owns: abandoning a line of work, killing a stuck or wrong-turn subtree, clearing a branch you no longer need. Windows die but nothing is deleted — each closed node keeps its pi session and can be revived later (`canvas revive`). Use `node demote` instead to FINISH the agent in your pane with a final report, and `push final` when a worker should end its own work normally (Alt+C → x)',
  help: {
    name: 'node close',
    summary:
      'close a node and cascade-cancel its subtree — kill its tmux window plus those of every descendant it EXCLUSIVELY owns (down the subscribes_to spine), mark them all canceled, and leave each a notice it reads on resume. A descendant still subscribed to by a manager outside the subtree is left running. Nothing is deleted: every closed node keeps its pi session and can be revived later (`crtr canvas revive`)',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to close. Defaults to the node occupying --pane (or your current pane).' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id whose node to close. Defaults to $TMUX_PANE / your current pane. The Alt+C menu passes this for you.' },
    ],
    output: [
      { name: 'closed', type: 'boolean', required: true, constraint: 'True when the node (and its exclusive subtree) was closed.' },
      { name: 'node_id', type: 'string', required: false, constraint: 'The node that was closed — the cascade root.' },
      { name: 'count', type: 'number', required: false, constraint: 'How many nodes were closed (root + cascaded descendants).' },
      { name: 'closed_ids', type: 'string[]', required: false, constraint: 'All closed node ids, kill order (leaves first, root last).' },
      { name: 'spared', type: 'string[]', required: false, constraint: 'Descendants left alive because a manager outside the subtree still subscribes to them.' },
    ],
    outputKind: 'object',
    effects: [
      'Marks the node and its exclusive descendants `canceled` and clears intent (the daemon never revives a canceled node).',
      'Kills each closed node\'s tmux window; their pi sessions and canvas edges persist for a later revive.',
      'Appends a cancellation notice to each closed node\'s inbox, surfaced on its next resume.',
    ],
  },
  run: async (input) => {
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    let id = input['node'] as string | undefined;
    if (id === undefined || id === '') id = nodeInPane(pane);
    if (id === undefined || id === '') {
      throw new InputError({ error: 'no_node', message: 'no node found in this pane to close', next: 'Pass --node <id>, or run from inside the agent\'s pane.' });
    }
    if (getNode(id) === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    }
    const res = closeNode(id);
    return { closed: true, node_id: res.root, count: res.closed.length, closed_ids: res.closed, spared: res.spared };
  },
  render: (r) =>
    r['closed'] === true
      ? `<closed id="${r['node_id']}" count="${r['count']}" spared="${(r['spared'] as string[] | undefined)?.length ?? 0}"/>`
      : `<close-failed/>`,
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
  description: 'DFS-walk to the next/prev live node in place',
  whenToUse: 'sweeping the canvas one window at a time, descending into children before siblings (bound to Alt+] forward / Alt+[ back). Use `node focus` instead to jump straight to a named node',
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

    // Placement retargets the caller pane's focus to the neighbor (§2.3),
    // reviving it into the backstage first if its pane was released. callerNode
    // is the node we cycled AWAY from — the current occupant of the caller pane.
    const res = placementFocus(targetId, {
      pane,
      callerNode: fromId,
      revive: (nid) => { reviveNode(nid, { resume: true }); },
    });
    return { focused: res.focused, node_id: targetId, name: target.name, from: fromId };
  },
  render: (r) =>
    r['focused'] === true
      ? `<cycled to="${r['node_id']}" name="${r['name'] ?? ''}" from="${r['from'] ?? ''}"/>`
      : `<cycle-noop>no other live node to focus</cycle-noop>`,
});

// ---------------------------------------------------------------------------
// node msg — direct-address any node at a wake tier (wakes a dormant target)
// ---------------------------------------------------------------------------

const nodeMsg = defineLeaf({
  name: 'msg',
  description: 'direct-message any node at a wake tier',
  whenToUse: 'you want to address a specific node directly — steer it mid-flight, hand it a correction, ping it, or pass it new information — and have it land regardless of subscriptions, reviving a dormant target. Set `--tier` by urgency: critical interrupts with a new turn, urgent steers mid-turn, normal is a follow-up, deferred waits for its next cycle. Use `node subscribe` instead to wire ongoing push delivery rather than send a one-off, and `push` to report UP your own spine',
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
  description: 'wire a subscribes_to edge between any pair (active or --passive)',
  whenToUse: 'you want to wire who-wakes-whom on the graph: make a node receive the pushes another node emits — yourself by default, or any node to any publisher via `--subscriber` (e.g. point a manager at a `--root` worker you spawned, or fan a reviewer to a second orchestrator). Active by default, so a push WAKES the subscriber; pass `--passive` to have pushes accumulate and auto-inject on its next message without waking it. You already auto-subscribe to any child you spawn, so reach for this for edges spawn did not create. Inverse is `node unsubscribe`',
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
  description: 'drop a subscribes_to edge',
  whenToUse: 'you want to stop a node receiving another\'s pushes: detach yourself (default) or any node via `--subscriber` from a publisher — quiet a feed you no longer track, or cut a manager loose from a finished worker. Idempotent. The inverse of `node subscribe`',
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
// node promote — become an orchestrator (the worker→orchestrator polymorph)
// ---------------------------------------------------------------------------

const nodePromote = defineLeaf({
  name: 'promote',
  description: 'become an orchestrator of a chosen kind',
  whenToUse: 'your task has outgrown a single context window — many phases to delegate and persist across refreshes — so become an orchestrator: a long-lived, roadmap-holding node that fans work out to children and survives context refreshes (`node yield`). Choose `--kind` to specialize (developer/review/spec/design/plan/explore/general). Pass `--resident` to ALSO make it interactable (stays dormant, woken by inbox/human, never forced to submit a final); without it you stay terminal/orchestrator — still reporting a final up the spine and reaping when done. Do NOT reach for this for work that fits one window, or merely because you spawned a child — a base worker that spawns a helper and ends with `push final` never needs to promote',
  tier: 'important',
  help: {
    name: 'node promote',
    summary: 'promote yourself to an orchestrator — do this when your task outgrows one context window (many phases to delegate and persist across refreshes); not for work that fits one window, and not merely because you spawned a child. Mode only — lifecycle stays as-is unless you pass --resident',
    params: [
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'Specialize as this kind of orchestrator: developer (own feature delivery), review, spec, design, plan, explore, general. Defaults to your current kind. Promoting from a generic kind? CHOOSE a concrete one — it sets the orchestrator persona you revive into.' },
      { kind: 'flag', name: 'resident', type: 'bool', required: false, constraint: 'ALSO flip lifecycle→resident: make the node interactable — it stays dormant, woken by inbox/human, and is never forced to submit a final. Omit to stay terminal/orchestrator (delegates + holds a roadmap, but still owes a final up the spine and reaps when done).' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to promote. Defaults to the caller (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The promoted node.' },
      { name: 'kind', type: 'string', required: true, constraint: 'The kind it now orchestrates as.' },
      { name: 'mode', type: 'string', required: true, constraint: 'Now "orchestrator".' },
      { name: 'lifecycle', type: 'string', required: true, constraint: '"resident" if you passed --resident, else unchanged (typically "terminal").' },
      { name: 'roadmap_written', type: 'boolean', required: true, constraint: 'True if a roadmap scaffold was seeded by this call.' },
      { name: 'roadmap_path', type: 'string', required: true, constraint: 'Absolute path to your roadmap doc (context/roadmap.md) — edit it to author your plan.' },
      { name: 'goal_path', type: 'string', required: true, constraint: 'Absolute path to your goal doc (context/initial-prompt.md) — the mandate you were spawned with.' },
      { name: 'memory_path', type: 'string', required: true, constraint: 'Absolute path to your NODE-LOCAL memory index (context/memory/MEMORY.md) — facts specific to this goal; dies with this node.' },
      { name: 'user_memory_path', type: 'string', required: true, constraint: 'Absolute path to your USER-GLOBAL memory index (<crtrHome>/memory/MEMORY.md) — who the human is, how they like to work; loaded into every orchestrator everywhere.' },
      { name: 'project_memory_path', type: 'string', required: true, constraint: 'Absolute path to your PROJECT memory index (<crtrHome>/projects/<key>/memory/MEMORY.md) — facts bound to this repo; loaded into every orchestrator working here.' },
    ],
    outputKind: 'object',
    effects: ['Flips mode→orchestrator + kind→chosen (lifecycle unchanged unless --resident, which also flips lifecycle→resident); rewrites the launch spec to that kind\'s orchestrator persona; seeds context/roadmap.md scaffold + all three scoped memory stores (user-global, project, node-local) if absent.', 'Your new-role guidance is injected automatically at the turn boundary by the persona injector — the command no longer returns it.'],
  },
  run: async (input) => {
    const id = (input['node'] as string | undefined) ?? process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node to promote (set CRTR_NODE_ID or pass --node)', next: 'Run from inside a node, or pass --node <id>.' });
    const kind = input['kind'] as string | undefined;
    if (kind !== undefined) assertKind(kind);
    const resident = input['resident'] === true;
    const res = promote(id, { ...(kind !== undefined ? { kind } : {}), ...(resident ? { resident: true } : {}) });
    return { node_id: res.meta.node_id, kind: res.meta.kind, mode: res.meta.mode, lifecycle: res.meta.lifecycle, roadmap_written: res.roadmapWritten, roadmap_path: res.roadmapPath, goal_path: res.goalPath, memory_path: res.memoryPath, user_memory_path: res.userMemoryPath, project_memory_path: res.projectMemoryPath };
  },
});

// ---------------------------------------------------------------------------
// node lifecycle — flip the lifecycle axis (terminal ↔ resident), independent
// of mode. The persona injector delivers the transition guidance.
// ---------------------------------------------------------------------------

const nodeLifecycle = defineLeaf({
  name: 'lifecycle',
  description: 'switch a node between terminal and resident',
  whenToUse: 'you want to flip a node\'s LIFECYCLE independent of its mode: make a node RESIDENT so it becomes interactable — it stays dormant, wakes on inbox/human, and is never forced to submit a final; or make a node TERMINAL so it owes a final result up the spine and reaps when done. Orthogonal to `node promote`, which changes MODE (base↔orchestrator), not lifecycle. The new-state guidance is injected automatically at the next turn boundary. Pass `--detach` to ALSO send a still-running agent to the background crtr session, freeing your pane while it finishes — the human-driver demote (Alt+C → d demotes in place) and detach (Alt+C → D demotes + backgrounds)',
  help: {
    name: 'node lifecycle',
    summary: 'set a node\'s lifecycle axis — terminal (owes a final up the spine, reaps when done) or resident (interactable, stays dormant, woken by inbox/human, never forced to submit). Orthogonal to mode; promotion does not touch it. `--detach` also relocates a live agent to the background crtr session',
    params: [
      { kind: 'positional', name: 'lifecycle', required: true, constraint: 'terminal | resident.' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to change. Defaults to the node in --pane, else the caller (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id whose node to change, when --node is omitted. Defaults to $TMUX_PANE. The Alt+C menu passes this for you.' },
      { kind: 'flag', name: 'detach', type: 'bool', required: false, constraint: 'After flipping lifecycle, send the still-running agent to the background crtr session (break its pane out of the foreground). The pi keeps generating and — now terminal — pushes a final up the spine when done. The human-driver "I am done foregrounding this" move (Alt+C → D).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The node.' },
      { name: 'lifecycle', type: 'string', required: true, constraint: 'Its new lifecycle (terminal | resident).' },
      { name: 'detached', type: 'boolean', required: false, constraint: 'True when --detach relocated the agent to the background crtr session.' },
    ],
    outputKind: 'object',
    effects: ['Sets lifecycle on the node meta and rebuilds its launch spec so a future revive boots with the new lifecycle\'s prompt baked in.', 'The persona injector delivers the transition guidance at the next turn boundary (or on the node\'s next revive if it is dormant).', 'With --detach: relocates the agent\'s live pane to the background crtr session (break-pane) WITHOUT killing the pi — it keeps generating in the background.'],
  },
  run: async (input) => {
    const value = (input['lifecycle'] as string | undefined)?.trim().toLowerCase();
    if (value !== 'terminal' && value !== 'resident') {
      throw new InputError({ error: 'bad_lifecycle', message: `invalid lifecycle: ${value ?? ''}`, field: 'lifecycle', next: 'Pass `terminal` or `resident`.' });
    }
    // Resolve the node: explicit --node, else the node occupying --pane (the
    // Alt+C menu passes #{pane_id}), else the caller (CRTR_NODE_ID).
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    let id = input['node'] as string | undefined;
    if (id === undefined || id === '') id = nodeInPane(pane);
    if (id === undefined || id === '') id = process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node (set CRTR_NODE_ID, pass --node, or run from the agent\'s pane)', next: 'Run from inside a node, pass --node <id>, or --pane <pane>.' });
    if (getNode(id) === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
    // Rebuild the launch spec so a future revive comes back with the new
    // lifecycle's prompt baked in (the live session is steered by the persona
    // injector; this fixes the static prompt the daemon replays). Spine is fixed
    // by parent-ness, so it carries through unchanged.
    const target = getNode(id)!;
    const { launch } = buildLaunchSpec(target.kind, target.mode, {
      lifecycle: value,
      hasManager: target.parent !== null,
    });
    const meta = updateNode(id, { lifecycle: value as Lifecycle, launch });
    // --detach: shove the still-running agent into the background crtr session,
    // freeing the foreground pane. The pi is untouched (it keeps generating); now
    // terminal, it pushes a final up the spine when it finishes.
    let detached = false;
    if (input['detach'] === true) detached = detachToBackground(id, pane);
    return { node_id: meta.node_id, lifecycle: meta.lifecycle, detached };
  },
  render: (r) => `<lifecycle node="${r['node_id']}" set="${r['lifecycle']}"${r['detached'] === true ? ' detached="true"' : ''}/>`,
});

// ---------------------------------------------------------------------------
// node yield — refresh: discard context, revive fresh against the roadmap
// ---------------------------------------------------------------------------

const nodeYield = defineLeaf({
  name: 'yield',
  description: 'refresh your context against your roadmap',
  whenToUse: 'your context window is filling up but the mandate is unfinished: request a refresh — end your turn and revive fresh against your roadmap, leaving a note to your future self for the moment you wake. A base node auto-promotes to orchestrator first (a yield needs a roadmap to refresh against). Use `node promote` instead when you need to BECOME an orchestrator with no refresh pending',
  help: {
    name: 'node yield',
    summary: 'request a context refresh — you will be respawned fresh against your roadmap on your next stop (a base node auto-promotes to orchestrator first)',
    params: [
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'If this yield auto-promotes a base node, specialize it as this kind of orchestrator (developer, review, spec, design, plan, explore, general). Defaults to your current kind.' },
      { kind: 'stdin', name: 'message', required: true, constraint: 'A note to your future self — what to do the moment you wake fresh. Surfaced as <yield-message> in the next revive. Pass as a positional or pipe via heredoc.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The yielding node.' },
      { name: 'promoted', type: 'boolean', required: true, constraint: 'True if this yield promoted a base node to orchestrator.' },
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
    if (message === '') {
      throw new InputError({ error: 'empty_message', message: 'a yield message is required (stdin or positional)', next: 'Pass a note to your future self as an argument or pipe it on stdin.' });
    }
    writeYieldMessage(id, message);
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
        'HOW: `crtr node new "<task>" --kind <kind>` returns a node id immediately and runs the worker in a background window. Match the kind to the work (see `node new -h`). You are woken when a child finishes — the wake message ALREADY IS the coalesced digest (the watcher drains your inbox to wake you), so don\'t re-run `crtr feed read` to "open" it (it would read empty, the cursor already advanced); instead dereference the report paths in that digest that matter, don\'t act on a one-line label. (`crtr feed read` is for proactively polling before a wake, or inspecting a child\'s inbox via `--node`; `--all` re-reads history with full message bodies.) Integrate, then either delegate the next units or finish.\n\n' +
        'FINISH: a worker ends its own work with `crtr push final "<result>"` (writes the canonical result, marks done, closes the window) — stopping without it is not finishing. For a job too big for one context window, `node promote` to an orchestrator (holds a roadmap, delegates phases); when context fills, `node yield` to refresh against that roadmap.',
    },
    children: [nodeNew, nodeInspect, nodeFocus, nodeCycle, nodeDemote, nodeClose, nodeMsg, nodeSubscribe, nodeUnsubscribe, nodePromote, nodeLifecycle, nodeYield],
  });
}
