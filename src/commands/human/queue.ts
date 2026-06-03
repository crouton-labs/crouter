import { defineLeaf } from '../../core/command.js';
import { pushFinal } from '../../core/feed/feed.js';
import { interactionsRoot } from '../../core/artifact.js';
import { paginate } from '../../core/pagination.js';
import { join } from 'node:path';
import {
  inbox,
  scanInbox,
  parseDeck,
  deckPath,
  ask,
  launchReview,
  readJson,
} from '@crouton-kit/humanloop';
import type { InboxItem, Deck, ResolutionEnvelope, FeedbackResult } from '@crouton-kit/humanloop';
import type { RunRecord } from './shared.js';

// ---------------------------------------------------------------------------
// inbox (human-invoked, blocking)
// ---------------------------------------------------------------------------

export const humanInbox = defineLeaf({
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

export const humanList = defineLeaf({
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

export const humanRun = defineLeaf({
  name: '_run',
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
        // split off a SECOND pane and sit polling. This matches how ask/approve
        // render in-place and avoids the redundant side pane.
        const res: FeedbackResult = await launchReview(rc.file as string, {
          output: rc.output as string,
          noTmux: true,
        });
        await pushFinal(rc.job_id as string, JSON.stringify(res));
      }
    } catch (e) {
      if (rc.job_id !== undefined) {
        await pushFinal(rc.job_id, JSON.stringify({ error: 'human_run_failed', message: String(e) }));
      }
    }
  },
});
