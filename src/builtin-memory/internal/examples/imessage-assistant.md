---
kind: reference
when-and-why-to-read: When you are building a standing assistant node bridged to an external channel — iMessage, email, a chat service — this example should be read because it composes the crouter primitives (resident root node, custom persona, event-driven wake via node msg, project-scope memory) into a working OpenClaw-style design, with the macOS chat.db/osascript mechanics verified.
short-form: Worked example — an always-on iMessage assistant built from crouter primitives. Resident root node + launchd watcher → node msg wakes + chat.db reads + osascript sends + substrate memory.
system-prompt-visibility: name
file-read-visibility: none
---

# Example: an iMessage assistant node (OpenClaw-style)

A standing assistant that lives on the canvas, sleeps for free, wakes when a text arrives, reads the conversation, replies over iMessage, and accumulates memory about the people it talks to. Everything here composes existing primitives — no new runtime machinery.

## The shape

| Need | Primitive |
|---|---|
| Its own home | Dedicated dir (e.g. `~/assistants/imessage/`), node spawned with `--cwd` pinned there |
| Always-on, never "finishes" | `--root` spawn → resident lifecycle; dormant between messages costs nothing |
| Hears incoming texts | launchd watcher on `chat.db-wal` → `crtr node msg <id>` (event-driven; the spine delivers, the node never polls) |
| Reads messages | sqlite against `~/Library/Messages/chat.db`, cursored by ROWID |
| Sends replies | `osascript` → Messages.app |
| Memory | Project-scope substrate (`~/assistants/imessage/.crouter/memory/`) for durable knowledge; context dir for the cursor |
| Identity/behavior | A custom persona kind (see [[crouter-development/personas]]) |
| Crash recovery | The daemon auto-revives dead nodes; the watcher's `node msg` also revives a dormant target on its own |

## 1. Persona

Define a kind (e.g. `imessage-assistant`) per [[crouter-development/personas]]. The persona body carries: who it speaks for, which senders it may auto-reply to (allowlist — never reply to arbitrary numbers), voice, the wake loop below, and the memory protocol (when to write a contact note vs. keep it in-thread). Behavior lives in the persona, not in the watcher.

## 2. Spawn

```bash
mkdir -p ~/assistants/imessage
crtr node new --root --kind imessage-assistant --cwd ~/assistants/imessage --name imessage <<'EOF'
You are the standing iMessage assistant. Initialize: read your persona's wake loop, record the current chat.db max ROWID as your cursor, then go dormant. From now on a watcher wakes you via inbox message whenever iMessage activity lands.
EOF
```

`--root` makes it independent and resident — top-level on the canvas, no parent to report to, never forced to finish. Add `--headless` if it shouldn't occupy a tmux window. Record the returned node id for the watcher.

## 3. Wake: event-driven, not polled

A trivial launchd agent watches the Messages write-ahead log and pokes the node's inbox. `node msg` revives a dormant target by itself, so the watcher is the *only* off-canvas piece.

```xml
<!-- ~/Library/LaunchAgents/com.user.imessage-watch.plist (key parts) -->
<key>WatchPaths</key><array><string>/Users/YOU/Library/Messages/chat.db-wal</string></array>
<key>ProgramArguments</key><array>
  <string>/bin/zsh</string><string>-c</string>
  <string>crtr node msg NODE_ID "iMessage activity — check chat.db since your cursor"</string>
</array>
```

Multiple bursts while the node is mid-turn just append to its inbox and coalesce — no dedupe logic needed. Trust the runtime: do **not** also arm a recurring `node wake at` as a backstop. A self-scheduled wake is only the fallback if you choose not to run a watcher at all (pure polling — workable, but pays a window per tick and adds latency).

## 4. Reading chat.db (the verified gotchas)

- The process querying needs **Full Disk Access** (the node's shell inherits the terminal/launchd grant). Read-only — never write to chat.db.
- Cursor on `message.ROWID`, persisted in the node's context dir (e.g. `context/cursor`); filter `is_from_me = 0`.
- **On modern macOS `message.text` is often NULL** — the body lives in the `attributedBody` blob (NSAttributedString archive). Extract with:

```python
import re
m = re.search(rb'NSString.{1,10}?\+?(.{1,200}?)\x86', attributed_body, re.S)
text = m.group(1).decode('utf-8', 'ignore') if m else None
```

- Join for sender + thread:

```sql
SELECT m.ROWID, h.id AS sender, c.chat_identifier, m.text, m.attributedBody
FROM message m
JOIN handle h ON m.handle_id = h.ROWID
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > :cursor AND m.is_from_me = 0
ORDER BY m.ROWID;
```

## 5. Sending

```bash
osascript -e 'tell application "Messages" to send "reply text" to buddy "+15551234567" of (service 1 whose service type is iMessage)'
```

Group chats target the chat instead: `send "..." to chat id "iMessage;+;chat123..."` (the `chat.guid` column). First send prompts a one-time **Automation** permission grant for Messages.app.

## 6. Memory

Two tiers, matching [[internal/storage-tiers]]:

- **Durable knowledge** → project-scope memory in the node's pinned dir (`~/assistants/imessage/.crouter/memory/`): one reference per contact/thread (who they are, open loops, tone), loaded by the substrate on the node's own boots. The persona instructs when to write/update these.
- **Working state** → the node's context dir: the ROWID cursor, drafts, a running log.

## The wake loop (persona-side)

1. Wake on inbox message → read new rows past the cursor.
2. Decide per message: reply (allowlisted + warranted), note silently, or ignore.
3. Send via osascript; append anything durable to contact memory.
4. Advance the cursor, end turn, go dormant. No wake armed — the watcher delivers the next event.
