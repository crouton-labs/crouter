/**
 * Inbox-origin detection for folded user messages (shared between server and
 * client).
 *
 * canvas-inbox-watcher (crouter src/pi-extensions/canvas-inbox-watcher.ts)
 * injects inbox digests via `pi.sendUserMessage(digest)` where `digest` is
 * produced by `coalesce()` (crouter src/core/feed/inbox.ts).  The coalesce
 * format is:
 *
 *   From <sender> — N update(s):\n  [kind] label  (ref: path)\n…
 *
 * where <sender> is a node-id (`[a-z0-9]+-[a-f0-9]+`) or one of the literals
 * `system` or `human` (for null-from or system-generated entries).
 *
 * This is an internal contract between two crouton-kit packages.  Matching
 * the literal prefix is stable — coalesce() has never changed this header line
 * and the format is documented in the source comment.
 */

// Matches the coalesce() header produced by canvas-inbox-watcher:
//   "From <node-id|system|human> — N update(s):"
const INBOX_PREFIX_RE = /^From (?:[a-z0-9]+-[a-f0-9]+|system|human) — \d+ update/;

/**
 * True iff `text` looks like a coalesced inbox digest injected by
 * canvas-inbox-watcher.  Matches the `From <sender> — N update(s):` prefix
 * that `coalesce()` always produces.
 */
export function isInboxDigest(text: string): boolean {
  return INBOX_PREFIX_RE.test(text);
}

/** Return the sender node-id (or special label) from the first `From …` line,
 *  or null if the message does not match the inbox coalesce format. */
export function extractInboxSender(text: string): string | null {
  const m = /^From ([a-z0-9]+-[a-f0-9]+|system|human) — /.exec(text);
  if (!m) return null;
  const sender = m[1];
  return typeof sender === 'string' ? sender : null;
}
