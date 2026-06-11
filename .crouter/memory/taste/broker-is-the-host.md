---
kind: reference
when-and-why-to-read: When you are designing or building any surface that shows
  or drives a crouter node's live session — tmux, web, or otherwise — or are
  changing node lifecycle, rendering, or anything that touches tmux, this
  reference should be read because the CTO has ruled (and the codebase now
  enforces, hard-cut) that the headless broker is the one host and every UI is
  merely an attached view.
system-prompt-visibility: none
file-read-visibility: preview
---

# Broker is the host; every UI is a view

CTO ruling (2026-06-10, crouter-web scoping), **shipped as a hard cut on 2026-06-11**: every node runs on the headless **broker** — one pi engine in-process via the pi SDK, the sole `.jsonl` writer, fanning out to multiple listeners. tmux panes and the web UI are interchangeable **attach-client views** of that broker (`view.sock`, protocol in `src/core/runtime/broker-protocol.ts`); they never host pi and never tail pane output. In his words: "aren't tmux panes supposed to just be 'views' of the headless nodes too? That's how I want our UI as well."

**Status: the in-pane (pi-in-tmux-pane) host path is DELETED.** The `--headless` flag and `headless` config key are gone — broker is the only host, not a mode you opt into. tmux survives only as a viewer + placement substrate.

Why it holds (load-bearing facts):
- tmux is edge-localized — the model (canvas.db, the inbox bus, pid-based liveness) is tmux-free; the daemon supervises on `pi_pid` (signal-0), never on panes.
- `reviveNode` (`src/core/runtime/revive.ts`) is the single launch chokepoint; it routes through `headlessBrokerHost.launch()`, which spawns the detached broker — never a tmux window hosting pi.
- **One-writer-per-`.jsonl` is the invariant.** pi's `SessionManager` has NO file locking, so exactly one broker engine may own a session file at a time. Every viewer (attach pane, web WS) is a socket peer of the already-running broker; a viewer NEVER launches an engine.

Implications:
- New UI surfaces attach to the broker socket — they never host pi and never tail the transcript. Don't build fallbacks for tmux-hosted nodes (e.g. transcript-tailing read-only views); that host model no longer exists.
- Per the CTO's hard-cut preference, there is a single host model and no parallel in-pane path to support. Related: [[prefers-hard-cuts]], [[surface-parity]].
