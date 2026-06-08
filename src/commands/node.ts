// `crtr node` — the canvas-native command surface.
//
// A node is the unit of the runtime: an agent with its own identity, context
// dir, and pi vehicle, pinned to a cwd. This subtree spawns terminal workers
// onto the canvas (`new`), inspects the graph (`inspect list|show`), and walks
// the spine (`focus`/`msg`). The push/feed half lives under `crtr push`.

import { defineLeaf, defineBranch, type BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { readConfig } from '../core/config.js';
import { spawnChild, type SpawnChildOpts } from '../core/runtime/spawn.js';
import { promote, requestYield } from '../core/runtime/promote.js';
import { writeYieldMessage, readGoal } from '../core/runtime/kickoff.js';
import { reviveNode } from '../core/runtime/revive.js';
import { newNodeId } from '../core/runtime/nodes.js';
import { readRoadmap } from '../core/runtime/roadmap.js';
import { parseWhen, parseCadence, cadenceDisplay, type WakeError } from '../core/wake.js';

import { recycleNode } from '../core/runtime/recycle.js';
import { detachToBackground, focus as placementFocus, windowAlive, windowOfPane, currentTmux } from '../core/runtime/placement.js';
import { buildLaunchSpec } from '../core/runtime/launch.js';
import { closeNode } from '../core/runtime/close.js';
import { appendInbox, type InboxTier } from '../core/feed/inbox.js';
import { availableKinds, kindWhenToUse, subPersonasFor } from '../core/personas/index.js';
import { stateBlock } from '../core/help.js';
import {
  getNode,
  updateNode,
  listNodes,
  subscribe,
  unsubscribe,
  subscriptionsOf,
  subscribersOf,
  readContextTokens,
  view,
  armWake,
  listWakes,
  cancelWake,
  WakeArmError,
  type Mode,
  type Lifecycle,
  type NodeStatus,
  type WakeScope,
  type WakeKind,
  type WakePayload,
  type DeadlineWakePayload,
  type ArmWakeSpec,
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

/** A live `<kinds count=N>` state element — one `<kind> — <whenToUse>` line per
 *  installed top-level persona kind (project > user > builtin), lazily built so
 *  it reflects the caller's cwd/project scope. Appended to `node new -h` and
 *  `node promote -h` so custom kinds appear in help. Soft-fails via the renderer.
 *
 *  CONTEXT-AWARE: when the CALLER is a live node (CRTR_NODE_ID set) whose kind
 *  has sub-personas available to it, a SECOND `<sub-personas for=K count=M>`
 *  block is appended right after — the specialist sub-personas THAT kind may
 *  spawn (full kind string + whenToUse). Everything but the top-level `<kinds>`
 *  block soft-fails to omission (caller block wrapped in its own try/catch). */
function kindsStateBlock(): string {
  const kinds = availableKinds();
  const lines = kinds
    .map((k) => {
      const w = kindWhenToUse(k);
      return w ? `${k} — ${w}` : k;
    })
    .join('\n');
  const block = stateBlock('kinds', { count: kinds.length }, lines);
  const sub = callerSubPersonasBlock();
  return sub ? `${block}\n${sub}` : block;
}

/** When the caller is a live node whose kind has sub-personas available to it,
 *  render a `<sub-personas for="<kind>" count=M>` block — one
 *  `<full-kind-string> — <whenToUse>` line per sub-persona spawnable BY that
 *  kind (e.g. `plan/reviewers/security`). Returns '' (so the second block is
 *  omitted) when CRTR_NODE_ID is unset, getNode returns null, the caller kind
 *  has no sub-personas, or anything throws — this is help output, never error. */
function callerSubPersonasBlock(): string {
  try {
    const id = process.env['CRTR_NODE_ID'];
    if (id === undefined || id === '') return '';
    const node = getNode(id);
    if (node === null) return '';
    const subs = subPersonasFor(node.kind);
    if (subs.length === 0) return '';
    const lines = subs.map((s) => (s.whenToUse ? `${s.kind} — ${s.whenToUse}` : s.kind)).join('\n');
    return stateBlock('sub-personas', { for: node.kind, count: subs.length }, lines);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// node new — spawn a terminal worker as a background window under the root
// ---------------------------------------------------------------------------

const nodeNew = defineLeaf({
  name: 'new',
  description: 'spawn a node — a managed child (default), or an independent root with --root',
  whenToUse: 'you have a self-contained unit of work — reach for this instead of doing it inline, so the reading and the tokens land in a fresh window and only the conclusion comes back: mapping an unfamiliar part of the codebase, writing a spec, designing an approach, breaking a job into a plan, implementing a change, or running a review. Fan independent units out as concurrent children. Most spawns are managed children whose finish wakes you; reach here too when a unit is itself too big for one window (boot it directly as its own sub-orchestrator rather than hope a base worker promotes itself) or when you are handing off an INDEPENDENT node you will neither manage nor be woken by, e.g. one a human will sit and drive',
  tier: 'important',
  help: {
    name: 'node new',
    summary: 'spawn a terminal worker onto the canvas as a background window — returns its node id',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'First user message for the spawned node. Deliver it on stdin from a quoted heredoc (`<<\'EOF\'`) or a file (`< prompt.md`).' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind — match the work to the kind. The <kinds> list below names every installable kind and when to use each; the <sub-personas> block (when present) names the specialist sub-personas available to YOU, each spawnable by its full kind string (e.g. plan/reviewers/security).' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode. base for a worker that finishes in one window; orchestrator to create the child directly as a sub-orchestrator (it boots with the orchestrator persona + a seeded roadmap and fans its scope out) — use it when the unit is too large for one window, e.g. a big review, instead of spawning a base worker and counting on it to promote itself.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir the node is pinned to. Defaults to the caller cwd.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name (tmux window + resume picker). Defaults to the kind.' },
      { kind: 'flag', name: 'parent', type: 'string', required: false, constraint: 'Parent node id. Defaults to the calling node (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'root', type: 'bool', required: false, constraint: 'Spawn an INDEPENDENT root instead of a managed child: no parent (top-level on the canvas), NO subscription back to you (you are NOT woken by it), resident lifecycle. It records spawned_by=you for provenance and is brought forefront so it can be driven directly. Use for a node you hand off and do not manage (e.g. a sub-orchestrator a human will discuss with).' },
      { kind: 'flag', name: 'fork-from', type: 'string', required: false, constraint: 'FORK the new node from an existing pi conversation instead of starting it fresh: pass a node id (forks from that node\'s session), an absolute session `.jsonl` path, or a partial pi session uuid. pi copies that whole history into a NEW session for the child (the source is untouched), then the prompt is delivered as the next message — i.e. the child wakes up as a continuation of that conversation. Use to branch exploratory work off a node that already built up the context you need, instead of re-deriving it. One-shot at birth: the fork resumes its own session thereafter.' },
      { kind: 'flag', name: 'headless', type: 'bool', required: false, constraint: 'Spawn the node on the HEADLESS broker host (no tmux pane) instead of a tmux window. Overrides the `headless` config default for this spawn; omit to use that default (which itself defaults to a tmux pane).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The new node id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Display name.' },
      { name: 'window', type: 'string', required: false, constraint: 'tmux window id of the background window.' },
      { name: 'session', type: 'string', required: true, constraint: 'The tmux session the node was placed in — the shared crtr session for a child; your current session for an in-tmux --root.' },
      { name: 'status', type: 'string', required: true, constraint: 'Always "active" on spawn.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Decision road sign for the caller: the child runs independently and its finish wakes you on its own, so never wait or poll on it — either pick up other work now or end your turn. If you are an orchestrator already deep in context (>100k), it instead steers you to `crtr node yield` now so your fresh revive absorbs the child\'s result. Read it, then act.' },
    ],
    dynamicState: () => kindsStateBlock(),
    outputKind: 'object',
    effects: [
      'Creates a node under ~/.crouter/canvas/nodes/<id>/ and indexes it in canvas.db.',
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
    // Host precedence: explicit --headless flag > config `headless` default > tmux.
    const hostKind: 'tmux' | 'broker' =
      input['headless'] === true ? 'broker' : readConfig('user').headless === true ? 'broker' : 'tmux';

    const res = spawnChild({ kind, mode, cwd, name, prompt, parent, root, forkFrom, hostKind });
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
  whenToUse: 'you want a flat roster of the nodes on the canvas, optionally sliced by status: a quick read of what exists and what is still running. Use `node inspect show` instead to drill into one node and its spine neighbors, `canvas dashboard` for the tree SHAPE, and `canvas attention` to find which nodes are blocked on a human',
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
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id to focus INTO (default: caller TMUX_PANE). Used by the canvas browser popup to focus back into the originating pane.' },
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
    // A kind:'human' node is a control-plane ASK (a humanloop deck on the human's
    // screen), NOT a pi conversation — it has no session. Reviving one boots a
    // confused blank "you have been revived" pi, so refuse rather than focus it.
    // (The nav/resume UIs already hide human nodes; this guards a hand-typed id.)
    if (node.kind === 'human') {
      throw new InputError({
        error: 'not_focusable',
        message: `node ${id} is a human-ask (kind:human), not a conversation — it has no pi session to focus.`,
        next: `The pending question is already on the human's screen; see it with \`crtr human list\` / \`crtr human inbox\`, or retract it with \`crtr human cancel ${id}\`.`,
      });
    }
    // Placement owns the whole act (§2.3): resolve the caller's focus (or open a
    // new viewport with --new-pane), revive the target into the backstage if it
    // is dormant, then hot-swap it onto the focus. The reviver is injected so
    // placement need not import revive.ts.
    const res = placementFocus(id, {
      pane: input['pane'] as string | undefined,
      newPane: input['newPane'] === true,
      callerNode: process.env['CRTR_NODE_ID'],
      revive: (nid) => { reviveNode(nid, { resume: true }); },
    });
    return { focused: res.focused, session: res.session, revived: res.revived, in_place: res.inPlace };
  },
});

// ---------------------------------------------------------------------------
// node recycle — FINALIZE the agent in your pane + recycle it into a fresh root
// (push its last report as a `final` → mark it done, then boot a fresh resident
// `crtr` root in the SAME pane; see recycleNode in runtime/recycle.ts). NOT
// bound to any Alt+C key/menu — d/D there route to `node demote` (±--detach),
// the flip-to-terminal-IN-PLACE action that keeps the agent running.
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
 *  shared by `node recycle` / `node demote` / `node lifecycle` / `node close` /
 *  `node cycle`, all of which act on "the agent in front of you". Exported for
 *  the `canvas chord` / `canvas tmux-spread` leaves,
 *  which resolve the active pane's node the same way. */
export function nodeInPane(pane?: string): string | undefined {
  const resolvePane = pane ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  const win = resolvePane !== undefined && resolvePane !== '' ? windowOfPane(resolvePane) : null;
  return win !== null ? nodeByWindow(win) : undefined;
}

const nodeRecycle = defineLeaf({
  name: 'recycle',
  description: 'finish the agent in your pane + recycle it into a fresh root',
  whenToUse: 'you are at an agent\'s pane and done with it: finish it cleanly and recycle the pane in one move — push its last message as a final report to everyone waiting on it, mark it done, then boot a fresh crtr root in the same pane to keep working. The human-driver way to end an agent and immediately start over in place. Use `node demote` instead to put it on a finishing track IN PLACE (flip terminal, keep it running) without ending it now, `node close` to tear a node and its subtree down WITHOUT finishing (no report, revivable), and `push final` when the agent should finish ITSELF from inside its own turn',
  help: {
    name: 'node recycle',
    summary: 'finish the agent in your current pane and recycle the pane — push its last message as a final report to everyone waiting on it, mark it done, then boot a fresh crtr root in the same pane',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to finish. Defaults to the node occupying --pane (or your current pane).' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id to recycle. Defaults to $TMUX_PANE / your current pane. The Alt+C menu passes this for you.' },
    ],
    output: [
      { name: 'recycled', type: 'boolean', required: true, constraint: 'True when the pane was recycled into a fresh root.' },
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
    const res = await recycleNode(id, pane);
    return { recycled: res.recycled, node_id: id, finalized: res.finalized, delivered: res.delivered.length, new_root: res.newRoot ?? undefined };
  },
  render: (r) =>
    r['recycled'] === true
      ? `<recycled id="${r['node_id']}" finalized="${r['finalized']}" delivered="${r['delivered']}" new_root="${r['new_root'] ?? ''}"/>`
      : `<recycle-failed id="${r['node_id'] ?? ''}">not in tmux, or no agent in this pane</recycle-failed>`,
});

// ---------------------------------------------------------------------------
// node close — close a node + cascade-cancel its exclusive subtree (Alt+C → x)
// ---------------------------------------------------------------------------

const nodeClose = defineLeaf({
  name: 'close',
  description: 'close a node + cascade-cancel its exclusive subtree (revivable)',
  whenToUse: 'you want to tear a node down WITHOUT finishing it, cascade-cancelling every descendant it exclusively owns: abandoning a line of work, killing a stuck or wrong-turn subtree, clearing a branch you no longer need. Windows die but nothing is deleted — each closed node keeps its pi session and can be revived later (`canvas revive`). Use `node recycle` instead to FINISH the agent in your pane with a final report, and `push final` when a worker should end its own work normally (Alt+C → x)',
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
  whenToUse: 'you want to address a specific node directly — steer it mid-flight, hand it a correction, ping it, or pass it new information — and have it land regardless of subscriptions, reviving a dormant target. You set how urgently it lands, from an immediate interrupt to a note read on its next cycle. Use `node subscribe` instead to wire ongoing push delivery rather than send a one-off, and `push` to report UP your own spine',
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
  whenToUse: 'you want to wire who-wakes-whom on the graph: make a node receive the pushes another node emits — yourself by default, or any node to any publisher (e.g. point a manager at an independent worker you spawned, or fan a reviewer to a second orchestrator), choosing whether each push wakes the subscriber or just accumulates for its next turn. You already auto-subscribe to any child you spawn, so reach for this for edges spawn did not create. Inverse is `node unsubscribe`',
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
  whenToUse: 'you want to stop a node receiving another\'s pushes: detach yourself, or any node, from a publisher — quiet a feed you no longer track, or cut a manager loose from a finished worker. Idempotent. The inverse of `node subscribe`',
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
  whenToUse: 'your task has outgrown a single context window — many phases to delegate and persist across refreshes — so become an orchestrator: a long-lived, roadmap-holding node that fans work out to children and survives context refreshes (`node yield`). Specialize it to the kind of work it now steers, and optionally make it interactable so it stays dormant between inbox/human pings instead of owing a final. Do NOT reach for this for work that fits one window, or merely because you spawned a child — a base worker that spawns a helper and ends with `push final` never needs to promote',
  tier: 'important',
  help: {
    name: 'node promote',
    summary: 'promote yourself to an orchestrator — do this when your task outgrows one context window (many phases to delegate and persist across refreshes); not for work that fits one window, and not merely because you spawned a child. Mode only — lifecycle stays as-is unless you pass --resident',
    params: [
      { kind: 'flag', name: 'kind', type: 'string', required: false, constraint: 'Specialize as this kind of orchestrator. The <kinds> list below names every installable kind and when to use each; the <sub-personas> block (when present) names the specialist sub-personas available to YOU, spawnable by full kind string. Defaults to your current kind. Promoting from a generic kind? CHOOSE a concrete one — it sets the orchestrator persona you revive into.' },
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
    dynamicState: () => kindsStateBlock(),
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
// Shared lifecycle plumbing — the single implementation behind BOTH `node
// demote` (the friendly terminal-only verb that pairs with `node promote`) and
// `node lifecycle` (the low-level orthogonal flip, which also does resident).
// ---------------------------------------------------------------------------

/** Resolve the node a demote/lifecycle command acts on: explicit --node, else
 *  the node occupying --pane (the Alt+C menu passes #{pane_id}), else the caller
 *  (CRTR_NODE_ID). Throws a rendered error when none resolves or it is unknown. */
function resolveLifecycleNode(input: Record<string, unknown>, pane: string | undefined): string {
  let id = input['node'] as string | undefined;
  if (id === undefined || id === '') id = nodeInPane(pane);
  if (id === undefined || id === '') id = process.env['CRTR_NODE_ID'];
  if (id === undefined || id === '') throw new InputError({ error: 'no_node', message: 'no node (set CRTR_NODE_ID, pass --node, or run from the agent\'s pane)', next: 'Run from inside a node, pass --node <id>, or --pane <pane>.' });
  if (getNode(id) === null) throw new InputError({ error: 'not_found', message: `no node: ${id}`, next: 'List nodes with `crtr node inspect list`.' });
  return id;
}

/** Set a node's lifecycle axis and, with `detach`, relocate its still-running
 *  pane to the background crtr session. Rebuilds the launch spec so a future
 *  revive comes back with the new lifecycle's prompt baked in (the live session
 *  is steered by the persona injector; this fixes the static prompt the daemon
 *  replays). Spine is fixed by parent-ness, so it carries through unchanged.
 *  The ONE implementation `node demote` (always terminal) and `node lifecycle`
 *  (the passed value) both call — no duplication. */
function setLifecycle(id: string, value: Lifecycle, opts: { pane?: string | undefined; detach?: boolean }): { node_id: string; lifecycle: Lifecycle; detached: boolean } {
  const target = getNode(id)!;
  const { launch } = buildLaunchSpec(target.kind, target.mode, {
    lifecycle: value,
    hasManager: target.parent !== null,
  });
  const meta = updateNode(id, { lifecycle: value, launch });
  // --detach: shove the still-running agent into the background crtr session,
  // freeing the foreground pane. The pi is untouched (it keeps generating); now
  // terminal, it pushes a final up the spine when it finishes.
  let detached = false;
  if (opts.detach === true) detached = detachToBackground(id, opts.pane);
  return { node_id: meta.node_id, lifecycle: meta.lifecycle, detached };
}

// ---------------------------------------------------------------------------
// node demote — flip a node to TERMINAL in place (the friendly half of the
// promote/demote pair; bound to Alt+C → d, and → D with --detach). It stays
// focused and running but now owes a final up the spine. A terminal-only skin
// over the shared setLifecycle plumbing; `node lifecycle` is the orthogonal
// low-level command (it also does resident). See vision F5.
// ---------------------------------------------------------------------------

const nodeDemote = defineLeaf({
  name: 'demote',
  description: 'demote a node to terminal in place; it stays focused and running but now owes a final; --detach also sends it to the backstage crtr session',
  whenToUse: 'you are watching a resident/interactive node and want to put it on a finishing track WITHOUT disturbing it: flip it terminal IN PLACE — it keeps its pane and your focus, keeps running, but now owes a final report up the spine and reaps when done. The friendly counterpart to `node promote`. You can also let go entirely and send the still-running agent off-screen to finish in the background. Use `node recycle` instead to FINISH it now and reboot a fresh root in its pane, and `node lifecycle` for the orthogonal low-level flip (incl. terminal→resident)',
  help: {
    name: 'node demote',
    summary: 'demote a node to terminal IN PLACE — it stays focused and running but now owes a final up the spine and reaps when done. Pairs with `node promote` (mode↑); `--detach` also relocates the still-running agent to the background crtr session',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node to demote. Defaults to the node in --pane, else the caller (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'pane', type: 'string', required: false, constraint: 'tmux pane id whose node to demote, when --node is omitted. Defaults to $TMUX_PANE. The Alt+C menu passes this for you.' },
      { kind: 'flag', name: 'detach', type: 'bool', required: false, constraint: 'After flipping terminal, send the still-running agent to the background crtr session (break its pane out of the foreground). The pi keeps generating and — now terminal — pushes a final up the spine when done. The Alt+C → D move.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The demoted node.' },
      { name: 'lifecycle', type: 'string', required: true, constraint: 'Always "terminal" after a demote.' },
      { name: 'detached', type: 'boolean', required: false, constraint: 'True when --detach relocated the agent to the background crtr session.' },
    ],
    outputKind: 'object',
    effects: ['Flips the node\'s lifecycle→terminal and rebuilds its launch spec so a future revive boots terminal — it stays focused and running, now owing a final up the spine.', 'The persona injector delivers the transition guidance at the next turn boundary (or on the node\'s next revive if it is dormant).', 'With --detach: relocates the agent\'s live pane to the background crtr session (break-pane) WITHOUT killing the pi — it keeps generating off-screen.'],
  },
  run: async (input) => {
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    const id = resolveLifecycleNode(input, pane);
    const res = setLifecycle(id, 'terminal', { pane, detach: input['detach'] === true });
    return { node_id: res.node_id, lifecycle: res.lifecycle, detached: res.detached };
  },
  render: (r) => `<demoted node="${r['node_id']}" lifecycle="${r['lifecycle']}"${r['detached'] === true ? ' detached="true"' : ''}/>`,
});

// ---------------------------------------------------------------------------
// node lifecycle — flip the lifecycle axis (terminal ↔ resident), independent
// of mode. The persona injector delivers the transition guidance.
// ---------------------------------------------------------------------------

const nodeLifecycle = defineLeaf({
  name: 'lifecycle',
  description: 'switch a node between terminal and resident',
  whenToUse: 'you want to flip a node\'s LIFECYCLE independent of its mode: make a node RESIDENT so it becomes interactable — it stays dormant, wakes on inbox/human, and is never forced to submit a final; or make a node TERMINAL so it owes a final result up the spine and reaps when done. Orthogonal to `node promote`, which changes MODE (base↔orchestrator), not lifecycle. You can also let go of a still-running agent and send it off-screen to finish in the background. For the human-driver flip-to-terminal pair reach for `node demote` (the friendly terminal-only skin over this)',
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
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    const id = resolveLifecycleNode(input, pane);
    const res = setLifecycle(id, value as Lifecycle, { pane, detach: input['detach'] === true });
    return { node_id: res.node_id, lifecycle: res.lifecycle, detached: res.detached };
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

// ---------------------------------------------------------------------------
// node wake — scheduled wakeups (arm / list / cancel). The agent-facing skin
// over the wakeups data-access layer (armWake/listWakes/cancelWake) + the time
// grammar (parseWhen/parseCadence). The surface ONLY arms a durable row and
// introspects/cancels — it never spawns pi, drives a transition, or fires a wake
// (those are the daemon's at fire time). T2's armWake carries only integrity
// backstops (empty body / recur-on-deadline / unknown kind); the target-
// resolvability, bare-recoverable-state, and per-owner cap checks live HERE
// (Min-6), so every armer must route through this surface.
// ---------------------------------------------------------------------------

/** Max pending wakes a single owner may hold (AC-N4). */
const WAKE_CAP = 100;

/** Default timeout body for a note-less `until`, so the deadline row is never
 *  empty (T2 rejects an empty body) and Maj-8's rendered timeout signal has text. */
const DEFAULT_DEADLINE_BODY =
  'Deadline reached — no report arrived; reassess / chase / escalate.';

/** Resolve the calling node (the armer/owner). CRTR_NODE_ID is mandatory — a
 *  wake is owned by the node that arms it (owner_id). */
function armerId(): string {
  const id = process.env['CRTR_NODE_ID'];
  if (id === undefined || id === '') {
    throw new InputError({ error: 'no_node', message: 'no node to arm a wake (CRTR_NODE_ID unset)', next: 'Run from inside a node.' });
  }
  return id;
}

/** Build ParseOpts, including `tz` only when actually provided. */
function parseOpts(now: Date, tz: string | undefined): { tz?: string; now: Date } {
  return tz !== undefined && tz.trim() !== '' ? { tz, now } : { now };
}

/** Map a T3 typed time-grammar error to the rendered AC-N3/N4 error block. */
function throwWakeError(e: WakeError): never {
  const next: Record<string, string> = {
    wake_in_past: 'Pick a future instant — a positive duration ("5m","2h") or an ISO time later than now.',
    bad_when: 'Use a duration ("5m","1h30m"), a zoned ISO ("2026-06-07T09:00:00Z"), or a bare ISO ("2026-06-07T09:00").',
    bad_cadence: 'Use a duration ("6h"), a 5-field cron ("0 9 * * *"), or an @alias ("@daily").',
    unknown_zone: 'Pass --tz with an IANA zone name (e.g. "America/New_York").',
    cadence_too_fast: 'Use a cadence of at least 60s (e.g. "1m","5m","1h").',
  };
  throw new InputError({ error: e.code, message: e.message, received: e.received, next: next[e.code] ?? 'Fix the time value and retry.' });
}

/** Run armWake, mapping its thrown integrity backstop (WakeArmError) to a
 *  rendered error block. The surface validates these cases up front, so a throw
 *  here is a backstop, not the primary path. */
function armOrThrow(spec: ArmWakeSpec): string {
  try {
    return armWake(spec);
  } catch (e) {
    if (e instanceof WakeArmError) {
      const next: Record<string, string> = {
        empty_note: 'Provide a real --note, or omit it for a bare wake.',
        deadline_cannot_recur: 'Drop --every. For a recurring self-alarm use `crtr node wake at --every <cadence>`.',
        bad_kind: 'This is a crtr bug — report it.',
      };
      throw new InputError({ error: e.code, message: e.message, next: next[e.code] ?? 'Fix the wake spec and retry.' });
    }
    throw e;
  }
}

/** Reject an arm that would push this owner past the pending-wakes cap (AC-N4),
 *  counted via the {owner} listWakes variant. */
function assertUnderCap(ownerId: string): void {
  const pending = listWakes({ owner: ownerId }).length;
  if (pending >= WAKE_CAP) {
    throw new InputError({
      error: 'cap_exceeded',
      message: `you hold ${pending} pending wakes (cap ${WAKE_CAP}).`,
      next: 'Reap stale wakes with `crtr node wake cancel <id>` (see `crtr node wake list`) before arming more.',
    });
  }
}

/** A bare wake resumes a fresh window with no memory beyond disk, so it needs
 *  durable state to wake INTO. Accept it only when the target has a goal
 *  (initial-prompt.md) or roadmap (roadmap.md) on disk — located via the
 *  codebase's own writeGoal/roadmap convention, not a new file (AC-N3). */
function hasRecoverableState(nodeId: string): boolean {
  const goal = readGoal(nodeId);
  if (goal !== null && goal.trim() !== '') return true;
  const roadmap = readRoadmap(nodeId);
  return roadmap !== null && roadmap.trim() !== '';
}

/** True when a stored recur is a fixed interval (vs a calendar cron). */
function isFixedInterval(recur: string): boolean {
  try {
    return typeof (JSON.parse(recur) as { every?: unknown }).every === 'string';
  } catch {
    return false;
  }
}

/** A human ETA hint like " (~5m)" from a fire-at ISO relative to now. '' if past. */
function etaHint(fireAt: string, now: Date): string {
  const ms = new Date(fireAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return ` (~${mins}m)`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 48) return ` (~${hrs}h)`;
  return ` (~${Math.round(ms / 86_400_000)}d)`;
}

/** Escape a value for a rendered XML attribute (list rows carry free-text notes). */
function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// node wake at ---------------------------------------------------------------

const nodeWakeAt = defineLeaf({
  name: 'at',
  description: 'arm a self-alarm — wake yourself (or another node) at a future time',
  whenToUse:
    'you have a standing or recurring task on a CLOCK, or nothing to do until a known future time — run a job each morning, loop a health check on a cadence (--every), re-check an EXTERNAL poll (CI, a deploy, a rate-limit window) after a backoff, or hand your future self a timed reminder. Time-driven work ONLY: do NOT arm a timer to watch your own agents — you auto-subscribe to every child you spawn, so its finish already wakes you; setting a wake to "check if it is done yet" just burns a window the subscription would have woken anyway. The bare form is the time-triggered twin of `node yield`: a fresh window re-reading your roadmap, right for standing/recurring work; the noted form instead wakes you into your saved conversation with a pointer this moment needs. Use `node wake until` to put a single DEADLINE backstop on an inbox-wait (still event-first, not polling); `node wake spawn` to defer spawning a NEW node; `node yield` to refresh NOW rather than at a future T',
  help: {
    name: 'node wake at',
    summary:
      'arm a self-alarm: wake yourself (default) or another node (--node) at a future time. Bare ⇒ fresh window re-reading roadmap/disk; --note ⇒ saved conversation with the note as new context; --every ⇒ a declarative recurrence the runtime keeps firing even across your crash/finalize',
    params: [
      { kind: 'positional', name: 'when', required: false, constraint: 'Fire time — a duration ("5m","1h30m"), a zoned ISO ("2026-06-07T09:00:00Z"), or a bare ISO ("2026-06-07T09:00", host-local). Required UNLESS --every is given (the cadence then sets the first fire).' },
      { kind: 'flag', name: 'note', type: 'string', required: false, constraint: 'A non-empty note delivered into the woken context. Present ⇒ NOTED wake (resume your saved conversation, note as new context). Absent ⇒ BARE wake (fresh window re-reading roadmap/disk). A bare wake on a node with no goal/roadmap on disk is rejected.' },
      { kind: 'flag', name: 'every', type: 'string', required: false, constraint: 'Make it a declarative recurrence the runtime fires on schedule even if you crash/finalize (node-anchored revive-cron): a duration ("6h","30m") or a 5-field cron / @alias ("0 9 * * *","@daily"). A fixed-interval --every WITH <when> uses <when> as the first fire; a cron --every ignores <when>. Min cadence 60s.' },
      { kind: 'flag', name: 'tz', type: 'string', required: false, constraint: 'IANA zone for a calendar --every or a bare-ISO <when> (default: host-local).' },
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Arm the wake for ANOTHER existing node (a parent waking a child / a timed message to it). Default: self (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'The new wakeup id (cancel/list by it).' },
      { name: 'kind', type: 'string', required: true, constraint: '"bare" or "noted".' },
      { name: 'fires_at', type: 'string', required: true, constraint: 'Absolute UTC fire time (the first fire for a recurrence).' },
      { name: 'recur', type: 'string', required: true, constraint: '"none", or the cadence (every 6h / cron `0 9 * * *` <zone>).' },
      { name: 'target', type: 'string', required: true, constraint: '"self" or the --node id.' },
      { name: 'guidance', type: 'string', required: true, constraint: 'What to do now — end your turn to go dormant; do not push final.' },
    ],
    outputKind: 'object',
    effects: [
      'Inserts one wakeups row (kind bare/noted); nothing fires before fire_at.',
      'No pi spawn, no transition — arming is a pure durable side-effect. End your turn separately to go dormant.',
    ],
  },
  run: async (input) => {
    const ownerId = armerId();
    const targetId = ((input['node'] as string | undefined) ?? '').trim() || ownerId;
    if (getNode(targetId) === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${targetId}`, field: 'node', next: 'List nodes with `crtr node inspect list`.' });
    }
    const when = (input['when'] as string | undefined)?.trim();
    const every = (input['every'] as string | undefined)?.trim();
    const tz = input['tz'] as string | undefined;
    const noteRaw = input['note'] as string | undefined;
    const hasNote = noteRaw !== undefined;

    if ((when === undefined || when === '') && (every === undefined || every === '')) {
      throw new InputError({ error: 'bad_when', message: 'a <when> time is required (or --every for a recurrence).', next: 'Pass a duration ("5m"), an ISO time, or --every <cadence>.' });
    }
    if (hasNote && noteRaw.trim() === '') {
      throw new InputError({ error: 'empty_note', message: '--note must be non-empty for a noted wake.', received: noteRaw, next: 'Provide a real note ("re-check CI #4821; deploy was pending"), or omit --note for a bare wake.' });
    }
    const kind: WakeKind = hasNote ? 'noted' : 'bare';
    if (kind === 'bare' && !hasRecoverableState(targetId)) {
      throw new InputError({ error: 'bare_no_recoverable_state', message: `node ${targetId} has no goal/roadmap on disk — a bare wake would resume amnesiac.`, next: 'Pass --note "<why this moment matters>" so the woken context carries a pointer, or arm the bare wake only once the node has a roadmap/goal.' });
    }

    const now = new Date();
    let recur: string | undefined;
    let fireAt: string;
    if (every !== undefined && every !== '') {
      const cad = parseCadence(every, parseOpts(now, tz));
      if ('error' in cad) throwWakeError(cad.error);
      recur = cad.recur;
      fireAt = cad.firstFireAt;
      // BOTH <when> and a FIXED-interval --every: <when> overrides the first fire
      // (Min-12). A cron --every ignores <when> by design.
      if (when !== undefined && when !== '' && isFixedInterval(cad.recur)) {
        const w = parseWhen(when, parseOpts(now, tz));
        if ('error' in w) throwWakeError(w.error);
        fireAt = w.fireAt;
      }
    } else {
      const w = parseWhen(when!, parseOpts(now, tz));
      if ('error' in w) throwWakeError(w.error);
      fireAt = w.fireAt;
    }

    assertUnderCap(ownerId);

    let payload: WakePayload = null;
    if (kind === 'noted') {
      const body = noteRaw!;
      payload = { body, label: body.split('\n')[0]!.slice(0, 120) };
    }

    const id = `wk-${newNodeId()}`;
    armOrThrow({
      wakeup_id: id,
      node_id: targetId,
      owner_id: ownerId,
      fire_at: fireAt,
      kind,
      ...(recur !== undefined ? { recur } : {}),
      payload,
    });

    const target = targetId === ownerId ? 'self' : targetId;
    const eta = etaHint(fireAt, now);
    const guidance =
      recur !== undefined
        ? `${kind === 'noted' ? 'Noted' : 'Bare'} recurrence armed (${cadenceDisplay(recur)}); first fire ${fireAt}${eta}. End your turn to go dormant; do not push final. The runtime keeps firing it even across your crash/finalize — cancel with \`crtr node wake cancel ${id}\`.`
        : kind === 'noted'
          ? `Noted wake armed. You wake into your saved conversation at ${fireAt}${eta} with your note. End your turn now to go dormant; do not push final.`
          : `Bare self-alarm armed. You wake in a fresh window at ${fireAt}${eta}. End your turn now to go dormant; do not push final. The wake re-reads your roadmap.`;

    return { id, kind, fires_at: fireAt, recur: cadenceDisplay(recur), target, guidance };
  },
  render: (r) =>
    `<wake-armed id="${r['id']}" kind="${r['kind']}" fires-at="${r['fires_at']}" recur="${r['recur']}" target="${r['target']}">\n${r['guidance']}\n</wake-armed>`,
});

// node wake until ------------------------------------------------------------

const nodeWakeUntil = defineLeaf({
  name: 'until',
  description: 'bind a deadline to your current inbox-wait (self only)',
  whenToUse:
    'rarely — only to put a deadline on an inbox-wait whose event the runtime genuinely cannot guarantee to deliver: you are open to a message AND backstopping an UNPUSHABLE external (a human who may never reply, an outside system with no spine-push). NOT for delegates — a child finishing, crashing, or being closed already wakes you on its own, so a deadline to "chase" a delegate is exactly the belt-and-suspenders the runtime makes redundant. Use `node wake at` instead for an unconditional timed wake unrelated to an inbox event',
  help: {
    name: 'node wake until',
    summary:
      'arm a deadline on your current dormancy: you wake on the first inbox message, or at <when> if none arrives — whichever fires first wins, the loser is canceled. Self only; ≤1 deadline per node (a new `until` replaces the prior); cancel-on-wake (any genuine revive drops it)',
    params: [
      { kind: 'positional', name: 'when', required: true, constraint: 'Deadline time — a duration ("30m"), a zoned ISO, or a bare ISO (host-local).' },
      { kind: 'flag', name: 'note', type: 'string', required: false, constraint: 'Your timeout playbook — what to do if you woke because the wait expired (delivered with a timeout marker so you can tell a timeout from a real report). Omit and a default timeout note is supplied.' },
      { kind: 'flag', name: 'every', type: 'string', required: false, constraint: 'NOT ALLOWED — a deadline cannot recur. Passing it is rejected (deadline_cannot_recur); use `crtr node wake at --every` for a recurring self-alarm.' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'The new deadline wakeup id.' },
      { name: 'fires_at', type: 'string', required: true, constraint: 'Absolute UTC deadline.' },
      { name: 'target', type: 'string', required: true, constraint: 'Always "self".' },
      { name: 'guidance', type: 'string', required: true, constraint: 'What to do now — delegate / end your turn to go dormant.' },
    ],
    outputKind: 'object',
    effects: [
      "Upserts the node's single deadline wakeups row (replacing any prior).",
      'No pi spawn, no transition — arm, then end your turn to go dormant. A genuine revive (an inbox event or any other wake) cancels it.',
    ],
  },
  run: async (input) => {
    const ownerId = armerId();
    const every = (input['every'] as string | undefined)?.trim();
    if (every !== undefined && every !== '') {
      throw new InputError({ error: 'deadline_cannot_recur', message: 'a deadline cannot recur.', next: 'Drop --every. For a recurring self-alarm use `crtr node wake at --every <cadence>`.' });
    }
    const when = (input['when'] as string).trim();
    const noteRaw = input['note'] as string | undefined;
    if (noteRaw !== undefined && noteRaw.trim() === '') {
      throw new InputError({ error: 'empty_note', message: '--note must be non-empty when given.', received: noteRaw, next: 'Provide a real timeout playbook, or omit --note for the default timeout note.' });
    }
    const now = new Date();
    const w = parseWhen(when, { now });
    if ('error' in w) throwWakeError(w.error);

    assertUnderCap(ownerId);

    const body = noteRaw !== undefined && noteRaw.trim() !== '' ? noteRaw : DEFAULT_DEADLINE_BODY;
    const label = body.split('\n')[0]!.slice(0, 120);
    const payload: DeadlineWakePayload = { body, timeout: true, label };
    const id = `wk-${newNodeId()}`;
    armOrThrow({ wakeup_id: id, node_id: ownerId, owner_id: ownerId, fire_at: w.fireAt, kind: 'deadline', payload });

    const eta = etaHint(w.fireAt, now);
    const guidance = `Deadline armed. You wake on the first inbox message, or at ${w.fireAt}${eta} if none arrives. Now delegate / end your turn to go dormant — whichever fires first cancels the other.`;
    return { id, fires_at: w.fireAt, target: 'self', guidance };
  },
  render: (r) =>
    `<deadline-armed id="${r['id']}" fires-at="${r['fires_at']}" target="${r['target']}">\n${r['guidance']}\n</deadline-armed>`,
});

// node wake spawn -----------------------------------------------------------

const nodeWakeSpawn = defineLeaf({
  name: 'spawn',
  description: 'defer or recur the BIRTH of a new node',
  whenToUse:
    'you want a node spawned LATER or on a repeating cadence rather than right now: a one-shot deferred birth at a future time (--at), or a spawn-cron that re-births a fresh node every interval/cron even across your crash/finalize (--every) — standing work like a nightly review, a periodic health check, a morning digest, or a timed reminder that acts. Use `node new` instead to spawn immediately, and `node wake at` to re-wake an EXISTING node on a timer rather than birth a new one',
  help: {
    name: 'node wake spawn',
    summary:
      'defer or recur a node birth — arm a wake that spawns a fresh node at a future time (--at) or on a repeating cadence (--every), instead of `node new` spawning it now. Returns a wakeup id, not a node id; the full spawn recipe is stored on the wake and re-derived live at fire time',
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'First user message for the node to be born. Deliver it on stdin from a quoted heredoc (`<<\'EOF\'`) or a file (`< prompt.md`).' },
      { kind: 'flag', name: 'at', type: 'string', required: false, constraint: 'DEFER a one-shot birth at <when> — a duration ("5m"), a zoned ISO, or a bare ISO (host-local, or in --tz). Mutually exclusive with --every; exactly one of --at/--every is required.' },
      { kind: 'flag', name: 'every', type: 'string', required: false, constraint: 'SPAWN-CRON: re-birth a fresh node on this declarative cadence even after a prior instance reaped itself or crashed — a duration ("6h") or a 5-field cron / @alias ("0 9 * * *","@daily"). Canvas-anchored (survives your crash/finalize), reaped by your deliberate close or `node wake cancel`. Min cadence 60s. Mutually exclusive with --at.' },
      { kind: 'flag', name: 'tz', type: 'string', required: false, constraint: 'IANA zone for a calendar --every (or a bare-ISO --at); default host-local. Makes "every 9am" mean 9am there, DST-correct.' },
      { kind: 'flag', name: 'kind', type: 'string', required: false, default: 'general', constraint: 'Persona kind for the node to be born — match the work to the kind (the <kinds> list below names each).' },
      { kind: 'flag', name: 'mode', type: 'enum', choices: ['base', 'orchestrator'], required: false, default: 'base', constraint: 'Persona mode: base (finishes in one window) or orchestrator (boots with a seeded roadmap and fans its scope out).' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Dir the born node is pinned to. Defaults to the caller cwd, resolved NOW — it must still exist at fire time or the spawn fails loud.' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name for the born node (tmux window + resume picker). Defaults to the kind.' },
      { kind: 'flag', name: 'parent', type: 'string', required: false, constraint: 'Parent node id for the born node. Defaults to the calling node (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'root', type: 'bool', required: false, constraint: 'Birth an INDEPENDENT root instead of a managed child: no parent on the spine, NO subscription back to you, resident lifecycle (records spawned_by=you for provenance).' },
      { kind: 'flag', name: 'fork-from', type: 'string', required: false, constraint: 'Fork the born node from an existing pi conversation instead of starting it fresh: a node id, an absolute session `.jsonl` path, or a partial pi session uuid. pi copies that history into a NEW session, then the prompt is the next message. One-shot at birth.' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'The wakeup id (inspect/cancel by it via `node wake list`/`cancel`).' },
      { name: 'kind', type: 'string', required: true, constraint: 'The persona kind of the deferred node.' },
      { name: 'fires_at', type: 'string', required: true, constraint: 'Absolute UTC birth time (the first fire for a cron).' },
      { name: 'recur', type: 'string', required: true, constraint: '"none" (one-shot --at) or the cadence (every 6h / cron `0 9 * * *` <zone>).' },
      { name: 'guidance', type: 'string', required: true, constraint: 'What to do now — no node exists yet; pick up other work or end your turn.' },
    ],
    dynamicState: () => kindsStateBlock(),
    outputKind: 'object',
    effects: [
      'Inserts one detached `spawn` wakeups row (node_id NULL, owner=you, parent/cwd resolved now); NO node and NO window exist until fire time.',
      'At fire time the daemon spawns the node from the stored recipe, re-deriving the launch spec live (persona prose is never stale). Best-effort: if the cwd/parent is gone at fire it fails LOUD (an urgent push to you, or a daemon-log line if you are gone).',
    ],
  },
  run: async (input) => {
    const prompt = (input['prompt'] as string | undefined) ?? '';
    if (prompt.trim() === '') {
      throw new InputError({ error: 'empty_prompt', message: 'a prompt is required (stdin or positional)', next: 'Pipe a task on stdin or pass it as an argument.' });
    }
    const at = (input['at'] as string | undefined)?.trim();
    const every = (input['every'] as string | undefined)?.trim();
    const tz = input['tz'] as string | undefined;
    const hasAt = at !== undefined && at !== '';
    const hasEvery = every !== undefined && every !== '';
    if (!hasAt && !hasEvery) {
      throw new InputError({ error: 'no_schedule', message: 'node wake spawn needs a schedule: --at <when> or --every <cadence>.', next: 'Pass --at for a one-shot deferred spawn, --every for a spawn-cron, or use `crtr node new` to spawn now.' });
    }
    if (hasAt && hasEvery) {
      throw new InputError({ error: 'at_and_every', message: '--at and --every are mutually exclusive.', next: 'Use --at for a one-shot deferred spawn, or --every for a spawn-cron.' });
    }
    const kind = (input['kind'] as string | undefined) ?? 'general';
    const mode = ((input['mode'] as string | undefined) ?? 'base') as Mode;
    const cwd = (input['cwd'] as string | undefined) ?? process.cwd();
    const name = input['name'] as string | undefined;
    const parent = input['parent'] as string | undefined;
    const root = input['root'] === true;
    const forkFrom = input['forkFrom'] as string | undefined;

    const ownerId = armerId();
    // The recipe's `parent` is the resolved armer — NON-NULL on EVERY payload,
    // INCLUDING --root: spawnChild throws at fire time on a null parent (the
    // daemon has no CRTR_NODE_ID); for a root it internally nulls the spine
    // parent while keeping `spawner` for provenance, so a non-null value is right.
    const recipeParent = parent ?? ownerId;
    const recipe: SpawnChildOpts = {
      kind,
      mode,
      cwd,
      prompt,
      parent: recipeParent,
      ...(name !== undefined ? { name } : {}),
      ...(root ? { root: true } : {}),
      ...(forkFrom !== undefined ? { forkFrom } : {}),
    };
    const now = new Date();
    let recur: string | undefined;
    let fireAt: string;
    if (hasEvery) {
      const cad = parseCadence(every!, parseOpts(now, tz));
      if ('error' in cad) throwWakeError(cad.error);
      recur = cad.recur;
      fireAt = cad.firstFireAt;
    } else {
      const w = parseWhen(at!, parseOpts(now, tz));
      if ('error' in w) throwWakeError(w.error);
      fireAt = w.fireAt;
    }
    assertUnderCap(ownerId);
    const id = `wk-${newNodeId()}`;
    armOrThrow({ wakeup_id: id, node_id: null, owner_id: ownerId, fire_at: fireAt, kind: 'spawn', ...(recur !== undefined ? { recur } : {}), payload: recipe });
    const eta = etaHint(fireAt, now);
    const guidance =
      recur !== undefined
        ? `Spawn-cron armed (${cadenceDisplay(recur)}): a fresh ${kind} node is born each fire, first at ${fireAt}${eta}. No node exists yet; the runtime keeps spawning even across your crash/finalize — inspect/cancel via \`crtr node wake list\` / \`crtr node wake cancel ${id}\`.`
        : `Deferred spawn armed: a fresh ${kind} node is born at ${fireAt}${eta}. No node exists yet — inspect/cancel via \`crtr node wake list\` / \`crtr node wake cancel ${id}\`. Pick up other work or end your turn.`;
    return { id, kind, fires_at: fireAt, recur: cadenceDisplay(recur), guidance };
  },
  render: (r) =>
    `<spawn-deferred id="${r['id']}" kind="${r['kind']}" fires-at="${r['fires_at']}" recur="${r['recur']}">\n${r['guidance']}\n</spawn-deferred>`,
});

// node wake list -------------------------------------------------------------

const nodeWakeList = defineLeaf({
  name: 'list',
  description: 'list pending wakes for a scope (default self)',
  whenToUse:
    'before re-arming or finishing, to see what you already have armed and reap stale ones. Defaults to your own wakes, with scopes for another node, the whole canvas, or a node and its descendants',
  help: {
    name: 'node wake list',
    summary:
      'list pending wakes (all kinds, incl. deferred spawns) for a scope — id, kind, next fire, cadence, target, owner, note. Fired one-shots are gone; a recurrence shows its NEXT fire, not past slots',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'List the wakes anchored to this node. Mutually exclusive with --canvas/--subtree.' },
      { kind: 'flag', name: 'canvas', type: 'bool', required: false, constraint: 'List EVERY wake on the canvas. Mutually exclusive with --node/--subtree.' },
      { kind: 'flag', name: 'subtree', type: 'string', required: false, constraint: 'List the wakes anchored to this node AND its descendants (the subscription sub-DAG). Mutually exclusive with --node/--canvas.' },
    ],
    output: [
      { name: 'scope', type: 'string', required: true, constraint: 'The scope listed (self / <id> / canvas / subtree:<id>).' },
      { name: 'wakes', type: 'object[]', required: true, constraint: 'Rows: {id, kind, next, recur, target, owner, note}.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: queries the wakeups table.'],
  },
  run: async (input) => {
    const nodeFlag = (input['node'] as string | undefined)?.trim();
    const canvas = input['canvas'] === true;
    const subtree = (input['subtree'] as string | undefined)?.trim();
    const chosen = [nodeFlag !== undefined && nodeFlag !== '', canvas, subtree !== undefined && subtree !== ''].filter(Boolean).length;
    if (chosen > 1) {
      throw new InputError({ error: 'bad_scope', message: 'choose at most one of --node, --canvas, --subtree.', next: 'Pass a single scope flag, or none for your own wakes.' });
    }
    const viewer = process.env['CRTR_NODE_ID'];
    let scope: WakeScope;
    let scopeLabel: string;
    if (canvas) {
      scope = { canvas: true };
      scopeLabel = 'canvas';
    } else if (subtree !== undefined && subtree !== '') {
      if (getNode(subtree) === null) throw new InputError({ error: 'not_found', message: `no node: ${subtree}`, field: 'subtree', next: 'List nodes with `crtr node inspect list`.' });
      scope = { subtree: [subtree, ...view(subtree)] };
      scopeLabel = `subtree:${subtree}`;
    } else if (nodeFlag !== undefined && nodeFlag !== '') {
      scope = { node: nodeFlag };
      scopeLabel = viewer !== undefined && nodeFlag === viewer ? 'self' : nodeFlag;
    } else {
      // Default "self" scope is OWNER-based, not node-anchored: it is "what YOU
      // armed" (§3.5 whenToUse), so the detached spawn wakes you own via
      // `node new --at/--every` (node_id NULL, owner_id self) DO surface here
      // with their `spawn:<kind>@<cwd>` target — §3.5/§3.7 require that. (Use
      // --node <id> for the node-ANCHORED view of a target's wakes.)
      scope = { owner: armerId() };
      scopeLabel = 'self';
    }
    const rel = (id: string | null): string => {
      if (id === null) return '';
      return viewer !== undefined && viewer !== '' && id === viewer ? 'self' : id;
    };
    const wakes = listWakes(scope).map((w) => {
      let target: string;
      if (w.node_id !== null) {
        target = rel(w.node_id);
      } else if (w.kind === 'spawn' && w.payload !== null) {
        const recipe = w.payload as SpawnChildOpts;
        target = `spawn:${recipe.kind}@${recipe.cwd}`;
      } else {
        target = 'detached';
      }
      const note =
        (w.kind === 'noted' || w.kind === 'deadline') && w.payload !== null
          ? ((w.payload as { label?: string }).label ?? '')
          : '';
      return { id: w.wakeup_id, kind: w.kind, next: w.fire_at, recur: cadenceDisplay(w.recur), target, owner: rel(w.owner_id), note };
    });
    return { scope: scopeLabel, wakes };
  },
  render: (r) => {
    const wakes = r['wakes'] as Array<Record<string, unknown>>;
    const rows = wakes.map(
      (w) =>
        `  <wake id="${w['id']}" kind="${w['kind']}" next="${w['next']}" recur="${xmlAttr(String(w['recur']))}" target="${xmlAttr(String(w['target']))}" owner="${xmlAttr(String(w['owner']))}" note="${xmlAttr(String(w['note']))}"/>`,
    );
    const body = rows.length > 0 ? '\n' + rows.join('\n') + '\n' : '\n';
    return (
      `<wakes scope="${xmlAttr(String(r['scope']))}" count="${wakes.length}">${body}</wakes>\n` +
      '<follow_up>Cancel one with `crtr node wake cancel <id>`. Fired one-shots are gone; a recurrence shows its NEXT fire, not past slots.</follow_up>'
    );
  },
});

// node wake cancel -----------------------------------------------------------

const nodeWakeCancel = defineLeaf({
  name: 'cancel',
  description: 'cancel a pending wake by id (idempotent)',
  whenToUse:
    'a wait you no longer need — a poll whose goal is met, a deferred spawn you reconsidered, a deadline you are replacing. Idempotent: canceling an already-fired or already-canceled id is a no-op. Closing/reaping a node already reaps its own wakes and the detached ones it armed; reach for this to drop a single wake, or to reap a detached spawn/cron a finished or crashed node left running',
  help: {
    name: 'node wake cancel',
    summary:
      'cancel a pending wake by id — it never fires and leaves the list. Idempotent (canceling an already-gone id is a no-op, not an error)',
    params: [
      { kind: 'positional', name: 'wakeup-id', required: true, constraint: 'The wakeup id to cancel (from `node wake list`).' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'The canceled wakeup id.' },
      { name: 'was_pending', type: 'boolean', required: true, constraint: 'True when a pending row was removed; false when it was already gone.' },
    ],
    outputKind: 'object',
    effects: ['Deletes the wakeup row (idempotent — no error if it was already gone).'],
  },
  run: async (input) => {
    const id = (input['wakeupId'] as string).trim();
    const wasPending = listWakes({ canvas: true }).some((w) => w.wakeup_id === id);
    cancelWake(id);
    return { id, was_pending: wasPending };
  },
  render: (r) => `<wake-canceled id="${r['id']}" was-pending="${r['was_pending']}"/>`,
});

// node wake (branch) ---------------------------------------------------------

const nodeWake = defineBranch({
  name: 'wake',
  description: 'arm/list/cancel scheduled wakeups — the second trigger that stirs a dormant node: time',
  whenToUse:
    'you want to schedule work on a CLOCK — a long-horizon or recurring task that fires at a future time or loops on a cadence: a standing job, a recurring cron, a deferred or repeating node birth, or a poll against EXTERNAL state (CI, a deploy, a clock) after a backoff. This is the TIME trigger, NOT a way to watch your own agents — to monitor a child you arm NOTHING: you auto-subscribe on spawn, so its finish, crash, or close wakes you on its own; a deadline to chase a delegate is the belt-and-suspenders the runtime makes redundant. `at` arms a self-alarm (the timed twin of `node yield`), `until` bounds an inbox-wait with a deadline, `spawn` defers or repeats the BIRTH of a new node, `list`/`cancel` inspect and reap',
  help: {
    name: 'node wake',
    summary: 'the pending-wakeups namespace — arm a time trigger on the dormant state, then inspect/cancel it',
    model:
      'Time is the second trigger that stirs a dormant node — the first is an inbox message, and a scheduled wake is just a future delivery on that same channel. At the moment you set, the runtime brings you (or, for a deferred birth, a fresh node) back through the ordinary revive path: no new window, nothing the focus model learns. Reach for it to schedule CLOCK-driven work — a standing job, a recurring loop (--every), a deferred birth, or a poll against EXTERNAL state after a backoff. It is NOT how you watch your own agents: you auto-subscribe to every child you spawn, so its finish already wakes you — arm nothing and stay dormant rather than set a timer to "check if it is done" — a child finishing, crashing, or being closed all wake you on their own. (`until` is a narrow exception: a deadline backstop on an inbox-wait the runtime CANNOT guarantee to deliver — an unpushable external, never a delegate, whose outcome already wakes you.) Use this to wait CHEAPLY — end your turn, go dormant (free: no window, no compute), and be woken only when it is worth acting again. `at` arms a self-alarm; `until` bounds an inbox-wait with a deadline; `spawn` defers or repeats the BIRTH of a new node (the full recipe stored on the wake); `list`/`cancel` inspect and reap. Arming is a pure side-effect: it writes a durable row, it does NOT end your turn — end your turn separately to go dormant.',
  },
  children: [nodeWakeAt, nodeWakeUntil, nodeWakeSpawn, nodeWakeList, nodeWakeCancel],
});

export function registerNode(): BranchDef {
  return defineBranch({
    name: 'node',
    rootEntry: {
      concept: 'a unit of the agent runtime — an agent on the canvas with its own context dir and pi vehicle. Spawning nodes is how work gets done here, not an optimization you reach for late',
      desc: 'spawn, inspect, and navigate nodes on the canvas',
      useWhen:
        'delegating work, or walking the subscription graph. CRITICAL, and your default reflex — spawning a child is the first move on almost any task, not a fallback. Your own context window is the scarce resource: before you read files into it to understand, implement, debug, or change code you do not already know, hand that to a fresh node and get back just the conclusion, matching the node kind to the work. Keep inline only a fact you already know. Fan out independent units as CONCURRENT children — a wake with idle workers is wasted; serialize only true dependencies, and never let two live children edit the same files. Once you delegate a unit, do not also run it yourself: you auto-subscribe on spawn, so its finish wakes you. Spawn + collect mechanics: `crtr node -h`.',
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
    children: [nodeNew, nodeInspect, nodeFocus, nodeCycle, nodeRecycle, nodeClose, nodeMsg, nodeSubscribe, nodeUnsubscribe, nodePromote, nodeDemote, nodeLifecycle, nodeYield, nodeWake],
  });
}
