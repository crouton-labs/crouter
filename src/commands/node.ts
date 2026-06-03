// `crtr node` — the canvas-native command surface.
//
// A node is the unit of the runtime: an agent with its own identity, context
// dir, and pi vehicle, pinned to a cwd. This subtree spawns terminal workers
// onto the canvas (`new`), inspects the graph (`list`, `show`), and walks the
// spine (`focus`). The push/feed half lives under `crtr push`.

import { defineLeaf, defineBranch, type BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { spawnChild, bootRoot } from '../core/runtime/spawn.js';
import { promote, requestYield } from '../core/runtime/promote.js';
import { reviveNode } from '../core/runtime/revive.js';
import { focusNode } from '../core/runtime/presence.js';
import { windowAlive } from '../core/runtime/tmux.js';
import { appendInbox, type InboxTier } from '../core/feed/inbox.js';
import {
  getNode,
  listNodes,
  subscriptionsOf,
  subscribersOf,
  type Mode,
  type NodeStatus,
} from '../core/canvas/index.js';

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
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind: general | explore | developer | plan | spec | review.' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode. Almost always base; orchestrator is reserved for promoted/resident nodes.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir the node is pinned to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name (tmux window + resume picker). Defaults to the kind.' },
      { kind: 'flag', name: 'parent', type: 'string', required: false, constraint: 'Parent node id. Defaults to the calling node (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The new node id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Display name.' },
      { name: 'window', type: 'string', required: false, constraint: 'tmux window id of the background window.' },
      { name: 'session', type: 'string', required: true, constraint: 'Root tmux session the node was placed in.' },
      { name: 'status', type: 'string', required: true, constraint: 'Always "active" on spawn.' },
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
    };
  },
});

// ---------------------------------------------------------------------------
// node list — the active canvas (or a status slice)
// ---------------------------------------------------------------------------

const nodeList = defineLeaf({
  name: 'list',
  help: {
    name: 'node list',
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
    name: 'node show',
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
      throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node list`.' });
    }
    return { node, reports: subscriptionsOf(id), managers: subscribersOf(id) };
  },
});

// ---------------------------------------------------------------------------
// node focus — bring a node's window forefront (across roots if needed)
// ---------------------------------------------------------------------------

const nodeFocus = defineLeaf({
  name: 'focus',
  help: {
    name: 'node focus',
    summary: 'bring a node\'s window forefront (select-window, switching client across roots if needed)',
    params: [
      { kind: 'positional', name: 'node', required: true, constraint: 'Node id to focus.' },
    ],
    output: [
      { name: 'focused', type: 'boolean', required: true, constraint: 'True when the window was brought forefront.' },
      { name: 'session', type: 'string', required: false, constraint: 'The tmux session the node lives in.' },
      { name: 'revived', type: 'boolean', required: true, constraint: 'True when a dormant node was revived to be focused.' },
    ],
    outputKind: 'object',
    effects: ['Runs tmux select-window (+ switch-client across roots) and updates the focus pointer.', 'Revives a dormant node (resume) if it has no live window, then focuses it.'],
  },
  run: async (input) => {
    const id = input['node'] as string;
    const node = getNode(id);
    if (node === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node list`.' });
    // A dormant node (done/dead/window released) has no live window — revive it
    // (resume the saved conversation) so there is something to focus.
    let revived = false;
    if (!windowAlive(node.tmux_session, node.window)) {
      try { reviveNode(id, { resume: true }); revived = true; } catch { /* fall through; focusNode reports focused:false */ }
    }
    const res = focusNode(id);
    return { focused: res.focused, session: res.session, revived };
  },
});

// ---------------------------------------------------------------------------
// node session — boot a NEW root in its own tmux session (the explicit form)
// ---------------------------------------------------------------------------

