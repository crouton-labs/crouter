// canvas-passive-context.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// The passive-subscription drain. A PASSIVE subscription (active=false edge)
// never wakes its subscriber: `push` routes its pointers to passive.jsonl, which
// the inbox-watcher never polls. They simply accumulate. This extension is what
// finally surfaces them — the moment the node is MESSAGED.
//
// pi fires an `input` event for every user message (human-typed, an RPC, or an
// extension's sendUserMessage — including the inbox-watcher's own wake). On that
// event we DRAIN the node's passive accumulator and, when non-empty, prepend
// every entry as timestamped XML to the message text via the `transform` action.
// So the backlog rides in as pre-text on whatever message next engages the node,
// before the LLM sees it — and is cleared in the same step (drain = read+clear),
// so it surfaces exactly once.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { existsSync, readFileSync } from 'node:fs';
import { drainPassive } from '../core/feed/passive.js';
import type { InboxEntry } from '../core/feed/inbox.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*)
//
// Signatures sourced from the pi extension types (InputEvent / InputEventResult):
//   on('input', (event: { text: string; images?: ImageContent[]; source; ... }, ctx)
//        => { action: 'continue' } | { action: 'transform'; text; images? } | { action: 'handled' })
// ---------------------------------------------------------------------------

interface InputEventLike {
  type: 'input';
  text: string;
  images?: unknown[];
  source: 'interactive' | 'rpc' | 'extension';
}

type InputEventResultLike =
  | { action: 'continue' }
  | { action: 'transform'; text: string; images?: unknown[] }
  | { action: 'handled' };

interface PiLike {
  on: (
    event: 'input',
    handler: (event: InputEventLike, ctx: any) => InputEventResultLike | void,
  ) => void;
}

// Per-entry body cap so a single fat report can't blow the context budget. The
// full report stays on disk at `ref` if the agent needs more.
const BODY_CAP = 4_000;

// ---------------------------------------------------------------------------
// Report dereference — turn a passive pointer into the message text it carries.
// ---------------------------------------------------------------------------

/** Strip the leading YAML frontmatter block a report is written with, returning
 *  just the body. Tolerant: no frontmatter → returns the input unchanged. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw;
  const end = raw.indexOf('\n---\n', 4);
  return end === -1 ? raw : raw.slice(end + 5);
}

/** The content for one accumulated entry: the dereferenced report body when the
 *  pointer carries a `ref`, else the entry's own label/data. Capped + trimmed. */
function entryContent(e: InboxEntry): string {
  if (e.ref !== undefined && e.ref !== '' && existsSync(e.ref)) {
    try {
      const body = stripFrontmatter(readFileSync(e.ref, 'utf8')).trim();
      if (body !== '') {
        return body.length > BODY_CAP
          ? `${body.slice(0, BODY_CAP)}\n… (truncated; full report at ${e.ref})`
          : body;
      }
    } catch {
      /* fall through to the label */
    }
  }
  const data = e.data?.['body'];
  if (typeof data === 'string' && data.trim() !== '') return data.trim();
  return e.label;
}

/** Minimal XML attribute escaping for the values we interpolate. */
function attr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render drained passive entries (oldest first) into one XML pre-text block.
 * Each accumulated message is its own timestamped `<update>` element.
 */
export function formatPassive(entries: InboxEntry[]): string {
  const blocks = entries
    .map((e) => {
      const from = attr(e.from ?? 'system');
      const refAttr = e.ref !== undefined && e.ref !== '' ? ` ref="${attr(e.ref)}"` : '';
      return (
        `<update from="${from}" kind="${attr(e.kind)}" at="${attr(e.ts)}"${refAttr}>\n` +
        `${entryContent(e)}\n` +
        `</update>`
      );
    })
    .join('\n');

  return (
    `<passive-subscription-backlog count="${entries.length}" ` +
    `note="Reports accumulated from nodes you passively subscribe to while you were not actively listening. ` +
    `Surfaced now because you were messaged. Oldest first.">\n` +
    `${blocks}\n` +
    `</passive-subscription-backlog>`
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the passive-context drain on `pi`.
 *
 * Returns immediately (inert) when CRTR_NODE_ID is absent. The `input` handler
 * is the whole extension: drain on every message, prepend when non-empty.
 */
export function registerCanvasPassiveContext(pi: PiLike): void {
  pi.on('input', (event: InputEventLike): InputEventResultLike | void => {
    try {
      const nodeId = process.env['CRTR_NODE_ID'];
      if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

      const drained = drainPassive(nodeId);
      if (drained.length === 0) return; // nothing accumulated → leave the message as-is

      const preText = formatPassive(drained);
      const text = event.text.trim() === '' ? preText : `${preText}\n\n${event.text}`;
      return { action: 'transform', text, images: event.images };
    } catch {
      // Best-effort: a drain/format failure must never drop the user's message.
      return;
    }
  });
}

export default registerCanvasPassiveContext;
