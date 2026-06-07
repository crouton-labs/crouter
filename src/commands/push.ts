// `crtr push` + `crtr feed` — the one verb up the graph, and its read side.
//
//   crtr push update [body]   — routine progress to subscribers
//   crtr push urgent [body]   — force-wake subscribers
//   crtr push final  [body]   — finish: write result, mark node done, close window
//   crtr feed read            — drain the caller's (or a named) inbox into a digest
//   crtr feed peek            — live state of the nodes below you, cursor untouched
//
// "push" is THE verb a node uses to talk to its managers; the tier is the
// subcommand. The caller's node is resolved from CRTR_NODE_ID (injected by the
// runtime into every node process). Absent ⇒ InputError — push is only
// meaningful inside a live node.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef, LeafDef } from '../core/command.js';
import { InputError, readStdinRaw } from '../core/io.js';
import { push } from '../core/feed/feed.js';
import { getNode, subscribersOf, subscriptionsOf, fullName } from '../core/canvas/index.js';
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

const TIER_WHENTOUSE: Record<Tier, string> = {
  update:
    'you have routine progress worth surfacing to your managers but nothing that needs them to act right now — a checkpoint, a finished sub-step, a status note while you keep working, a heads-up on a decision you made. Fans a lightweight pointer to every subscriber without forcing a wake. Nothing is pushed automatically — your managers see only what you push explicitly, so reach for this whenever you want a progress signal to reach them. Use push urgent instead when a manager must see it immediately, push final when the work is actually done.',
  urgent:
    'something your managers must see and act on immediately — you are blocked and need a decision, you hit an error that derails the plan, a discovery changes the scope, or a child reported something that has to travel further up the chain now. Same report mechanism as push update, but it force-wakes every subscriber instead of waiting for them to drain their feed on their own time. Use push update instead for progress that can wait, push final when you are handing back a finished result rather than raising an alarm.',
  final:
    'the work this node was spawned to do is complete and you are ready to hand back the canonical result — this writes that result, marks the node done, and closes its window, so it is the LAST thing you do here, not a progress note. Any node finishes this way. Use push update or push urgent instead while work is still in flight, and do not reach for this on a node working directly with the user: it has no manager to report up to and would close mid-conversation (the guard blocks it unless you pass --force after the user confirms).',
};

