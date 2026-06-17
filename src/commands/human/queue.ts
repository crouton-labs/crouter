import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { pushFinal } from '../../core/feed/feed.js';
import { interactionsRoot, interactionDir } from '../../core/artifact.js';
import { paginate } from '../../core/pagination.js';
import { getNode, listNodes, subscribersOf } from '../../core/canvas/index.js';
import { transition } from '../../core/runtime/lifecycle.js';
import { appendInbox } from '../../core/feed/inbox.js';
import { closeSync, existsSync, linkSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  inbox,
  scanInbox,
  parseDeck,
  deckPath,
  responsePath,
  progressPath,
  isResolved,
  atomicWriteJson,
  ask,
  launchReview,
  readJson,
  display,
} from '@crouton-kit/humanloop';
import type {
  InboxItem,
  Deck,
  ResolutionEnvelope,
  FeedbackResult,
  InteractionResponse,
} from '@crouton-kit/humanloop';
import { killPane, type RunRecord } from './shared.js';

// ---------------------------------------------------------------------------
// stranded-answer healing
// ---------------------------------------------------------------------------

/** A deterministic one-line-per-interaction summary, mirroring humanloop's
 *  `<id>: <option>[ — <freetext>]` shape. Used when reconstructing a
 *  ResolutionEnvelope from a bare on-disk response.json (which stores only
 *  `{responses, completedAt}`), so a healed deliver-back reads like the live one. */
function summarizeResponses(responses: InteractionResponse[], deck?: Deck): string {
  const interactions = new Map((deck?.interactions ?? []).map((it) => [it.id, it]));
  return responses
    .map((r) => {
      const it = interactions.get(r.id);
      let picked = '';
      if (r.selectedOptionIds !== undefined) {
        picked = r.selectedOptionIds
          .map((id) => {
            const label = it?.options.find((o) => o.id === id)?.label ?? id;
            const note = r.optionComments?.[id];
            return typeof note === 'string' && note.trim() !== '' ? `${label} ("${note.trim()}")` : label;
          })
          .join(', ');
      } else if (r.selectedOptionId !== undefined) {
        picked = it?.options.find((o) => o.id === r.selectedOptionId)?.label ?? r.selectedOptionId;
      }
      const ft = typeof r.freetext === 'string' && r.freetext.trim() !== '' ? ` — ${r.freetext.trim()}` : '';
      return `${it?.title ?? r.id}: ${picked}${ft}`;
    })
    .join('\n');
}

/** Deliver-back + reap an interaction whose answer is on disk but was never
 *  delivered. The detached `_run` worker's `pushFinal` is normally the SOLE
 *  deliver-back + reap step; when it never ran (e.g. a broker asker pre-fix, or
 *  a human draining via `crtr human inbox`, which writes response.json directly
 *  and never calls pushFinal), the answer strands and the bridge node leaks.
 *
 *  Idempotent and self-gating: a no-op unless the bridge node is still LIVE
 *  (active|idle) AND its interaction is resolved on disk — so it never
 *  double-delivers an interaction the `_run` worker already finalized (pushFinal
 *  flips status=done). Reconstructs the same pushFinal body `_run` would have
 *  emitted, per mode; a canceled-on-disk response reaps the node without
 *  delivering a result (mirrors `human cancel`). Returns true iff it acted. */
