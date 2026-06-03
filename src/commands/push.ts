// `crtr push` + `crtr feed` — the one verb up the graph, and its read side.
//
//   crtr push update [body]   — routine progress (also auto-emitted every stop)
//   crtr push urgent [body]   — force-wake subscribers
//   crtr push final  [body]   — finish: write result, mark node done, close window
//   crtr feed read            — drain the caller's (or a named) inbox into a digest
//
// "push" is THE verb a node uses to talk to its managers; the tier is the
// subcommand. The caller's node is resolved from CRTR_NODE_ID (injected by the
// runtime into every node process). Absent ⇒ InputError — push is only
// meaningful inside a live node.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef, LeafDef } from '../core/command.js';
import { InputError, readStdinRaw } from '../core/io.js';
import { push } from '../core/feed/feed.js';
import {
  readInboxSince,
  readCursor,
  writeCursor,
  coalesce,
  type InboxEntry,
} from '../core/feed/inbox.js';

function requireCallerNode(): string {
  const id = process.env['CRTR_NODE_ID'];
  if (id === undefined || id.trim() === '') {
    throw new InputError({
      error: 'no_node_context',
      message: 'CRTR_NODE_ID is not set — push runs inside a canvas node.',
      next: 'Run push from a node process spawned by the runtime.',
    });
  }
  return id.trim();
}

// ---------------------------------------------------------------------------
// push <tier> — one leaf per tier, sharing body resolution
// ---------------------------------------------------------------------------

type Tier = 'update' | 'urgent' | 'final';

const TIER_BLURB: Record<Tier, string> = {
  update: 'routine progress — fans a pointer to subscribers, no forced wake',
  urgent: 'force-wake subscribers (inbox tier urgent)',
  final: 'finish: write the canonical result, mark the node done, close its window',
};

function makeTierLeaf(tier: Tier): LeafDef {
  return defineLeaf({
    name: tier,
    help: {
      name: `push ${tier}`,
      summary: TIER_BLURB[tier],
      params: [
        { kind: 'stdin', name: 'body', required: true, constraint: 'Report body (markdown). Positional or stdin.' },
      ],
      output: [
        { name: 'report_path', type: 'string', required: true, constraint: 'Path of the written report.' },
        { name: 'delivered_to', type: 'string[]', required: true, constraint: 'Subscriber node ids that received a pointer.' },
        { name: 'status', type: 'string', required: true, constraint: '"done" for final, else "active".' },
      ],
      outputKind: 'object',
      effects: [
        'Writes nodes/<nodeId>/reports/<ts>-<tier>.md.',
        'Appends one inbox pointer per subscriber.',
        ...(tier === 'final' ? ['Marks the node done (status + intent); its window closes on next stop.'] : []),
      ],
    },
    run: async (input) => {
      const nodeId = requireCallerNode();
      let body = typeof input['body'] === 'string' ? (input['body'] as string).trim() : '';
      if (body === '') body = (await readStdinRaw()).trim();
      if (body === '') {
        throw new InputError({ error: 'missing_body', message: 'no report body', field: 'body', next: 'Pass the body as an argument or on stdin.' });
      }
      const result = await push(nodeId, { kind: tier, body });
      return { report_path: result.reportPath, delivered_to: result.deliveredTo, status: tier === 'final' ? 'done' : 'active' };
    },
  });
}

// ---------------------------------------------------------------------------
// feed read — drain the inbox
// ---------------------------------------------------------------------------

const feedReadLeaf = defineLeaf({
  name: 'read',
  help: {
    name: 'feed read',
    summary: 'drain unread inbox pointers for the caller (or a named node) into a compact digest',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node whose inbox to read. Defaults to CRTR_NODE_ID. Use to inspect a worker\'s inbox as an orchestrator.' },
      { kind: 'flag', name: 'all', type: 'bool', required: false, default: false, constraint: 'Ignore the cursor and return everything from the start.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'Node whose inbox was read.' },
      { name: 'digest', type: 'string', required: true, constraint: 'Coalesced digest — paste directly into a prompt.' },
      { name: 'entries', type: 'object[]', required: true, constraint: 'Raw InboxEntry objects.' },
      { name: 'cursor', type: 'string', required: true, constraint: 'New cursor ISO written after draining.' },
    ],
    outputKind: 'object',
    effects: ['Advances nodes/<nodeId>/inbox.jsonl.cursor.', 'Read-only on inbox.jsonl itself.'],
  },
  run: async (input) => {
    const nodeId =
      typeof input['node'] === 'string' && (input['node'] as string).trim() !== ''
        ? (input['node'] as string).trim()
        : requireCallerNode();
    const cursor = input['all'] === true ? undefined : readCursor(nodeId);
    const entries: InboxEntry[] = readInboxSince(nodeId, cursor);
    const newCursor = entries.length > 0 ? entries[entries.length - 1]!.ts : cursor ?? new Date().toISOString();
    writeCursor(nodeId, newCursor);
    return {
      node_id: nodeId,
      digest: coalesce(entries),
      entries: entries as unknown as Record<string, unknown>[],
      cursor: newCursor,
    };
  },
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPush(): BranchDef {
  return defineBranch({
    name: 'push',
    rootEntry: {
      concept: 'the one verb up the graph — a node reports to whoever subscribes to it',
      desc: 'push a report (update / urgent / final) to your subscribers',
      useWhen: 'sharing progress, raising an alert, or finishing your work',
    },
    help: {
      name: 'push',
      summary: 'push a report to your subscribers',
      model:
        'A push writes a markdown report to the node\'s reports/ history and fans a lightweight pointer to every subscriber\'s inbox (not the content — they dereference lazily). The stophook auto-pushes an `update` every stop, so the feed is continuous; you push explicitly for intentional signals. `push final` is how ANY node finishes: write the canonical result, mark done, close the window.',
      children: [
        { name: 'update', desc: TIER_BLURB.update, useWhen: 'sharing routine progress explicitly' },
        { name: 'urgent', desc: TIER_BLURB.urgent, useWhen: 'something your managers must see now' },
        { name: 'final', desc: TIER_BLURB.final, useWhen: 'the work is done — this finishes the node' },
      ],
    },
    children: [makeTierLeaf('update'), makeTierLeaf('urgent'), makeTierLeaf('final')],
  });
}

export function registerFeed(): BranchDef {
  return defineBranch({
    name: 'feed',
    rootEntry: {
      concept: 'the read side of the spine — pointers your subscriptions have pushed',
      desc: 'drain your inbox feed into a digest',
      useWhen: 'catching up on what the nodes you subscribe to have reported',
    },
    help: {
      name: 'feed',
      summary: 'read the per-node inbox feed',
      model:
        'Each node has an inbox.jsonl that accumulates ~30-token pointers from publishers it subscribes to. `feed read` coalesces unread pointers into one digest; dereference the reports that matter by reading their ref paths.',
      children: [{ name: 'read', desc: 'drain unread pointers into a digest', useWhen: 'checking what your subscriptions pushed' }],
    },
    children: [feedReadLeaf],
  });
}
