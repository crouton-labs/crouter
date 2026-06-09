---
kind: reference
when: When you are changing crouter's rendering, node lifecycle, or anything
  that touches tmux
why: An active initiative is splitting host from surface, and your
  change should align with the headless/web-UI end-state
short-form: Active initiative — decouple crouter's tmux rendering from its model
  (MVC) toward headless nodes + a web UI
system-prompt-visibility: none
file-read-visibility: preview
---

Active initiative (as of 2026-06-08): make crouter runnable headless behind a web UI by splitting **Host** (engine-process lifecycle) from **Surface** (a detachable viewer). End state = a hard cut to a single host: every node is a per-node **broker** that runs one pi engine in-process via the pi SDK (sole `.jsonl` writer, multi-listener fan-out); `crtr attach` (tmux pane) and `crtr web` (browser) are interchangeable viewers. tmux survives only as a viewer host + placement substrate.

Key facts established (evidence in the findings docs): tmux is edge-localized — the model (canvas.db, the inbox/passive.jsonl bus, pid-based `livenessVerdict`) is already tmux-free; `reviveNode` is the single launch chokepoint; the daemon already supervises on `pi_pid` (signal-0), not panes; pi has a first-class no-TTY SDK and shares session files between TUI and SDK; pi's `SessionManager` has NO file locking → one-writer-per-`.jsonl` is the load-bearing invariant.

Design is implementer-ready (5 phases, strangler-fig): `context/headless-mvc-design.md` under the orchestrator node, with evidence in `context/findings-*.md`. Migration-path decision (bridge-then-delete vs big-bang) is the user's open call. Related: [[prefers-hard-cuts]].
