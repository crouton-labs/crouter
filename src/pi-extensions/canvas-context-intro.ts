// canvas-context-intro.ts — pi extension for pi-native canvas agent nodes.
//
// Loaded into every canvas node's pi process via the node's launch.extensions
// list. INERT when CRTR_NODE_ID is absent (plain pi session or legacy job agent).
//
// The bearings preamble. On `session_start` — which fires BEFORE the node's
// first user message enters the session — this injects ONE <crtr-context>
// message via `pi.sendMessage` (no delivery options, so at the idle start it is
// pushed straight onto the message list and persisted). Because the session is
// still empty at that point, the bearings land as the FIRST entry, ahead of the
// node's first prompt — the orienting frame, not a trailing afterthought.
//   (before_agent_start / deliverAs:"nextTurn" both append AFTER the user
//    message — see agent-session's submit path — which is why we use
//    session_start instead.)
//
// The block carries: the path to the node's own context dir and the framing for
// what belongs there (a shared document store for the other nodes). Resident
// orchestrators additionally get the across-refresh-cycles framing + a <memory>
// block merging the indexes of their three scoped memory stores (user-global,
// project, node-local), each labeled with its absolute dir + index path. The
// prose lives in core/runtime/bearings.ts (shared with the promotion guidance
// dump), which gates the memory block on the node having a node-local store — so
// a terminal worker gets no memory framing at all.
//
// IDEMPOTENT across resumes: a `--session` relaunch restores the conversation,
// so the block is already in history; the session_start handler sees it via
// `sessionManager.getEntries()` and skips, so it never accumulates.
//
// COLLAPSED BY DEFAULT: a `registerMessageRenderer` keyed to our customType
// renders the block as a single one-line stub; the full body only appears when
// the user expands tool output (Ctrl+O / `app.tools.expand`). pi drives this via
// `CustomMessageComponent.setExpanded(toolOutputExpanded)`, so the same toggle
// that expands tool results expands the bearings. The renderer returns a plain
// object satisfying pi's structural `Component` interface ({ render, invalidate })
// — no pi-tui class needed. The LLM always sees the full `content` regardless of
// how it renders; the renderer is display-only.
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { buildContextBearings } from '../core/runtime/bearings.js';

/** The `customType` stamped on the injected session message. Used both to write
 *  the entry and to detect it on resume (the idempotency guard). */
export const CONTEXT_INTRO_CUSTOM_TYPE = 'crtr-context';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids hard dep on @earendil-works/*).
// Mirrors the session_start ctx + pi.sendMessage shapes pi exposes.
// ---------------------------------------------------------------------------

interface SessionEntryLike {
  type: string;
  customType?: string;
}

interface SessionStartCtxLike {
  sessionManager: { getEntries: () => SessionEntryLike[] };
}

interface CustomMessageLike {
  customType: string;
  content: string;
  display?: boolean;
}

/** The message handed to a message renderer. `content` is normally the string we
 *  sent, but pi types it as string-or-blocks, so we handle both. */
interface RenderedMessageLike {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
}

/** Minimal structural match for pi-tui's `Component` (render + invalidate). A
 *  plain object of this shape is a valid child for pi's Container. */
interface ComponentLike {
  render: (width: number) => string[];
  invalidate: () => void;
}

/** Subset of pi's `Theme` we touch — `fg(color, text)` wraps text in ANSI. Used
 *  defensively (falls back to plain text if absent). */
interface ThemeLike {
  fg?: (color: string, text: string) => string;
}

interface PiLike {
  on: (
    event: 'session_start',
    handler: (event: unknown, ctx: SessionStartCtxLike) => void | Promise<void>,
  ) => void;
  sendMessage: (
    message: CustomMessageLike,
    options?: { deliverAs?: string; triggerTurn?: boolean },
  ) => void;
  registerMessageRenderer: (
    customType: string,
    renderer: (
      message: RenderedMessageLike,
      options: { expanded?: boolean },
      theme: ThemeLike,
    ) => ComponentLike | undefined,
  ) => void;
}

// ---------------------------------------------------------------------------
// Block builder
// ---------------------------------------------------------------------------

