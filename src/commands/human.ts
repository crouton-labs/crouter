// `crtr human` subtree — in-process humanloop bridge.
//
// Kickoff leaves (ask/approve/review) create a kind:'human' job, write
// deck.json/run.json into the per-cwd interaction dir, spawn a detached
// `crtr human _run` pane, and return immediately. The agent polls the existing
// `crtr job read result|status|logs` / `crtr job cancel` — no new poll surface.
// notify/show create no job. _run runs the blocking humanloop call at the pane
// TTY and writes the job result itself.
//
// TTY safety: every leaf is argv-only — none declares a stdin parameter, so
// the spawned pane's TTY stays free for humanloop's raw-mode input. Control
// params travel via CRTR_HUMAN_DIR (set inline in the spawned command) +
// run.json, never stdin.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { createJob, writeResult, recordJobPane, appendEvent } from '../core/jobs.js';
import { spawnAndDetach, shellQuote, isInTmux, countPanesInCurrentWindow } from '../core/spawn.js';
import { interactionsRoot, interactionDir } from '../core/artifact.js';
import { paginate } from '../core/pagination.js';
import { readConfig } from '../core/config.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ask,
  launchReview,
  display,
  inbox,
  scanInbox,
  validateDeck,
  parseDeck,
  deckPath,
  atomicWriteJson,
  readJson,
} from '@crouton-kit/humanloop';
import type { Deck, ResolutionEnvelope, FeedbackResult, InboxItem } from '@crouton-kit/humanloop';

const DECK_SCHEMA_HINT =
  'Deck must match the humanloop deck schema: {title?, ' +
  'source?:{sessionName?,askedBy?,blockedSince?}, ' +
  'interactions:[{id,title,subtitle?,(body?|bodyPath?),options:[{id,label,' +
  'description?,shortcut?}],multiSelect?,allowFreetext?,freetextLabel?,' +
  "kind?:'notify'|'validation'|'decision'|'context'|'error'}]}.";

interface RunRecord {
  mode: 'ask' | 'approve' | 'notify' | 'review';
  job_id?: string;
  approve_iid?: string;
  file?: string;
  output?: string;
}

function resolveMaxPanes(): number {
  return readConfig('user').max_panes_per_window;
}

function pickPlacement(): 'split-h' | 'new-window' {
  return countPanesInCurrentWindow() >= resolveMaxPanes() ? 'new-window' : 'split-h';
}

function runCmd(dir: string): string {
  return `CRTR_HUMAN_DIR=${shellQuote(dir)} crtr human _run`;
}

function followUpResult(jobId: string): string {
  return `crtr job read result ${jobId}`;
}

function followUpDrain(jobId: string): string {
  return (
    'Not in tmux: a human must drain it — run `crtr human inbox` (or re-run ' +
    `inside tmux). Then: crtr job read result ${jobId}`
  );
}

/**
 * Spawn the detached `_run` pane for a job-backed kickoff, record the pane for
 * cancellation, log the start, and return the appropriate follow_up. Degrades
 * to the inbox-drain follow_up (job still created) when not in tmux / spawn
 * fails — kickoffs are intentionally non-fatal off-tmux.
 */