export async function finalizeResolvedInteraction(jobId: string, claim?: InteractionClaim): Promise<boolean> {
  const firstNode = getNode(jobId);
  if (firstNode === null) return false;
  const idir = interactionDir(jobId, firstNode.cwd);
  const ownedClaim = claim ?? acquireInteractionClaim(idir, jobId, { allowResolved: true });
  if (ownedClaim === 'already_resolved' || ownedClaim === 'claimed') return false;
  try {
    const node = getNode(jobId);
    if (node === null) return false;
    if (node.status !== 'active' && node.status !== 'idle') return false;
    if (!isResolved(idir)) return false;
    const rc = readJson<RunRecord>(join(idir, 'run.json'));
    if (rc === null) return false;
    const resp = readJson<Record<string, unknown>>(responsePath(idir));
    if (resp === null) return false;

    // Canceled out-of-band (a raw canceled response.json, not via `human cancel`):
    // there is no answer to deliver — just reap the node and tell waiting
    // subscribers no answer is coming, the same quiet deferred note `human cancel`
    // emits. (`finalize` is legal from active|idle; the status guard above holds.)
    if (resp['canceled'] === true) {
      transition(jobId, 'finalize');
      const note = typeof resp['reason'] === 'string' && resp['reason'] !== '' ? ` — ${resp['reason']}` : '';
      for (const sub of subscribersOf(jobId)) {
        appendInbox(sub.node_id, {
          from: jobId,
          tier: 'deferred',
          kind: 'message',
          label: `human interaction ${jobId} canceled — no answer is coming${note}`,
          data: { body: `The human interaction ${jobId} was canceled${note}. No response will arrive.` },
        });
      }
      return true;
    }

    const responses = (resp['responses'] as InteractionResponse[] | undefined) ?? [];
    const completedAt = (resp['completedAt'] as string | undefined) ?? new Date().toISOString();
    let deck: Deck | undefined;
    try { deck = parseDeck(deckPath(idir)); } catch { deck = undefined; }
    const summary = summarizeResponses(responses, deck);

    // ask (and any other answered deck): the full ResolutionEnvelope shape.
    const env: ResolutionEnvelope = {
      summary,
      responsePath: responsePath(idir),
      schema: 'humanloop.response/v2',
      responses,
      completedAt,
    };
    await pushFinal(jobId, JSON.stringify(env));
    return true;
  } finally {
    if (claim === undefined) ownedClaim.release();
  }
}

/** Sweep every interaction under the cwd's interactions root and deliver-back +
 *  reap any that are answered-but-undelivered (see finalizeResolvedInteraction).
 *  Interaction dir names ARE the bridge node ids. Returns how many it healed. */
export async function healStrandedInteractions(cwd: string): Promise<number> {
  const root = interactionsRoot(cwd);
  if (!existsSync(root)) return 0;
  let healed = 0;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (await finalizeResolvedInteraction(ent.name)) healed++;
  }
  return healed;
}

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
    output: [
      { name: 'drained', type: 'boolean', required: true, constraint: 'True once the loop returns.' },
      { name: 'delivered', type: 'integer', required: true, constraint: 'How many answered-but-undelivered interactions were delivered back to their askers and reaped.' },
    ],
    outputKind: 'object',
    effects: [
      'Resolves pending interactions in the per-project interactions root via the TUI.',
      'Delivers any answered-but-undelivered interaction back to its asking node and reaps the bridge node (the deliver-back the detached _run worker would have done).',
    ],
  },
  run: async () => {
    await inbox([interactionsRoot(process.cwd())]);
    // humanloop's inbox() writes response.json but never calls pushFinal — so a
    // deck drained here would strand (no answer-back, leaked bridge node). Heal
    // every resolved-but-live interaction: deliver its answer to the asker + reap.
    const delivered = await healStrandedInteractions(process.cwd());
    return { drained: true, delivered };
  },
});

// ---------------------------------------------------------------------------
// deck provenance + read/resolve helpers
// ---------------------------------------------------------------------------

interface DeckNodeRef {
  node_id: string;
  name: string;
  cwd: string;
  parent: string | null;
}

interface DeckSummaryRow {
  id: string;
  dir: string;
  title: string | null;
  kind: string | null;
  blocked_since: string;
  asking_node_id?: string;
  asking_node_name?: string;
  conversation_id?: string;
  conversation_title?: string;
  interaction_count?: number;
  job_id?: string;
}

function allInteractionRoots(): string[] {
  const roots = new Set<string>();
  roots.add(interactionsRoot(process.cwd()));
  for (const node of listNodes()) roots.add(interactionsRoot(node.cwd));
  return [...roots];
}

function nodeRefs(): DeckNodeRef[] {
  return listNodes().map((n) => ({ node_id: n.node_id, name: n.name, cwd: n.cwd, parent: n.parent }));
}

function resolveConversation(asking: DeckNodeRef | undefined, nodes: DeckNodeRef[]): DeckNodeRef | undefined {
  if (asking === undefined) return undefined;
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  let cur = asking;
  const seen = new Set<string>();
  while (cur.parent !== null && !seen.has(cur.node_id)) {
    seen.add(cur.node_id);
    const parent = byId.get(cur.parent);
    if (parent === undefined) break;
    cur = parent;
  }
  return cur;
}