/** Build the <crtr-context> bearings block for `nodeId`. Thin wrapper over the
 *  shared builder in core/runtime/bearings.ts (the single source of truth, also
 *  used by the promotion guidance dump). Exported for testing. */
export function buildContextIntro(nodeId: string): string {
  return buildContextBearings(nodeId);
}

// ---------------------------------------------------------------------------
// Collapsed-by-default rendering
// ---------------------------------------------------------------------------

/** Pull the plain text out of a custom message's content (string or blocks). */
function messageText(message: RenderedMessageLike): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Hard-wrap a single logical line to `width` columns (content carries no ANSI).
 *  Code-point aware so wide-string slicing never splits a surrogate pair; the
 *  bearings prose is plain text, so code-point count == visible columns. */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [''];
  const chars = Array.from(line);
  if (chars.length <= width) return [line];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
  return out;
}

/** Truncate plain text to at most `width` columns, appending an ellipsis when it
 *  would overflow. Content here is ANSI-free plain text (label + prose), so a
 *  code-point count stands in for visible width. The renderer MUST keep every
 *  emitted line within the terminal width or pi's TUI aborts the whole render. */
function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return '…';
  return chars.slice(0, width - 1).join('') + '…';
}

/**
 * Renderer for `crtr-context` messages. Collapsed (default) shows a one-line
 * stub; expanded (Ctrl+O) shows the label + full body. Returns a plain object
 * matching pi's structural `Component` interface — no pi-tui import. Exported for
 * testing.
 */
export function renderContextMessage(
  message: RenderedMessageLike,
  options: { expanded?: boolean },
  theme: ThemeLike,
): ComponentLike {
  const expanded = options?.expanded === true;
  const paint = (color: string, text: string): string =>
    typeof theme?.fg === 'function' ? theme.fg(color, text) : text;

  return {
    render(width: number): string[] {
      const w = typeof width === 'number' && width > 0 ? width : 80;
      if (!expanded) {
        // Truncate BEFORE painting so the ANSI wrapper never inflates the
        // measured width; an over-wide line aborts pi's entire TUI render.
        const stub = `[${CONTEXT_INTRO_CUSTOM_TYPE}] orienting bearings — ctrl+o to expand`;
        return [paint('dim', truncateToWidth(stub, w))];
      }
      const lines = [paint('customMessageLabel', truncateToWidth(`[${CONTEXT_INTRO_CUSTOM_TYPE}]`, w)), ''];
      for (const raw of messageText(message).split('\n')) {
        for (const wrapped of wrapLine(raw, w)) lines.push(paint('customMessageText', wrapped));
      }
      return lines;
    },
    invalidate(): void {
      /* stateless — nothing to clear */
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the context-intro preamble on `pi`.
 *
 * Returns immediately (inert) when CRTR_NODE_ID is absent. On `session_start`
 * it injects the <crtr-context> block as the first message of a brand-new chat
 * — but only when the session does not already carry it, so a `--session <id>`
 * relaunch (which restores the conversation) never duplicates the block.
 */
export function registerCanvasContextIntro(pi: PiLike): void {
  // Collapse the block to a one-liner until the user expands tool output (Ctrl+O).
  // Harmless to register outside TUI mode (it's only consulted while rendering).
  pi.registerMessageRenderer(CONTEXT_INTRO_CUSTOM_TYPE, renderContextMessage);

  pi.on('session_start', (_event, ctx): void => {
    try {
      const nodeId = process.env['CRTR_NODE_ID'];
      if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

      // Idempotent: a restored/reloaded session already carries the block.
      const present = ctx.sessionManager
        .getEntries()
        .some((e) => e.type === 'custom_message' && e.customType === CONTEXT_INTRO_CUSTOM_TYPE);
      if (present) return;

      // No delivery options: at the idle start of a session this is pushed onto
      // the (still empty) message list and persisted immediately, so it precedes
      // the node's first prompt.
      pi.sendMessage({
        customType: CONTEXT_INTRO_CUSTOM_TYPE,
        content: buildContextIntro(nodeId),
        display: true,
      });
    } catch {
      // Best-effort: a failure here must never break session startup.
      return;
    }
  });
}

export default registerCanvasContextIntro;
