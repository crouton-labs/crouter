import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { pushFinal } from '../../core/feed/feed.js';
import { interactionsRoot, interactionDir } from '../../core/artifact.js';
import { paginate } from '../../core/pagination.js';
import { getNode, subscribersOf } from '../../core/canvas/index.js';
import { transition } from '../../core/runtime/lifecycle.js';
import { appendInbox } from '../../core/feed/inbox.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  inbox,
  scanInbox,
  parseDeck,
  deckPath,
  responsePath,
  isResolved,
  atomicWriteJson,
  ask,
  launchReview,
  readJson,
  display,
} from '@crouton-kit/humanloop';
import type { InboxItem, Deck, ResolutionEnvelope, FeedbackResult } from '@crouton-kit/humanloop';
import { killPane, type RunRecord } from './shared.js';

// ---------------------------------------------------------------------------
// inbox (human-invoked, blocking)
// ---------------------------------------------------------------------------

export const humanInbox = defineLeaf({
  name: 'inbox',
  description: 'interactively drain pending interactions',
  whenToUse: 'a human is clearing the queue at their terminal',
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

export const humanList = defineLeaf({
  name: 'list',
  description: 'enumerate pending interactions',
  whenToUse: 'discovering what is blocked on a human',
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
// cancel — retract a pending ask/approve/review
// ---------------------------------------------------------------------------

export const humanCancel = defineLeaf({
  name: 'cancel',
  description: 'retract a pending ask/approve/review',
  whenToUse: 'a question went stale before the human answered',
  help: {
    name: 'human cancel',
    summary:
      'retract a pending ask/approve/review you posed — kills its TUI pane, drops it from the human queue, and retires the node. Reach for this the moment a question goes stale (you answered it yourself, the situation changed) so a human is not left resolving a prompt whose answer no longer matters',
    guide:
      'Pass the job_id returned by `human ask`/`approve`/`review`. Best-effort and idempotent: if the human already answered, or it was already canceled, it reports canceled:false with reason "already_resolved" and changes nothing. The agent that posed the deck is almost always the one canceling it, so the caller is never messaged — only OTHER subscribers (e.g. the asking node when a human dismisses the prompt) get a quiet deferred note that no answer is coming. Canceling a review kills its live on-screen pane and delivers no comments — the same quiet deferred note covers it.',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Node id of the interaction to cancel — the job_id returned by ask/approve/review.' },
      { kind: 'flag', name: 'reason', type: 'string', required: false, constraint: 'Optional short note delivered to subscribers explaining why it was retracted.' },
    ],
    output: [
      { name: 'canceled', type: 'boolean', required: true, constraint: 'True when the interaction was retracted; false when there was nothing live to cancel (already answered/canceled).' },
      { name: 'job_id', type: 'string', required: true, constraint: 'The interaction node id.' },
      { name: 'reason', type: 'string', required: false, constraint: 'Why nothing was canceled (e.g. "already_resolved"), present when canceled is false.' },
    ],
    outputKind: 'object',
    effects: [
      "Kills the detached TUI pane (if any) so the prompt leaves the human's screen.",
      'Writes a canceled response.json so the interaction drops out of `human list`/`inbox`.',
      'Marks the node done and, only for subscribers other than the caller, drops a deferred note that no answer is coming.',
    ],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const reason = input['reason'] as string | undefined;

    const node = getNode(jobId);
    if (node === null) {
      throw new InputError({
        error: 'not_found',
        message: `no interaction node: ${jobId}`,
        field: 'job_id',
        next: 'Pass the job_id from human ask/approve/review, or list pending with `crtr human list`.',
      });
    }

    // Resolve the interaction dir from the node's RECORDED cwd: interaction dirs
    // are keyed by the asking process's cwd, which may differ from the caller's.
    const idir = interactionDir(jobId, node.cwd);

    // Nothing live to cancel: the human already answered, or it was retired.
    // 'canceled' is in the guard too so transition('finalize') below — legal only
    // from active|idle — can never throw on an already-canceled (but unresolved)
    // interaction node.
    if (node.status === 'done' || node.status === 'dead' || node.status === 'canceled' || isResolved(idir)) {
      return { canceled: false, job_id: jobId, reason: 'already_resolved' };
    }

    // (1) Kill the detached TUI pane so the prompt (or a review's live doc) leaves
    //     the human's screen. Pass `idir` so killPane only fires when the target
    //     pane is provably the worker we spawned for THIS job (its launch command
    //     carries CRTR_HUMAN_DIR=idir) — never the agent's own pane or a shell.
    const rc = readJson<RunRecord>(join(idir, 'run.json'));
    if (rc?.pane_id !== undefined && rc.pane_id !== '') killPane(rc.pane_id, idir);
    // A review also opened a live termrender render pane beside the editor —
    // kill it too or it outlives the canceled job. Verified against the
    // reviewed file path, which termrender bakes into the pane's start command
    // (`termrender doc watch ... <file>`), so this can only ever hit our pane.
    if (rc?.render_pane_id !== undefined && rc.render_pane_id !== '' && typeof rc.file === 'string' && rc.file !== '') {
      killPane(rc.render_pane_id, rc.file);
    }

    // (2) Drop it from the human queue: a response.json marks the dir resolved,
    //     so scanInbox (human list/inbox) skips it.
    if (existsSync(idir)) {
      atomicWriteJson(responsePath(idir), {
        canceled: true,
        canceledAt: new Date().toISOString(),
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      });
    }

    // (3) Retire the node. We do NOT push a -final.md report: a cancel must not
    //     masquerade as a human-submitted result. Subscribers get the quiet
    //     deferred 'no answer is coming' note below instead.
    transition(jobId, 'finalize');
    // Almost always the asking agent cancels its OWN deck — it already knows, so
    // never message the caller. Only a third-party cancel (a human, an
    // orchestrator) leaves a genuinely-waiting asker uninformed; give them a
    // quiet deferred note (informational, never nudges) so nobody waits forever.
    const caller = process.env['CRTR_NODE_ID'] ?? 'human';
    const note = reason !== undefined && reason !== '' ? ` — ${reason}` : '';
    for (const sub of subscribersOf(jobId)) {
      if (sub.node_id === caller) continue; // don't ping whoever issued the cancel
      appendInbox(sub.node_id, {
        from: caller,
        tier: 'deferred',
        kind: 'message',
        label: `human interaction ${jobId} canceled — no answer is coming${note}`,
        data: { body: `The human interaction ${jobId} was canceled${note}. No response will arrive.` },
      });
    }

    return { canceled: true, job_id: jobId };
  },
  render: (r) =>
    r['canceled'] === true
      ? `Canceled human interaction ${r['job_id']} — its TUI pane is closed and subscribers were notified no answer is coming.`
      : `Nothing to cancel for ${r['job_id']} — ${r['reason'] ?? 'nothing to cancel'}.`,
});

// ---------------------------------------------------------------------------
// _run (hidden worker; not listed in branch help)
// ---------------------------------------------------------------------------

export const humanRun = defineLeaf({
  name: '_run',
  tier: 'hidden',
  help: {
    name: 'human _run',
    summary: 'internal: the detached worker that runs the blocking humanloop call at the pane TTY',
    params: [],
    inputNote: 'Internal; invoked by the spawned pane via CRTR_HUMAN_DIR + run.json. Not for manual use.',
    output: [{ name: 'none', type: 'void', required: false, constraint: 'No stdout; writes the job result file directly.' }],
    outputKind: 'object',
    effects: ['Runs the blocking humanloop call; for tracked modes pushes the result as the node\'s final report (fans out to the asking node\'s inbox).'],
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
          await pushFinal(rc.job_id as string, JSON.stringify(env));
        } else if (rc.mode === 'approve') {
          const sel = env.responses.find((r) => r.id === rc.approve_iid)?.selectedOptionId;
          await pushFinal(
            rc.job_id as string,
            JSON.stringify({
              approved: sel === 'yes',
              summary: env.summary,
              responses: env.responses,
              responsePath: env.responsePath,
              completedAt: env.completedAt,
            }),
          );
        }
        // notify: no job — nothing to write
      } else if (rc.mode === 'review') {
        // The _run worker is already its own dedicated tmux pane with a TTY, so
        // run nvim directly in it (noTmux) instead of letting launchReview
        // split off a SECOND pane and sit polling.
        //
        // BUG REGRESSION (raw-markdown review): the nvim buffer must stay the
        // RAW source — anchored comments hang off source line numbers — so the
        // termrender render the help promises (panels/callouts/mermaid) lives
        // in its OWN live pane opened beside this worker. `display` spawns the
        // managed termrender binary in watch mode, so it re-renders on every
        // save exactly like the nvim buffer reloads. Best-effort: off-tmux or
        // renderer-unavailable degrades to editor-only. The pane id is merged
        // into run.json so `human cancel` can kill it; the finally clears it on
        // every exit of the editor (submit, quit, or failure).
        let renderPane: string | undefined;
        try {
          renderPane = display(rc.file as string, { window: 'split' }).paneId;
        } catch {
          /* render pane is best-effort; the review itself must not die */
        }
        // Dock the render pane BESIDE this worker pane. tmux resolves an
        // untargeted split-window against the attached client's current window
        // (which wins over $TMUX_PANE), so the pane can land in whatever window
        // the user happens to be looking at — away from the editor. move-pane
        // with explicit src/dst is deterministic: raw source and rendered doc
        // always sit side by side.
        const selfPane = process.env['TMUX_PANE'];
        if (renderPane !== undefined && selfPane !== undefined && selfPane !== '') {
          spawnSync('tmux', ['move-pane', '-h', '-s', renderPane, '-t', selfPane], { stdio: 'ignore' });
        }
        if (renderPane !== undefined) {
          const rcPath = join(dir, 'run.json');
          const cur = readJson<RunRecord>(rcPath);
          if (cur !== null) atomicWriteJson(rcPath, { ...cur, render_pane_id: renderPane });
        }
        try {
          const res: FeedbackResult = await launchReview(rc.file as string, {
            output: rc.output as string,
            noTmux: true,
          });
          await pushFinal(rc.job_id as string, JSON.stringify(res));
        } finally {
          if (renderPane !== undefined) killPane(renderPane, rc.file as string);
        }
      }
    } catch (e) {
      if (rc.job_id !== undefined) {
        await pushFinal(rc.job_id, JSON.stringify({ error: 'human_run_failed', message: String(e) }));
      }
    }
  },
});
