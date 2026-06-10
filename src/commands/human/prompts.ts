import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { spawnNode } from '../../core/runtime/nodes.js';
import { interactionDir } from '../../core/artifact.js';
import { tmuxServerReachable } from '../../core/spawn.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  validateDeck,
  approveDeck,
  notifyDeck,
  atomicWriteJson,
  deckPath,
  display,
} from '@crouton-kit/humanloop';
import type { Deck } from '@crouton-kit/humanloop';
import {
  DECK_SCHEMA_HINT,
  type RunRecord,
  followUpReview,
  spawnHumanJob,
  detachHumanTui,
  resolveMaxPanes,
} from './shared.js';

/** The asking node's id, or null when run from a bare shell (no parent to route to). */
function askingNode(): string | null {
  return process.env['CRTR_NODE_ID'] ?? null;
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

export const humanAsk = defineLeaf({
  name: 'ask',
  description: 'put a structured choice or open question to a person',
  whenToUse:
    'you would otherwise lay a decision, a set of options, or a question out for the user as prose — reach for this instead, for anything from a quick yes/no to a judgment-heavy call: reviewing all the requirements before building, choosing among implementation patterns, walking a list of risks and deciding what to do about each, settling a naming or scope question, picking which of several findings to act on. Works for open-ended asks too (set `allowFreetext`, offer a few `options` as starting points). The kickoff never blocks, so the human answering on their own time is never a reason to skip the ask and guess instead',
  help: {
    name: 'human ask',
    summary: 'put a humanloop decision deck in front of a person; returns a job handle immediately. This is the default, expected channel for posing ANY question or decision to the user — reach for it instead of writing the question as prose in your reply.',
    guide:
      'Use this for quick, open-ended, and nuanced asks alike — not just "formal" multiple-choice. Set `allowFreetext: true` (with `freetextLabel`) when the answer is open-ended; offer a few `options` as starting points even for judgment calls. The kickoff is instant and NEVER blocks — "never block on the result" refers only to not busy-waiting on the job; the human answering on their own time is not a reason to avoid asking or to fall back to inline prose. The deck body is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one.',
    params: [
      { kind: 'context-file', name: 'deck', required: true, constraint: 'Contains a humanloop deck. Validated before any job is created.', shape: DECK_SCHEMA_HINT },
      { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: 'Accepted for symmetry with the job contract; the kickoff never blocks.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Node id of this human interaction. Its answer is pushed to your inbox when the human responds.' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory holding deck.json/run.json/response.json.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking status peek. The human may take minutes to hours — never block waiting on this.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" node under you and writes deck.json/run.json to the interaction dir.',
      'Spawns the decision TUI in a detached tmux pane (when in tmux).',
    ],
  },
  run: async (input) => {
    let deck: Deck;
    try {
      deck = validateDeck(input['deck']);
    } catch (e) {
      throw new InputError({
        error: 'deck_invalid',
        message: String(e),
        field: 'deck',
        next: DECK_SCHEMA_HINT,
      });
    }

    const cwd = process.cwd();
    const jobId = spawnNode({ kind: 'human', parent: askingNode(), cwd, name: 'human-ask', lifecycle: 'terminal' }).node_id;
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'ask', job_id: jobId };
    atomicWriteJson(join(idir, 'run.json'), rc);

    const { follow_up } = spawnHumanJob(jobId, idir, cwd);
    return { job_id: jobId, dir: idir, follow_up };
  },
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export const humanApprove = defineLeaf({
  name: 'approve',
  description: 'a Yes/No sign-off gate',
  whenToUse: 'a step needs an explicit human yes before it proceeds and a plain answer (not anchored comments) is enough: before a handoff, a merge or deploy, a destructive or irreversible operation, spending real budget, or acting on a risky plan. Reach for `ask` instead when you need them to choose among options or answer something open-ended; reach for `review` when the feedback belongs inline on a document',
  help: {
    name: 'human approve',
    summary: 'a Yes/No approval gate; returns a job handle immediately. The standard way to gate a handoff on human sign-off. Kickoff never blocks — peek at the result later rather than busy-waiting; the human answering on their own time is not a reason to skip the gate.',
    guide:
      'The body is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one.',
    params: [
      { kind: 'positional', name: 'title', type: 'string', required: true, constraint: 'The question shown to the human.' },
      { kind: 'flag', name: 'subtitle', type: 'string', required: false, constraint: 'Optional one-line context.' },
      { kind: 'flag', name: 'body', type: 'string', required: false, constraint: 'Optional markdown body.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Node id of this approval; the {approved, …envelope} result is pushed to your inbox when answered.' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking status peek. The human may take minutes to hours — never block waiting on this.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" node under you and writes a Yes/No validation deck.',
      'Spawns the approval TUI in a detached tmux pane (when in tmux).',
    ],
  },
  run: async (input) => {
    const title = input['title'] as string;
    const subtitle = input['subtitle'] as string | undefined;
    const body = input['body'] as string | undefined;

    const deck = approveDeck(title, {
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(body !== undefined ? { body } : {}),
    });

    const cwd = process.cwd();
    const jobId = spawnNode({ kind: 'human', parent: askingNode(), cwd, name: 'human-approve', lifecycle: 'terminal' }).node_id;
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'approve', job_id: jobId, approve_iid: 'approve' };
    atomicWriteJson(join(idir, 'run.json'), rc);

    const { follow_up } = spawnHumanJob(jobId, idir, cwd);
    return { job_id: jobId, dir: idir, follow_up };
  },
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export const humanReview = defineLeaf({
  name: 'review',
  description: 'collect anchored comments on a .md (plan or spec)',
  whenToUse: 'a human should comment line-by-line on a document rather than give one overall answer: reviewing a plan or spec before you build it, marking up a draft, flagging specific sections to change. The comments come back anchored to the lines they touch. Use `approve` instead for a single yes/no on the whole thing, or `ask` to pose a discrete choice',
  help: {
    name: 'human review',
    summary: "put a .md live on the human's screen for anchored, line-by-line comments; returns a job handle instantly (a non-blocking kickoff, like ask/approve). The pane tracks the file and re-renders on every save, so edit in place rather than re-presenting.",
    guide:
      "A kickoff, not a blocking call: it returns at once and the human reviews on their own time. When they submit, the FeedbackResult (anchored comments, plus any line edits they made) is pushed to your inbox — waking you — and autosaved to `output`; you never poll, verify it opened, or background it. The pane is a LIVE view of the file: keep editing the .md in place and it updates, so do not cancel and re-present to show a change. The .md is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one.",
    params: [
      { kind: 'positional', name: 'file', type: 'path', required: true, constraint: 'Absolute path to an existing .md file.' },
      { kind: 'flag', name: 'output', type: 'path', required: false, constraint: 'Where the FeedbackResult JSON is written. Default: <dir>/feedback.json.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Node id of the kind:"human" node backing this review. Its FeedbackResult is pushed to your inbox when the human submits.' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory holding run.json and the autosaved feedback.json.' },
      { name: 'output', type: 'string', required: true, constraint: 'Path the FeedbackResult JSON is autosaved to when the human submits.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking road sign. The human may take minutes to hours; do not block, poll, or verify the pane — just end your turn and you are woken when they submit.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" node under you and writes run.json to the interaction dir.',
      'Spawns a live review surface (detached tmux panes when in tmux): the raw source in a read-only editor for anchoring comments, beside a termrender-rendered view of the doc; both track the file and re-render on save.',
      'Returns instantly; the anchored comments fan into your inbox when the human submits (off-tmux, drain via `crtr human inbox`).',
    ],
  },
  run: async (input) => {
    const fileArg = input['file'] as string;
    const abs = resolve(fileArg);
    if (!existsSync(abs)) {
      throw new InputError({
        error: 'file_not_found',
        message: `file not found: ${abs}`,
        field: 'file',
        next: 'Provide an absolute path to an existing .md file.',
      });
    }
    if (!abs.endsWith('.md')) {
      throw new InputError({
        error: 'invalid_field',
        message: `review requires a .md file: ${abs}`,
        field: 'file',
        next: 'Point `file` at a Markdown (.md) artifact.',
      });
    }

    const cwd = process.cwd();
    const jobId = spawnNode({ kind: 'human', parent: askingNode(), cwd, name: 'human-review', lifecycle: 'terminal' }).node_id;
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    const outputArg = input['output'] as string | undefined;
    const output = outputArg !== undefined ? outputArg : join(idir, 'feedback.json');
    const rc: RunRecord = { mode: 'review', job_id: jobId, file: abs, output };
    atomicWriteJson(join(idir, 'run.json'), rc);

    // review is a non-blocking kickoff, exactly like ask/approve: the detached
    // `_run` worker pushes the FeedbackResult as this node's final report when
    // the human submits, which fans into our inbox and wakes us (and is also
    // autosaved to `output`). There is nothing to block on — the doc is live on
    // the human's screen and tracks the file, so the caller keeps editing in
    // place or simply ends its turn.
    const { spawned, follow_up: drainFollowUp } = spawnHumanJob(jobId, idir, cwd);
    const follow_up = spawned ? followUpReview(jobId) : drainFollowUp;
    return { job_id: jobId, dir: idir, output, follow_up };
  },
});

// ---------------------------------------------------------------------------
// notify (no job)
// ---------------------------------------------------------------------------

export const humanNotify = defineLeaf({
  name: 'notify',
  description: 'fire-and-forget acknowledgement, no reply expected',
  whenToUse: 'informing a person without blocking or expecting an answer',
  help: {
    name: 'human notify',
    summary: 'show a fire-and-forget acknowledgement; creates no job',
    guide:
      'The body is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one.',
    params: [
      { kind: 'positional', name: 'title', type: 'string', required: true, constraint: 'The notification headline.' },
      { kind: 'flag', name: 'body', type: 'string', required: false, constraint: 'Optional markdown body.' },
    ],
    output: [
      { name: 'shown', type: 'boolean', required: true, constraint: 'True if the TUI pane was spawned; false when not in tmux (deck surfaces in `human inbox`).' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory holding deck.json.' },
    ],
    outputKind: 'object',
    effects: [
      'Writes a notify deck to the per-project interactions root.',
      'Spawns the acknowledgement TUI in a detached tmux pane when in tmux. Creates no node.',
    ],
  },
  run: async (input) => {
    const title = input['title'] as string;
    const body = input['body'] as string | undefined;

    const deck = notifyDeck(title, body !== undefined ? { body } : {});

    const cwd = process.cwd();
    const id = `nfy-${randomBytes(4).toString('hex')}`;
    const idir = interactionDir(id, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'notify' };
    atomicWriteJson(join(idir, 'run.json'), rc);

    let shown = false;
    if (tmuxServerReachable()) {
      shown = detachHumanTui(idir, cwd).status === 'spawned';
    }

    return { shown, dir: idir };
  },
});

// ---------------------------------------------------------------------------
// show (no job, non-blocking passthrough)
// ---------------------------------------------------------------------------

export const humanShow = defineLeaf({
  name: 'show',
  description: "put a file live on the human's screen",
  whenToUse: 'displaying a doc on screen while a human comments',
  help: {
    name: 'human show',
    summary: 'put a file live on screen in a tmux pane via humanloop display',
    guide:
      'The pane always watches the file and live-updates on every save — a displayed doc is a live view by definition, so point it at a file something keeps rewriting (a status board, a running summary) and it stays current. The file is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one.',
    params: [
      { kind: 'positional', name: 'path', type: 'path', required: true, constraint: 'Path to the file to render.' },
      { kind: 'flag', name: 'window', type: 'enum', choices: ['auto', 'split', 'new'], required: false, default: 'auto', constraint: 'Placement. Default auto.' },
    ],
    output: [
      { name: 'pane_id', type: 'string | null', required: true, constraint: 'Tmux pane id, or null when not displayed.' },
      { name: 'reason', type: 'string | null', required: true, constraint: 'Why no pane was created, or null on success.' },
    ],
    outputKind: 'object',
    effects: ['Spawns a live-watch tmux pane when possible. No job. Always exits 0.'],
  },
  run: async (input) => {
    const path = input['path'] as string;
    const windowArg = input['window'] as 'auto' | 'split' | 'new' | undefined;
    const window: 'auto' | 'split' | 'new' = windowArg !== undefined ? windowArg : 'auto';

    // `human show` must never fail the caller: any display error degrades to
    // {pane_id:null, reason} with exit 0 (matches humanloop display semantics).
    let paneId: string | undefined;
    try {
      const r = display(path, { window, maxPanes: resolveMaxPanes() });
      paneId = r.paneId;
    } catch {
      paneId = undefined;
    }

    if (paneId !== undefined) {
      return { pane_id: paneId, reason: null };
    }
    const reason = tmuxServerReachable()
      ? 'renderer unavailable (termrender/uv missing)'
      : 'not in tmux';
    return { pane_id: null, reason };
  },
});
