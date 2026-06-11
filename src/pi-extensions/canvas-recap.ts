// canvas-recap.ts — pi extension for pi-native canvas agent nodes.
//
// A per-node INACTIVITY RECAP, drawn as the topmost chrome above the editor.
// When a node has had NO new message (user or assistant) for IDLE_MS (300s by
// default), it runs Haiku over the literal conversation and pins a terse
// three-fragment card — goal / doing-now / next — above canvas-nav's manager
// line. The card disappears the instant the next message arrives, and the idle
// clock restarts.
//
//   trigger/clear are keyed off MESSAGES, not turns-of-work:
//     • a user `input` event OR an assistant `turn_end` resets the idle clock
//       and clears any shown recap.
//     • a single low-rate timer (no busy-loop) checks elapsed-since-last-message
//       and, on crossing IDLE_MS, generates + shows the recap once.
//
//   Haiku input = ALL user + assistant LITERAL text, most-recent within a char
//   budget. Tool calls, tool results, thinking blocks, and extension-injected
//   custom messages are excluded (only `message` entries with role user/assistant,
//   and only their `text` content blocks).
//
//   Placement: key `crtr-recap`, placement `aboveEditor`, ordered ABOVE
//   `crtr-managers` via the widget-order bus (pi's widget store is insertion-
//   ordered and re-setting moves a key to the bottom; after we paint the recap
//   we ask canvas-nav to re-assert its manager line, which drops it below us).
//
//   Surface gating: shows in BOTH the in-pane pi TUI (mode 'tui') and the
//   headless broker → attach/web viewers (mode 'print', setWidget broadcasts to
//   all surfaces). It does NOT gate on mode === 'tui' (that would kill the
//   headless+attach path). It NO-OPs only when ui/setWidget is unavailable, and
//   harmlessly in a true one-shot `pi -p` (the unref'd timer never fires before
//   the process exits, and naming-style one-shots load with --no-extensions).
//
// INERT when CRTR_NODE_ID is absent (a plain pi session or legacy job agent).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages.

import { generateRecap } from '../core/runtime/recap.js';
import { requestNavRerender } from './widget-order-bus.js';

// ---------------------------------------------------------------------------
// Minimal PiLike / session interfaces (avoid a hard dep on @earendil-works/*)
// ---------------------------------------------------------------------------

interface TextContentLike { type: string; text?: string }

interface MessageLike {
  role: string; // 'user' | 'assistant' | 'toolResult' | ...
  content: string | TextContentLike[];
}

interface SessionEntryLike {
  type: string; // 'message' | 'custom' | 'custom_message' | ...
  message?: MessageLike;
}

interface SessionManagerLike {
  getEntries(): SessionEntryLike[];
}