function askingNodeFor(jobId: string, deck: Deck | null, dir: string, nodes: DeckNodeRef[]): DeckNodeRef | undefined {
  const stamped = deck?.source?.nodeId;
  if (stamped !== undefined && stamped !== '') {
    const found = nodes.find((n) => n.node_id === stamped);
    if (found !== undefined) return found;
  }
  const bridge = getNode(jobId);
  if (bridge?.parent !== undefined && bridge.parent !== null) {
    const parent = nodes.find((n) => n.node_id === bridge.parent);
    if (parent !== undefined) return parent;
  }
  for (const n of nodes) {
    const root = interactionsRoot(n.cwd);
    if (dir === root || dir.startsWith(`${root}/`)) return n;
  }
  return bridge !== null ? { node_id: bridge.node_id, name: bridge.name, cwd: bridge.cwd, parent: bridge.parent ?? null } : undefined;
}

function summarizeDeckItem(item: InboxItem, deck: Deck | null, nodes: DeckNodeRef[]): DeckSummaryRow | null {
  const jobId = basename(item.dir);
  if (getNode(jobId) === null) return null;
  const asking = askingNodeFor(jobId, deck, item.dir, nodes);
  const conversation = resolveConversation(asking, nodes);
  return {
    id: item.id,
    job_id: jobId,
    dir: item.dir,
    title: item.title !== undefined ? item.title : deck?.title ?? null,
    kind: item.kind !== undefined ? item.kind : deck?.interactions[0]?.kind ?? null,
    blocked_since: item.blockedSince,
    ...(asking !== undefined ? { asking_node_id: asking.node_id, asking_node_name: asking.name } : {}),
    ...(conversation !== undefined ? { conversation_id: conversation.node_id, conversation_title: conversation.name } : {}),
    ...(deck !== null ? { interaction_count: deck.interactions.length } : {}),
  };
}

function interactionDirForJob(jobId: string): { dir: string } {
  const node = getNode(jobId);
  if (node === null) {
    throw new InputError({ error: 'not_found', message: `no interaction node: ${jobId}`, field: 'job_id', next: 'Pass a job_id from `crtr human list`.' });
  }
  return { dir: interactionDir(jobId, node.cwd) };
}

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
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {id, dir, title, kind, blocked_since}, enriched when derivable with asking_node_id/name, conversation_id/title, interaction_count. Oldest first.' },
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

    const nodes = nodeRefs();
    const raw: InboxItem[] = scanInbox(allInteractionRoots());
    const items = raw
      .flatMap((i) => {
        const item = summarizeDeckItem(i, readJson<Deck>(deckPath(i.dir)), nodes);
        return item === null ? [] : [item];
      })
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
// deck detail (read-only)
// ---------------------------------------------------------------------------