const nodeSession = defineLeaf({
  name: 'session',
  help: {
    name: 'node session',
    summary: 'start a fresh root node in its own tmux session and switch to it (use from inside a node to start a new root without taking your pane)',
    params: [
      { kind: 'stdin', name: 'prompt', required: false, constraint: 'Optional starter prompt; a root needs none.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind for the root.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir to pin the root to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The root node id.' },
      { name: 'session', type: 'string', required: true, constraint: 'The dedicated tmux session created for this root.' },
      { name: 'window', type: 'string', required: false, constraint: 'The root node\'s window id.' },
    ],
    outputKind: 'object',
    effects: ['Creates a detached tmux session and runs pi in it as a resident root node.'],
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
    if (target === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node list`.' });
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
// node promote — become a resident orchestrator (terminal → resident polymorph)
// ---------------------------------------------------------------------------

const nodePromote = defineLeaf({
  name: 'promote',
  help: {
    name: 'node promote',
    summary: 'promote yourself to a resident orchestrator — flips to the orchestrator persona on next revive, seeds a roadmap, and dumps orchestration guidance now',
    params: [
      { kind: 'flag', name: 'goal', type: 'string', required: false, constraint: 'The high-level goal you are now owning (frozen core of the roadmap). Strongly recommended.' },
      { kind: 'flag', name: 'exit-criteria', type: 'string', required: false, constraint: 'What "done" looks like.' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to promote. Defaults to the caller (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The promoted node.' },
      { name: 'mode', type: 'string', required: true, constraint: 'Now "orchestrator".' },
      { name: 'roadmap_written', type: 'boolean', required: true, constraint: 'True if a roadmap was seeded by this call.' },
      { name: 'guidance', type: 'string', required: true, constraint: 'Orchestration guidance + your roadmap — read it and act on it this turn.' },
    ],
    outputKind: 'object',
    effects: ['Flips lifecycle→resident, mode→orchestrator; rewrites the launch spec; seeds context/roadmap.md if absent.'],
  },
  run: async (input) => {
    const id = (input['node'] as string | undefined) ?? process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node to promote (set CRTR_NODE_ID or pass --node)', next: 'Run from inside a node, or pass --node <id>.' });
    const goal = input['goal'] as string | undefined;
    const exit = input['exitCriteria'] as string | undefined;
    const res = promote(id, { ...(goal !== undefined ? { goal } : {}), ...(exit !== undefined ? { exitCriteria: exit } : {}) });
    return { node_id: res.meta.node_id, mode: res.meta.mode, roadmap_written: res.roadmapWritten, guidance: res.guidance };
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
      { kind: 'flag', name: 'goal', type: 'string', required: false, constraint: 'If auto-promoting, the goal to seed the roadmap with.' },
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
    const goal = input['goal'] as string | undefined;
    const res = requestYield(id, goal !== undefined ? { goal } : {});
    return { node_id: res.meta.node_id, promoted: res.promoted, will_refresh: res.willRefresh };
  },
});

export function registerNode(): BranchDef {
  return defineBranch({
    name: 'node',
    rootEntry: {
      concept: 'a unit of the agent runtime — an agent on the canvas with its own context dir and pi vehicle',
      desc: 'spawn, inspect, and navigate nodes on the canvas',
      useWhen: 'delegating work to a worker, or walking the subscription graph',
    },
    help: {
      name: 'node',
      summary: 'spawn and navigate canvas nodes',
      model:
        'Every agent is a node in a directed graph. `subscribes_to` is the spine: a parent auto-subscribes (active) to each child it spawns, so it learns when the work finishes. Terminal workers finish with `crtr push --final`; resident orchestrators loop. `node new` spawns a background worker under you; `node session` opens a fresh root; `node focus` walks the spine.',
      children: [
        { name: 'new', desc: 'spawn a terminal worker as a background window', useWhen: 'delegating a self-contained unit of work' },
        { name: 'list', desc: 'list nodes on the canvas', useWhen: 'surveying what exists' },
        { name: 'show', desc: 'show a node + its spine neighbors', useWhen: 'inspecting one node' },
        { name: 'focus', desc: 'bring a node window forefront', useWhen: 'jumping to a node to watch or steer it' },
        { name: 'session', desc: 'open a fresh root in its own tmux session', useWhen: 'starting a new top-level session from inside a node' },
        { name: 'msg', desc: 'direct-message any node at a wake tier', useWhen: 'steering or pinging a specific node (wakes it)' },
        { name: 'promote', desc: 'become a resident orchestrator', useWhen: 'your task is bigger than one context window and you must delegate + persist' },
        { name: 'yield', desc: 'refresh your context against your roadmap', useWhen: 'your context window is filling up' },
      ],
    },
    children: [nodeNew, nodeList, nodeShow, nodeFocus, nodeSession, nodeMsg, nodePromote, nodeYield],
  });
}
