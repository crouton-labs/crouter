---
kind: knowledge
when-and-why-to-read: When you want a worked end-to-end composition of crouter primitives — not what one command does but how several combine into a real standing system — open this dir because it holds complete example builds, each verified against the actual runtime and OS mechanics.
short-form: Worked examples composing crouter primitives into complete systems (like pi's examples/ dir). Currently — the iMessage assistant node.
system-prompt-visibility: name
file-read-visibility: none
---

# internal/examples/ — worked compositions of crouter primitives

The other internal/ docs explain the primitives one at a time; this dir shows them composed into complete, buildable systems — the crtr analogue of pi's `examples/` directory. Each example is grounded: its OS-level mechanics and command contracts were verified before being written down.

- **imessage-assistant** — an OpenClaw-style always-on assistant: resident root node with its own dir and persona, woken event-style by a launchd watcher via `node msg`, reading `chat.db` (with the attributedBody gotcha), replying via osascript, remembering people through project-scope memory.

Add an example here when a composition was non-obvious enough that the next builder shouldn't have to re-derive it.