export const humanDeck = defineLeaf({
  name: 'deck',
  description: 'read one pending humanloop deck',
  whenToUse: 'you need the full questions/options for a pending human interaction',
  help: {
    name: 'human deck',
    summary: 'read full pending deck detail for one human interaction job',
    params: [{ kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'job_id from human ask/review/list.' }],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'Interaction job id.' },
      { name: 'interactions', type: 'object[]', required: true, constraint: 'Deck interactions with options and freetext policy.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads deck.json from the interaction dir resolved through the canvas node cwd.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const { dir } = interactionDirForJob(jobId);
    if (isResolved(dir)) {
      throw new InputError({ error: 'already_resolved', message: `interaction already resolved: ${jobId}`, field: 'job_id', next: 'Use `crtr human list` for pending interactions.' });
    }
    let deck: Deck;
    try {
      deck = parseDeck(deckPath(dir));
    } catch {
      throw new InputError({ error: 'not_found', message: `no deck for interaction: ${jobId}`, field: 'job_id', next: 'Pass a pending job_id from `crtr human list`.' });
    }
    const nodes = nodeRefs();
    const asking = askingNodeFor(jobId, deck, dir, nodes);
    const conversation = resolveConversation(asking, nodes);
    const first = deck.interactions[0];
    return {
      id: jobId,
      title: deck.title ?? first?.title ?? null,
      kind: first?.kind ?? null,
      blocked_since: deck.source?.blockedSince ?? null,
      ...(asking !== undefined ? { asking_node_id: asking.node_id, asking_node_name: asking.name } : {}),
      ...(conversation !== undefined ? { conversation_id: conversation.node_id, conversation_title: conversation.name } : {}),
      interaction_count: deck.interactions.length,
      interactions: deck.interactions.map((it) => ({
        id: it.id,
        kind: it.kind ?? null,
        prompt: it.body ?? it.title,
        options: it.options.map((o) => ({ id: o.id, label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })),
        allow_freetext: it.allowFreetext ?? false,
        ...(it.preAnswered?.selectedOptionId !== undefined ? { default_option_id: it.preAnswered.selectedOptionId } : {}),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// resolve — non-interactive human answer write + deliver-back
// ---------------------------------------------------------------------------

interface ResolveInputResponse {
  interaction_id?: string;
  id?: string;
  selected_option_ids?: string[];
  selected_option_id?: string;
  selectedOptionIds?: string[];
  selectedOptionId?: string;
  freetext?: string;
  optionComments?: Record<string, string>;
}

interface InteractionClaim {
  release: () => void;
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as NodeJS.ErrnoException).code === code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (isErrno(e, 'ESRCH')) return false;
    return true;
  }
}

function interactionLockPath(dir: string): string {
  return join(dir, 'resolve.lock');
}

function releaseClaim(dir: string, token: string): void {
  const lockFile = interactionLockPath(dir);
  const cur = readJson<{ token?: string }>(lockFile);
  if (cur?.token === token) {
    try {
      unlinkSync(lockFile);
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
    }
  }
  const progressFile = progressPath(dir);
  const progress = readJson<{ claimToken?: string }>(progressFile);
  if (progress?.claimToken !== token) return;
  try {
    unlinkSync(progressFile);
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) throw e;
  }
}

export function acquireInteractionClaim(
  dir: string,
  jobId: string,
  opts: { allowResolved?: boolean; markProgress?: boolean; respectProgress?: boolean } = {},
): InteractionClaim | 'already_resolved' | 'claimed' {
  const allowResolved = opts.allowResolved === true;
  const markProgress = opts.markProgress === true;
  const respectProgress = opts.respectProgress === true;
  const lockFile = interactionLockPath(dir);
  const progressFile = progressPath(dir);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  for (;;) {
    if (!allowResolved && isResolved(dir)) return 'already_resolved';
    if (!allowResolved && respectProgress && existsSync(progressFile) && !existsSync(lockFile)) {
      const progress = readJson<{ claim?: string }>(progressFile);
      if (progress?.claim === 'crtr human resolve') {
        try {
          unlinkSync(progressFile);
        } catch (e) {
          if (!isErrno(e, 'ENOENT')) return 'claimed';
        }
      } else {
        return 'claimed';
      }
    }
    let fd: number | null = null;
    try {
      fd = openSync(lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, jobId, claimedAt: new Date().toISOString() }, null, 2));
      closeSync(fd);
      fd = null;
      if (markProgress) {
        atomicWriteJson(progressFile, { partial: true, claim: 'crtr human resolve', claimToken: token, jobId, claimedAt: new Date().toISOString() });
      }
      if (!allowResolved && isResolved(dir)) {
        releaseClaim(dir, token);
        return 'already_resolved';
      }
      return { release: () => releaseClaim(dir, token) };
    } catch (e) {
      if (fd !== null) closeSync(fd);
      if (isErrno(e, 'EEXIST')) {
        const owner = readJson<{ pid?: number }>(lockFile);
        if (typeof owner?.pid === 'number' && !pidAlive(owner.pid)) {
          try {
            unlinkSync(lockFile);
          } catch (unlinkErr) {
            if (!isErrno(unlinkErr, 'ENOENT')) return 'claimed';
          }
          continue;
        }
        return 'claimed';
      }
      throw e;
    }
  }
}

function writeResponseOnce(dir: string, responses: InteractionResponse[], completedAt: string): 'written' | 'already_resolved' {
  const finalPath = responsePath(dir);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ responses, completedAt }, null, 2), { flag: 'wx' });
  try {
    linkSync(tmpPath, finalPath);
    return 'written';
  } catch (e) {
    if (isErrno(e, 'EEXIST')) return 'already_resolved';
    throw e;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
    }
  }
}