function spawnHumanJob(jobId: string, idir: string, cwd: string): string {
  const spawn = spawnAndDetach({
    command: runCmd(idir),
    cwd,
    jobId,
    placement: pickPlacement(),
    killAfterSeconds: 0,
    failGuard: true,
  });
  if (spawn.status !== 'spawned') {
    return followUpDrain(jobId);
  }
  if (spawn.paneId !== undefined) recordJobPane(jobId, spawn.paneId);
  const paneLabel = spawn.paneId !== undefined ? spawn.paneId : 'unknown';
  appendEvent(jobId, {
    level: 'info',
    event: 'worker_started',
    message: `human pane ${paneLabel} spawned`,
  });
  return followUpResult(jobId);
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

const humanAsk = defineLeaf({
  name: 'ask',
  help: {
    name: 'human ask',
    summary: 'put a humanloop decision deck in front of a person; returns a job handle immediately. Humans respond on human time (often >10 min) — never block on the result.',
    params: [
      { kind: 'context-file', name: 'deck', required: true, constraint: 'Contains a humanloop deck. Validated before any job is created.', shape: DECK_SCHEMA_HINT },
      { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: 'Accepted for symmetry with the job contract; the kickoff never blocks.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Poll with `crtr job read result|status|logs`; cancel with `crtr job cancel`.' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory holding deck.json/run.json/response.json.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking status peek. The human may take minutes to hours — never block waiting on this.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" job and writes deck.json/run.json to the interaction dir.',
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
    const { jobId } = createJob('human', { cwd });
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'ask', job_id: jobId };
    atomicWriteJson(join(idir, 'run.json'), rc);

    const follow_up = spawnHumanJob(jobId, idir, cwd);
    return { job_id: jobId, dir: idir, follow_up };
  },
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

const humanApprove = defineLeaf({
  name: 'approve',
  help: {
    name: 'human approve',
    summary: 'a Yes/No approval gate; returns a job handle immediately. Humans respond on human time (often >10 min) — never block on the result.',
    params: [
      { kind: 'positional', name: 'title', type: 'string', required: true, constraint: 'The question shown to the human.' },
      { kind: 'flag', name: 'subtitle', type: 'string', required: false, constraint: 'Optional one-line context.' },
      { kind: 'flag', name: 'body', type: 'string', required: false, constraint: 'Optional markdown body.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Poll with `crtr job read result`; result is {approved, …envelope}.' },
      { name: 'dir', type: 'string', required: true, constraint: 'Interaction directory.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking status peek. The human may take minutes to hours — never block waiting on this.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" job and writes a Yes/No validation deck.',
      'Spawns the approval TUI in a detached tmux pane (when in tmux).',
    ],
  },
  run: async (input) => {
    const title = input['title'] as string;
    const subtitle = input['subtitle'] as string | undefined;
    const body = input['body'] as string | undefined;

    const interaction: Record<string, unknown> = {
      id: 'approve',
      title,
      kind: 'validation',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    };
    if (subtitle !== undefined) interaction['subtitle'] = subtitle;
    if (body !== undefined) interaction['body'] = body;
    const deck = validateDeck({ interactions: [interaction] });

    const cwd = process.cwd();
    const { jobId } = createJob('human', { cwd });
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'approve', job_id: jobId, approve_iid: 'approve' };
    atomicWriteJson(join(idir, 'run.json'), rc);

    const follow_up = spawnHumanJob(jobId, idir, cwd);
    return { job_id: jobId, dir: idir, follow_up };
  },
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

const humanReview = defineLeaf({
  name: 'review',
  help: {
    name: 'human review',
    summary: 'open a .md in a read-only review editor for anchored comments; returns a job handle immediately. Humans respond on human time (often >10 min) — never block on the result.',
    params: [
      { kind: 'positional', name: 'file', type: 'path', required: true, constraint: 'Absolute path to an existing .md file.' },
      { kind: 'flag', name: 'output', type: 'path', required: false, constraint: 'Where the FeedbackResult JSON is written. Default: <dir>/feedback.json.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Poll with `crtr job read result`; result is the humanloop FeedbackResult.' },
      { name: 'output', type: 'string', required: true, constraint: 'Path the FeedbackResult JSON is autosaved to.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'A non-blocking status peek. The human may take minutes to hours — never block waiting on this.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates a kind:"human" job and writes run.json to the interaction dir.',
      'Spawns a read-only nvim/vim review session in a detached tmux pane (when in tmux).',
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
    const { jobId } = createJob('human', { cwd });
    const idir = interactionDir(jobId, cwd);
    mkdirSync(idir, { recursive: true });
    const outputArg = input['output'] as string | undefined;
    const output = outputArg !== undefined ? outputArg : join(idir, 'feedback.json');
    const rc: RunRecord = { mode: 'review', job_id: jobId, file: abs, output };
    atomicWriteJson(join(idir, 'run.json'), rc);

    const follow_up = spawnHumanJob(jobId, idir, cwd);
    return { job_id: jobId, output, follow_up };
  },
});

// ---------------------------------------------------------------------------
// notify (no job)
// ---------------------------------------------------------------------------

const humanNotify = defineLeaf({
  name: 'notify',
  help: {
    name: 'human notify',
    summary: 'show a fire-and-forget acknowledgement; creates no job',
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
      'Spawns the acknowledgement TUI in a detached tmux pane when in tmux. Creates no crtr job.',
    ],
  },
  run: async (input) => {
    const title = input['title'] as string;
    const body = input['body'] as string | undefined;

    const interaction: Record<string, unknown> = {
      id: 'notify',
      title,
      kind: 'notify',
      options: [{ id: 'ack', label: 'OK' }],
    };
    if (body !== undefined) interaction['body'] = body;
    const deck = validateDeck({ interactions: [interaction] });

    const cwd = process.cwd();
    const id = `nfy-${randomBytes(4).toString('hex')}`;
    const idir = interactionDir(id, cwd);
    mkdirSync(idir, { recursive: true });
    atomicWriteJson(deckPath(idir), deck);
    const rc: RunRecord = { mode: 'notify' };
    atomicWriteJson(join(idir, 'run.json'), rc);

    let shown = false;
    if (isInTmux()) {
      const spawn = spawnAndDetach({
        command: runCmd(idir),
        cwd,
        placement: pickPlacement(),
        killAfterSeconds: 0,
        failGuard: false,
      });
      shown = spawn.status === 'spawned';
    }

    return { shown, dir: idir };
  },
});

// ---------------------------------------------------------------------------
// show (no job, non-blocking passthrough)
// ---------------------------------------------------------------------------

const humanShow = defineLeaf({
  name: 'show',
  help: {
    name: 'human show',
    summary: 'put a file live on screen in a tmux pane via humanloop display',
    params: [
      { kind: 'positional', name: 'path', type: 'path', required: true, constraint: 'Path to the file to render.' },
      { kind: 'flag', name: 'watch', type: 'bool', required: false, constraint: 'When present, live-update the pane on edits. Default off.' },
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
    const watch = (input['watch'] as boolean | undefined) === true;
    const windowArg = input['window'] as 'auto' | 'split' | 'new' | undefined;
    const window: 'auto' | 'split' | 'new' = windowArg !== undefined ? windowArg : 'auto';

    // `human show` must never fail the caller: any display error degrades to
    // {pane_id:null, reason} with exit 0 (matches humanloop display semantics).
    let paneId: string | undefined;
    try {
      const r = display(path, { watch, window, maxPanes: resolveMaxPanes() });
      paneId = r.paneId;
    } catch {
      paneId = undefined;
    }

    if (paneId !== undefined) {
      return { pane_id: paneId, reason: null };
    }
    const reason = isInTmux()
      ? 'renderer unavailable (termrender/uv missing)'
      : 'not in tmux';
    return { pane_id: null, reason };
  },
});

// ---------------------------------------------------------------------------
// inbox (human-invoked, blocking)
// ---------------------------------------------------------------------------

const humanInbox = defineLeaf({
  name: 'inbox',
  help: {
    name: 'human inbox',
    summary: 'interactively drain pending interactions at your own terminal',
    params: [],
    inputNote: 'No input. Run this at a human terminal — it blocks until the backlog is drained or you quit.',
    output: [{ name: 'drained', type: 'boolean', required: true, constraint: 'True once the loop returns.' }],
    outputKind: 'object',
    effects: ['Resolves pending interactions in the per-project interactions root via the TUI.'],
  },
  run: async () => {
    await inbox([interactionsRoot(process.cwd())]);
    return { drained: true };
  },
});

// ---------------------------------------------------------------------------
// list (read-only, paginated)
// ---------------------------------------------------------------------------

const humanList = defineLeaf({
  name: 'list',
  help: {
    name: 'human list',
    summary: 'paginated list of pending, unclaimed interactions, oldest first',
    params: [
      { kind: 'flag', name: 'limit', type: 'int', required: false, default: 20, constraint: 'Default 20, max 100.' },
      { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: "Opaque token from a previous response's next_cursor. Omit on first call." },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {id, dir, title, kind, blocked_since}. Oldest first.' },
      { name: 'next_cursor', type: 'string | null', required: true, constraint: 'Pass on the next call to continue. null means no more items.' },
      { name: 'total', type: 'integer | null', required: true, constraint: 'Total pending interactions.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const limitRaw = input['limit'] as number;
    const limit = Math.min(Math.max(1, limitRaw), 100);
    const cursor = input['cursor'] as string | undefined;

    const raw: InboxItem[] = scanInbox([interactionsRoot(process.cwd())]);
    const items = raw
      .map((i) => ({
        id: i.id,
        dir: i.dir,
        title: i.title !== undefined ? i.title : null,
        kind: i.kind !== undefined ? i.kind : null,
        blocked_since: i.blockedSince,
      }))
      .sort((a, b) => {
        const ka = `${a.blocked_since}|${a.id}`;
        const kb = `${b.blocked_since}|${b.id}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });

    const page = paginate(items, { limit, cursor }, {
      defaultLimit: 20,
      maxLimit: 100,
      keyOf: (i) => `${i.blocked_since}|${i.id}`,
      total: 'count',
    });

    return { items: page.items, next_cursor: page.next_cursor, total: page.total };
  },
});

// ---------------------------------------------------------------------------
// _run (hidden worker; not listed in branch help)
// ---------------------------------------------------------------------------

const humanRun = defineLeaf({
  name: '_run',
  help: {
    name: 'human _run',
    summary: 'internal: the detached worker that runs the blocking humanloop call at the pane TTY',
    params: [],
    inputNote: 'Internal; invoked by the spawned pane via CRTR_HUMAN_DIR + run.json. Not for manual use.',
    output: [{ name: 'none', type: 'void', required: false, constraint: 'No stdout; writes the job result file directly.' }],
    outputKind: 'object',
    effects: ['Runs the blocking humanloop call; for job-backed modes writes result.json via the job model.'],
  },
  run: async (): Promise<void> => {
    const dir = process.env['CRTR_HUMAN_DIR'];
    if (dir === undefined || dir === '') {
      process.exit(1);
    }
    const rc = readJson<RunRecord>(join(dir, 'run.json'));
    if (rc === null) {
      process.exit(1);
    }

    try {
      if (rc.mode === 'ask' || rc.mode === 'approve' || rc.mode === 'notify') {
        const deck: Deck = parseDeck(deckPath(dir));
        const env: ResolutionEnvelope = await ask(deck, { dir });
        if (rc.mode === 'ask') {
          writeResult(rc.job_id as string, env, 'done');
        } else if (rc.mode === 'approve') {
          const sel = env.responses.find((r) => r.id === rc.approve_iid)?.selectedOptionId;
          writeResult(
            rc.job_id as string,
            {
              approved: sel === 'yes',
              summary: env.summary,
              responses: env.responses,
              responsePath: env.responsePath,
              completedAt: env.completedAt,
            },
            'done',
          );
        }
        // notify: no job — nothing to write
      } else if (rc.mode === 'review') {
        const res: FeedbackResult = await launchReview(rc.file as string, {
          output: rc.output as string,
        });
        writeResult(rc.job_id as string, res, 'done');
      }
    } catch (e) {
      if (rc.job_id !== undefined) {
        writeResult(rc.job_id, { error: 'human_run_failed', message: String(e) }, 'failed');
      }
    }
  },
});

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

export function registerHuman(): BranchDef {
  return defineBranch({
    name: 'human',
    help: {
      name: 'human',
      summary: 'human-in-the-loop decisions, document review, and live display',
      model:
        "Kickoff leaves create kind:'human' jobs. Humans respond on human time (often >10 min) — never block waiting on the result; peek with `crtr job read result|status` (no `wait`). Cancel with `crtr job cancel`. notify/show create no job.",
      children: [
        { name: 'ask', desc: 'put a decision deck to a person', useWhen: 'a structured choice needs a human' },
        { name: 'approve', desc: 'a Yes/No approval gate', useWhen: 'gating a handoff on human sign-off' },
        { name: 'review', desc: 'anchored-comment review of a .md', useWhen: 'a human should comment on a plan or spec' },
        { name: 'notify', desc: 'fire-and-forget acknowledgement', useWhen: 'informing a person without blocking' },
        { name: 'show', desc: 'put a file live on screen', useWhen: 'displaying a doc while a human comments' },
        { name: 'inbox', desc: 'interactively drain pending interactions', useWhen: 'a human clears the queue at their terminal' },
        { name: 'list', desc: 'enumerate pending interactions', useWhen: 'discovering what is blocked on a human' },
      ],
    },
    children: [
      humanAsk,
      humanApprove,
      humanReview,
      humanNotify,
      humanShow,
      humanInbox,
      humanList,
      humanRun,
    ],
  });
}