interface UIContextLike {
  setWidget(key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void;
}

interface ExtensionCtxLike {
  ui?: UIContextLike;
  mode?: string;
  sessionManager?: SessionManagerLike;
}

type PiEvents = 'session_start' | 'input' | 'turn_end' | 'session_shutdown';

interface PiLike {
  on(event: PiEvents, handler: (event: any, ctx: ExtensionCtxLike) => void): void;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** No-new-message window before a recap is shown. 300s by default; override with
 *  CRTR_RECAP_IDLE_MS (for fast runtime verification). */
function idleMs(): number {
  const raw = process.env['CRTR_RECAP_IDLE_MS'];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/** How often the (single, low-rate) timer checks elapsed-since-last-message.
 *  Mirrors canvas-nav's ASK_POLL_MS — cheap and tmux/crtr-free. */
const POLL_MS = 7_000;

/** Char budget on the conversation fed to Haiku — the model only needs the gist,
 *  so we keep the MOST-RECENT text within this cap (a recap is about where we
 *  left off, not the whole history). */
const CONVO_CHAR_BUDGET = 12_000;

const WIDGET_KEY = 'crtr-recap';

// ---------------------------------------------------------------------------
// Module-level state — persists across /reload so the timer doesn't stack.
// ---------------------------------------------------------------------------

/** The one live poll timer. Cleared and replaced on every re-registration. */
let liveTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Conversation extraction — literal user+assistant text ONLY.
// ---------------------------------------------------------------------------

/** Pull the literal text out of a message's content (string or text blocks),
 *  dropping non-text blocks (thinking, toolCall, image). */
function messageText(msg: MessageLike): string {
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => (b.text ?? '').trim())
    .filter((t) => t !== '')
    .join('\n')
    .trim();
}

/** Concatenate the conversation's user + assistant literal text into a single
 *  `User:`/`Agent:` transcript, keeping only the MOST-RECENT CONVO_CHAR_BUDGET
 *  characters. Excludes tool calls/results (role toolResult, plus toolCall/
 *  thinking content blocks dropped by messageText) and extension-injected
 *  custom messages (entry.type !== 'message'). Returns '' when there is nothing
 *  to summarize. */
function buildConversation(sm: SessionManagerLike): string {
  let entries: SessionEntryLike[];
  try { entries = sm.getEntries(); } catch { return ''; }
  const parts: string[] = [];
  for (const e of entries) {
    if (e.type !== 'message' || e.message === undefined) continue;
    const role = e.message.role;
    if (role !== 'user' && role !== 'assistant') continue; // drop toolResult etc.
    const text = messageText(e.message);
    if (text === '') continue;
    parts.push(`${role === 'user' ? 'User' : 'Agent'}: ${text}`);
  }
  if (parts.length === 0) return '';
  const full = parts.join('\n\n');
  return full.length > CONVO_CHAR_BUDGET ? full.slice(full.length - CONVO_CHAR_BUDGET) : full;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the inactivity-recap chrome on `pi`.
 *
 * Returns immediately (inert) when CRTR_NODE_ID is absent — a plain pi session
 * or legacy job agent loads it as a no-op.
 */
export function registerCanvasRecap(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  // Captured on session_start; used by the timer and the message handlers.
  let ui: UIContextLike | undefined;
  let sessionManager: SessionManagerLike | undefined;

  /** Wall-clock of the most recent user/assistant message. The idle clock. */
  let lastMessageAt = Date.now();
  /** True while a recap is currently shown (so we generate at most once per
   *  idle window, and know whether a clear is needed on the next message). */
  let recapShown = false;
  /** True while a Haiku generation is in flight (so we don't fire a second). */
  let generating = false;

  const canPaint = (): boolean => ui !== undefined && typeof ui.setWidget === 'function';

  const clearRecap = (): void => {
    if (!canPaint()) return;
    try { ui!.setWidget(WIDGET_KEY, undefined, { placement: 'aboveEditor' }); } catch { /* best-effort */ }
  };

  /** Render the three fragments as the topmost above-editor card. */
  const showRecap = (fragments: string[]): void => {
    if (!canPaint()) return;
    const labels = ['◷ goal', '· now ', '→ next'];
    const lines = fragments.slice(0, 3).map((f, i) => `${labels[i] ?? '    '}  ${f}`);
    if (lines.length === 0) return;
    try { ui!.setWidget(WIDGET_KEY, lines, { placement: 'aboveEditor' }); } catch { /* best-effort */ }
    // Re-assert the manager line BELOW us (pi's widget store is insertion-
    // ordered; re-setting crtr-managers drops it under crtr-recap).
    requestNavRerender();
  };

  /** A user or assistant message landed: reset the idle clock and clear any
   *  shown recap (the conversation has moved on). */
  const onMessage = (): void => {
    lastMessageAt = Date.now();
    if (recapShown) {
      recapShown = false;
      clearRecap();
      requestNavRerender();
    }
  };

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  pi.on('session_start', (_event: any, ctx: ExtensionCtxLike): void => {
    ui = ctx.ui;
    sessionManager = ctx.sessionManager;
    // Fresh session / hot-swap: start the idle clock now and drop any stale
    // recap that bled through a /reload.
    lastMessageAt = Date.now();
    recapShown = false;
    generating = false;
    clearRecap();
  });

  pi.on('input', (_event: any, _ctx: ExtensionCtxLike): void => {
    // Every user message (any source) is activity — reset + clear.
    onMessage();
  });

  pi.on('turn_end', (_event: any, _ctx: ExtensionCtxLike): void => {
    // A completed assistant turn is activity — reset + clear.
    onMessage();
  });

  // -------------------------------------------------------------------------
  // The single low-rate idle poll — no busy-loop, mirrors canvas-nav's timer.
  // -------------------------------------------------------------------------
  if (liveTimer !== undefined) clearInterval(liveTimer);

  const timer = setInterval((): void => {
    try {
      if (!canPaint() || sessionManager === undefined) return;
      if (recapShown || generating) return;
      if (Date.now() - lastMessageAt < idleMs()) return;

      const convo = buildConversation(sessionManager);
      if (convo === '') return; // nothing to summarize yet

      // Snapshot the clock: if a message arrives while Haiku runs, discard the
      // (now-stale) result instead of painting over the live conversation.
      const startedAt = lastMessageAt;
      generating = true;
      generateRecap(convo, (fragments) => {
        generating = false;
        if (lastMessageAt !== startedAt) return; // a message landed mid-flight
        if (!canPaint()) return;
        recapShown = true;
        showRecap(fragments);
      });
      // generateRecap is silent on failure (never calls back), so clear the
      // in-flight flag after the timeout window even if no callback fires.
      setTimeout(() => { generating = false; }, 30_000).unref?.();
    } catch {
      /* timer is best-effort */
    }
  }, POLL_MS);

  if (typeof timer.unref === 'function') timer.unref();
  liveTimer = timer;

  pi.on('session_shutdown', (): void => {
    clearInterval(timer);
    if (liveTimer === timer) liveTimer = undefined;
  });
}

export default registerCanvasRecap;