function validateResolveResponses(deck: Deck, responses: InteractionResponse[]): void {
  const byId = new Map(deck.interactions.map((it) => [it.id, it]));
  for (const response of responses) {
    const interaction = byId.get(response.id);
    if (interaction === undefined) {
      throw new InputError({ error: 'invalid_field', message: `unknown interaction_id: ${response.id}`, field: 'responses', next: 'Use interaction ids from `crtr human deck <job_id> --json`.' });
    }
    if (interaction.multiSelect === true) {
      if (response.selectedOptionId !== undefined) {
        throw new InputError({ error: 'invalid_field', message: `interaction ${response.id} is multi-select; use selected_option_ids`, field: 'responses', next: 'Use selected_option_ids for multi-select interactions.' });
      }
    } else if (response.selectedOptionIds !== undefined && response.selectedOptionIds.length > 1) {
      throw new InputError({ error: 'invalid_field', message: `interaction ${response.id} is single-select`, field: 'responses', next: 'Use selected_option_id or one selected_option_ids value for single-select interactions.' });
    }
    const selected = response.selectedOptionIds ?? (response.selectedOptionId !== undefined ? [response.selectedOptionId] : []);
    const optionIds = new Set(interaction.options.map((o) => o.id));
    for (const id of selected) {
      if (!optionIds.has(id)) {
        throw new InputError({ error: 'invalid_field', message: `unknown option id for ${response.id}: ${id}`, field: 'responses', next: 'Use option ids from `crtr human deck <job_id> --json`.' });
      }
    }
  }
}

function parseResolveBody(raw: string): { responses: InteractionResponse[]; completedAt: string } {
  let parsed: { responses?: ResolveInputResponse[]; completed_at?: string; completedAt?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (e) {
    throw new InputError({ error: 'invalid_json', message: `stdin is not valid JSON: ${String(e)}`, field: 'stdin', next: 'Pass {"responses":[{"interaction_id":"..."}]} on stdin.' });
  }
  if (!Array.isArray(parsed.responses)) {
    throw new InputError({ error: 'invalid_field', message: 'responses must be an array', field: 'responses', next: 'Pass {"responses":[{"interaction_id":"...","selected_option_ids":["..."]}]}.' });
  }
  return {
    responses: parsed.responses.map((r) => {
      const id = r.interaction_id ?? r.id;
      if (id === undefined || id === '') {
        throw new InputError({ error: 'invalid_field', message: 'each response needs interaction_id', field: 'responses', next: 'Include interaction_id for every response.' });
      }
      const selectedOptionIds = r.selected_option_ids ?? r.selectedOptionIds;
      const selectedOptionId = r.selected_option_id ?? r.selectedOptionId;
      return {
        id,
        ...(selectedOptionIds !== undefined ? { selectedOptionIds } : {}),
        ...(selectedOptionId !== undefined ? { selectedOptionId } : {}),
        ...(r.freetext !== undefined ? { freetext: r.freetext } : {}),
        ...(r.optionComments !== undefined ? { optionComments: r.optionComments } : {}),
      };
    }),
    completedAt: parsed.completed_at ?? parsed.completedAt ?? new Date().toISOString(),
  };
}

export const humanResolve = defineLeaf({
  name: 'resolve',
  description: 'resolve one humanloop deck from stdin answers',
  whenToUse: 'a browser or local tool is submitting answers for a pending human interaction; this writes through the crouter/humanloop finalize path',
  help: {
    name: 'human resolve',
    summary: 'write deck answers atomically and deliver them back to the asking node',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'job_id from human ask/review/list.' },
      { kind: 'stdin', name: 'body', required: true, constraint: 'JSON {responses:[{interaction_id, selected_option_ids?, freetext?}], completed_at?}.' },
    ],
    output: [
      { name: 'resolved', type: 'boolean', required: true, constraint: 'True when this call wrote and delivered the answer.' },
      { name: 'job_id', type: 'string', required: true, constraint: 'Interaction job id.' },
      { name: 'delivered', type: 'boolean', required: false, constraint: 'True when delivered through crouter push/finalize.' },
      { name: 'reason', type: 'string', required: false, constraint: 'already_resolved or claimed when resolved is false.' },
    ],
    outputKind: 'object',
    effects: ['Claims the interaction with a local resolve.lock (and progress.json so other humanloop inbox scans skip it), writes response.json with an exclusive no-clobber create, then calls crouter finalize/deliver-back. Does not write response.json from browser/server code.'],
  },
  run: async (input) => {
    const jobId = input['job_id'] as string;
    const { dir } = interactionDirForJob(jobId);
    const { responses, completedAt } = parseResolveBody(input['body'] as string);
    try {
      parseDeck(deckPath(dir));
    } catch {
      throw new InputError({ error: 'not_found', message: `no deck for interaction: ${jobId}`, field: 'job_id', next: 'Pass a pending job_id from `crtr human list`.' });
    }
    const claim = acquireInteractionClaim(dir, jobId, { markProgress: true, respectProgress: true });
    if (claim === 'already_resolved') return { resolved: false, job_id: jobId, reason: 'already_resolved' };
    if (claim === 'claimed') return { resolved: false, job_id: jobId, reason: 'claimed' };
    try {
      let deck: Deck;
      try {
        deck = parseDeck(deckPath(dir));
      } catch {
        throw new InputError({ error: 'not_found', message: `no deck for interaction: ${jobId}`, field: 'job_id', next: 'Pass a pending job_id from `crtr human list`.' });
      }
      validateResolveResponses(deck, responses);
      const writeResult = writeResponseOnce(dir, responses, completedAt);
      if (writeResult === 'already_resolved') return { resolved: false, job_id: jobId, reason: 'already_resolved' };
      const delivered = await finalizeResolvedInteraction(jobId, claim);
      if (!delivered) return { resolved: false, job_id: jobId, reason: 'already_resolved' };
      return { resolved: true, job_id: jobId, delivered };
    } finally {
      claim.release();
    }
  },
});