function makeTierLeaf(tier: Tier): LeafDef {
  return defineLeaf({
    name: tier,
    description: TIER_BLURB[tier],
    whenToUse: TIER_WHENTOUSE[tier],
    help: {
      name: `push ${tier}`,
      summary: TIER_BLURB[tier],
      params: [
        { kind: 'stdin', name: 'body', required: true, constraint: `Report body (markdown). Positional or stdin — use stdin/heredoc for large bodies (\`crtr push ${tier} <<'EOF' … EOF\`).` },
        ...(tier === 'final'
          ? [{ kind: 'flag', name: 'force', type: 'bool', required: false, default: false, constraint: 'Override the guard that blocks `push final` on a human-attended node (a resident with no one to report up to). Only pass this after the user explicitly confirms they want this node finished.' } as const]
          : []),
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
      if (tier === 'final') {
        const node = getNode(nodeId);
        // A 2nd `push final` in one turn (or finalizing an already dead/canceled
        // node) is an illegal finalize-from-terminal: the underlying transition()
        // throws a raw Error that surfaces as an `internal` "crtr bug" on stderr.
        // Catch it here as a CLEAN user-facing error — the node is simply already
        // finished, so there is nothing to do.
        if (node !== null && node.status !== 'active' && node.status !== 'idle') {
          throw new InputError({
            error: 'already_finalized',
            message: `This node is already ${node.status} — \`push final\` finishes a node once and cannot finalize it again.`,
            next: 'Nothing to do here: the node is already finished. Do not push again from this node.',
          });
        }
        // A RESIDENT node with no subscribers is human-driven and has no one to
        // submit a canonical result to: `push final` fans to subscribers, and a
        // resident root conversation has none. Finishing it would close its window
        // mid-conversation. Block that unless the user confirms (--force). Keyed on
        // lifecycle, NOT subscriber-count alone: a TERMINAL node with no subscribers
        // was deliberately terminalized to owe a final — it self-completes here
        // (records the result, reaps) rather than being blocked for lack of a recipient.
        if (input['force'] !== true) {
          const noRecipient = node !== null && node.lifecycle === 'resident' && subscribersOf(nodeId).length === 0;
          if (noRecipient) {
            throw new InputError({
              error: 'no_final_recipient',
              message:
                'This node is working directly with the user — it has no manager to submit a final result to. `push final` would close its window mid-conversation.',
              next:
                'You almost certainly do NOT need to finish here — just keep working with the user. If the user has explicitly asked you to finish and close this node, confirm with them first, then rerun with `crtr push final --force "<result>"`.',
            });
          }
        }
      }
      const result = await push(nodeId, { kind: tier, body });
      return { report_path: result.reportPath, delivered_to: result.deliveredTo, status: tier === 'final' ? 'done' : 'active' };
    },
    render: (r) => {
      const n = Array.isArray(r['delivered_to']) ? (r['delivered_to'] as unknown[]).length : 0;
      const line =
        tier === 'final'
          ? 'Result recorded — node finished; its window closes on next stop. Nothing more to do here: STOP your turn immediately. Reply with just "Done." and nothing else.'
          : tier === 'urgent'
            ? `Urgent report fanned to ${n} subscriber(s) — they are force-woken.`
            : `Progress report fanned to ${n} subscriber(s).`;
      return `<pushed tier="${tier}" status="${r['status']}" delivered="${n}">\n${line}\nreport: ${r['report_path']}\n</pushed>`;
    },
  });
}

// ---------------------------------------------------------------------------
// feed read — drain the inbox
// ---------------------------------------------------------------------------

const feedReadLeaf = defineLeaf({
  name: 'read',
  description: 'drain unread pointers into a digest',
  whenToUse: 'you want to PROACTIVELY poll what the nodes you subscribe to — your children and anyone you follow — have reported before the watcher wakes you, draining the unread pointers in your inbox into one coalesced digest. NOTE: when a subscriber push wakes you, that wake message already IS this digest (the watcher drains your inbox to wake you), so don\'t re-run feed read to "open" it — dereference the refs in the digest you already have. Reach for it to poll before the next wake, to inspect another node\'s inbox, or to re-read the whole history after the cursor has advanced.',
  help: {
    name: 'feed read',
    summary: 'drain unread inbox pointers for the caller (or a named node) into a compact digest',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node whose inbox to read. Defaults to CRTR_NODE_ID. Use to inspect a worker\'s inbox as an orchestrator.' },
      { kind: 'flag', name: 'all', type: 'bool', required: false, default: false, constraint: 'Ignore the cursor and return everything from the start — use to re-read history the wake already drained.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'Node whose inbox was read.' },
      { name: 'digest', type: 'string', required: true, constraint: 'Coalesced digest — paste directly into a prompt.' },
      { name: 'entries', type: 'object[]', required: true, constraint: 'Raw InboxEntry objects.' },
      { name: 'cursor', type: 'string', required: true, constraint: 'New cursor ISO written after draining.' },
      { name: 'inbox_total', type: 'number', required: true, constraint: 'Total entries in the inbox (read + unread). Distinguishes a never-used inbox from one already drained at wake.' },
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
    const total = readInboxSince(nodeId, undefined).length;
    const newCursor = entries.length > 0 ? entries[entries.length - 1]!.ts : cursor ?? new Date().toISOString();
    writeCursor(nodeId, newCursor);
    return {
      node_id: nodeId,
      digest: coalesce(entries),
      entries: entries as unknown as Record<string, unknown>[],
      cursor: newCursor,
      inbox_total: total,
    };
  },
  render: (r) => {
    const n = Array.isArray(r['entries']) ? (r['entries'] as unknown[]).length : 0;
    const rawDigest = typeof r['digest'] === 'string' ? (r['digest'] as string) : '';
    if (n > 0 && rawDigest.trim() !== '') {
      return `<feed node="${r['node_id']}" unread="${n}">\n${rawDigest}\n</feed>`;
    }
    // Empty drain has two distinct causes — say which, honestly. An inbox that
    // already holds entries was drained when the watcher woke you (the wake
    // message WAS that digest); a never-used inbox simply has nothing yet.
    const total = typeof r['inbox_total'] === 'number' ? (r['inbox_total'] as number) : 0;
    const digest = total > 0
      ? 'Nothing unread — but your inbox is not empty. The watcher drains your inbox to wake you, so the entries you already saw in your wake message are the same ones you would read here; that is why this is empty. Re-read the whole history (full message bodies included) with `crtr feed read --all`, or dereference the refs from the wake digest you already have.'
      : 'Inbox empty — nothing has arrived from your subscriptions yet. Expected while workers run: a worker that has not pushed yet leaves no pointer, and it will wake you the moment it does. The wake is automatic — just continue your own work or end your turn. (Reach for `crtr feed peek` only if you suspect a worker died, not to confirm a live one.)';
    return `<feed node="${r['node_id']}" unread="${n}">\n${digest}\n</feed>`;
  },
});

// ---------------------------------------------------------------------------
// feed peek — live state of the nodes below you, without draining anything
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<string, string> = {
  active: '●', idle: '○', done: '✓', dead: '✗', canceled: '⊘',
};

/** Coarse "Nm ago" age from an ISO timestamp — enough to read staleness at a glance. */
function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface PeekChild {
  node_id: string;
  kind: string;
  name: string;
  status: string;
  active: boolean;
  spawned: string;
  cycles: number;
  last_push: { kind: string; ts: string; ref: string | null; label: string } | null;
}

const feedPeekLeaf = defineLeaf({
  name: 'peek',
  description: 'live state of the nodes below you, without draining anything',
  whenToUse: 'you are about to end a turn and want to confirm your workers are running before you chill — peek shows every node you subscribe to (the workers below you) with its live status (working/idle/done/dead), how long it has run, its cycle count, and whether it has pushed yet, plus a one-line verdict on whether it is safe to yield. Non-destructive: it never advances your inbox cursor, so a later `feed read` still delivers undrained reports. Reach for it exactly when the feed reads empty but you have outstanding children — that empty feed is EXPECTED (a worker that has not pushed yet contributes no inbox pointer); peek confirms those workers are alive and running async so you can stop and wait instead of polling.',
  help: {
    name: 'feed peek',
    summary: 'show the live state of every node you subscribe to (the workers below you) with a yield-or-not verdict; never drains the inbox',
    params: [
      { kind: 'flag', name: 'node', type: 'string', required: false, constraint: 'Node whose subscriptions to peek. Defaults to CRTR_NODE_ID. Use to inspect a worker\'s downstream as an orchestrator.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'Node that was peeked.' },
      { name: 'unread', type: 'number', required: true, constraint: 'Inbox pointers not yet drained by `feed read`.' },
      { name: 'children', type: 'object[]', required: true, constraint: 'One row per subscription: {node_id, kind, name, status, active, spawned, cycles, last_push}.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads canvas.db edges + node metas + inbox.jsonl.', 'Does NOT advance the inbox cursor — peek leaves the feed intact for a later `feed read`.'],
  },
  run: async (input) => {
    const nodeId =
      typeof input['node'] === 'string' && (input['node'] as string).trim() !== ''
        ? (input['node'] as string).trim()
        : requireCallerNode();
    // Read the WHOLE inbox to find each child's last push, but with no cursor
    // write — peek is non-destructive by contract. `unread` is computed from the
    // persisted cursor so peek can tell you a `feed read` would deliver something.
    const all = readInboxSince(nodeId, undefined);
    const unread = readInboxSince(nodeId, readCursor(nodeId)).length;
    const children: PeekChild[] = subscriptionsOf(nodeId).map((s) => {
      const n = getNode(s.node_id);
      const fromMe = all.filter((e) => e.from === s.node_id);
      const last = fromMe.length > 0 ? fromMe[fromMe.length - 1]! : undefined;
      return {
        node_id: s.node_id,
        kind: n?.kind ?? '?',
        name: n !== null ? fullName(n) : s.node_id,
        status: n?.status ?? 'dead',
        active: s.active,
        spawned: n?.created ?? s.created,
        cycles: n?.cycles ?? 0,
        last_push: last !== undefined
          ? { kind: last.kind, ts: last.ts, ref: last.ref ?? null, label: last.label }
          : null,
      };
    });
    return { node_id: nodeId, unread, children };
  },
  render: (r) => {
    const id = r['node_id'] as string;
    const unread = (r['unread'] as number) ?? 0;
    const kids = (r['children'] as PeekChild[]) ?? [];

    if (kids.length === 0) {
      const tail = unread > 0
        ? `${unread} unread report${unread === 1 ? '' : 's'} sit in your inbox — run \`crtr feed read\` to absorb ${unread === 1 ? 'it' : 'them'}.`
        : 'If you spawned workers, they have finished and detached, or you never subscribed. Nothing will wake you.';
      return `<peek node="${id}" subscriptions="0" unread="${unread}" verdict="empty">\nNo nodes below you. ${tail}\n</peek>`;
    }

    const working = kids.filter((k) => k.status === 'active' || k.status === 'idle');
    const liveWaking = working.filter((k) => k.active); // active sub to a live node = it will wake me
    const done = kids.filter((k) => k.status === 'done' || k.status === 'canceled');
    const dead = kids.filter((k) => k.status === 'dead');

    let verdict: string;
    let line: string;
    if (dead.length > 0) {
      verdict = 'attention';
      line = `\u26a0 ${dead.length} below you ${dead.length === 1 ? 'is' : 'are'} dead and will NOT wake you. Inspect with \`crtr node inspect show <id>\`, then re-delegate or proceed without ${dead.length === 1 ? 'it' : 'them'}.`;
    } else if (liveWaking.length > 0) {
      verdict = 'working';
      line = `Safe to yield \u2014 ${liveWaking.length} worker${liveWaking.length === 1 ? '' : 's'} running async will wake you on the next push. Nothing to do now; end your turn and chill.`;
    } else if (unread > 0) {
      verdict = 'ready';
      line = `Nothing still running, but ${unread} unread report${unread === 1 ? '' : 's'} \u2014 run \`crtr feed read\` to absorb ${unread === 1 ? 'it' : 'them'}, then continue or finish.`;
    } else {
      verdict = 'idle';
      line = 'Everything below you has finished and been drained \u2014 nothing is running. Continue your own work, or `crtr push final` to finish.';
    }

    const rows = kids.map((k) => {
      const sub = k.active ? '' : ' (passive)';
      const push = k.last_push !== null
        ? `pushed ${fmtAge(k.last_push.ts)} [${k.last_push.kind}]${k.last_push.ref !== null ? ` ref:${k.last_push.ref}` : ''}`
        : 'no push yet';
      const glyph = STATUS_GLYPH[k.status] ?? '?';
      return `  ${glyph} ${k.node_id}  ${k.kind}  ${k.name}${sub}  \u00b7 ${k.status} \u00b7 spawned ${fmtAge(k.spawned)} \u00b7 cyc ${k.cycles} \u00b7 ${push}`;
    }).join('\n');

    const attrs = `node="${id}" subscriptions="${kids.length}" working="${working.length}" done="${done.length}" dead="${dead.length}" unread="${unread}" verdict="${verdict}"`;
    return `<peek ${attrs}>\n${line}\n\n${rows}\n</peek>`;
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
        'A push writes a markdown report to the node\'s reports/ history and fans a lightweight pointer to every subscriber\'s inbox (not the content — they dereference lazily). Nothing is pushed automatically — the feed contains only what a node pushes explicitly, so push whenever you want a manager to see something. Pipe large bodies via stdin/heredoc (`crtr push <tier> <<\'EOF\' … EOF`). `push final` is how ANY node finishes: write the canonical result, mark done, close the window.',
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
        'Each node has an inbox.jsonl that accumulates ~30-token pointers from publishers it subscribes to. The watcher drains this inbox to wake you, so the wake message you receive ALREADY IS the coalesced digest \u2014 dereference the reports that matter by reading their ref paths (a push carries a ref; a direct message inlines its full body). `feed read` is for PROACTIVELY polling before a wake (it advances the cursor); after a wake it reads empty because the cursor already moved \u2014 use `--all` to re-read history. An empty feed is normal while workers run \u2014 a worker that has not pushed leaves no pointer \u2014 so use `feed peek` to see the live state of the nodes below you (and whether to yield) without draining anything.',
    },
    children: [feedReadLeaf, feedPeekLeaf],
  });
}
