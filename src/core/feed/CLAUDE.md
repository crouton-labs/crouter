# feed/ — the push/subscription spine

`push(nodeId, …)` is how output travels up the graph. It writes a report, then
fans out lightweight **pointers** (≈30 tokens — a `ref` path, not the body) to
every subscriber, who dereference on demand.

## Two delivery tiers (the core split)
- **Active** subscriber → `inbox.jsonl`. The in-process inbox-watcher polls this →
  a wake (the node takes a turn).
- **Passive** subscriber → `passive.jsonl`. Never polled, so **never woken**;
  pointers accumulate and are drained as XML pre-text the next time the node is
  messaged (canvas-passive-context).
- Both stores use the same `InboxEntry` shape, so flipping a subscription
  active↔passive needs no data reshape.

## Invariants
- `push --final` also flips the node `status=done` + `intent=done` (feed.ts).
- Reports (`reports/<ts>-<kind>.md`) and the cursor are written atomically
  (tmp+rename); jsonl appends use O_APPEND for multi-process safety.
- `drainPassive` renames the file aside **before** reading, so a concurrent push
  lands in a fresh file and is never lost to the truncate.
- The cursor sidecar (`inbox.jsonl.cursor`) is the watcher's read position; it
  advances on read. Appending an entry while the watcher is live can let it be
  consumed+skipped — see close.ts for why a window is killed before its notice.
- `coalesce()` folds many unread pointers into one digest grouped by sender.