// ---------------------------------------------------------------------------
// cancel — retract a pending ask/review
// ---------------------------------------------------------------------------

export const humanCancel = defineLeaf({
  name: 'cancel',
  description: 'retract a pending ask/review',
  whenToUse: 'a question went stale before the human answered',
  help: {
    name: 'human cancel',
    summary:
      'retract a pending ask/review you posed — kills its TUI pane, drops it from the human queue, and retires the node. Reach for this the moment a question goes stale (you answered it yourself, the situation changed) so a human is not left resolving a prompt whose answer no longer matters',
    guide:
      'Pass the job_id returned by `human ask`/`review`. Best-effort and idempotent: if the human already answered, or it was already canceled, it reports canceled:false with reason "already_resolved" and changes nothing. The agent that posed the deck is almost always the one canceling it, so the caller is never messaged — only OTHER subscribers (e.g. the asking node when a human dismisses the prompt) get a quiet deferred note that no answer is coming. Canceling a review kills its live on-screen pane and delivers no comments — the same quiet deferred note covers it.',
    params: [
      { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Node id of the interaction to cancel — the job_id returned by ask/review.' },
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
        next: 'Pass the job_id from human ask/review, or list pending with `crtr human list`.',
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
      if (rc.mode === 'ask' || rc.mode === 'notify') {
        const deck: Deck = parseDeck(deckPath(dir));
        if (rc.mode === 'ask') {
          const claim = acquireInteractionClaim(dir, rc.job_id as string);
          if (claim === 'already_resolved') {
            await finalizeResolvedInteraction(rc.job_id as string);
            return;
          }
          if (claim === 'claimed') return;
          try {
            await ask(deck, { dir });
            // Pass the held claim: finalize re-acquires the same exclusive
            // resolve.lock, which THIS worker still holds — without the claim it
            // would see its own live lock, return 'claimed', and never deliver
            // the answer (stranding the asker). The held claim makes finalize
            // run under our lock; _run's finally still owns the release.
            await finalizeResolvedInteraction(rc.job_id as string, claim);
          } finally {
            claim.release();
          }
        } else {
          await ask(deck, { dir });
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
