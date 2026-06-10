# pi-extensions/ — the in-process canvas hooks

Each node's pi process loads these via its `launch.extensions` list. They are the
runtime's behavior *inside* a live pi (the canvas/runtime layers act from outside).

## Shared conventions
- **INERT when `CRTR_NODE_ID` is absent** — a plain pi session or legacy job agent
  loads them as no-ops. Every extension guards on this first.
- They **self-gate on the live `{kind,mode}` env**, so the worker→orchestrator
  polymorph flips hook behavior with NO respawn.

## Who does what
- `canvas-stophook` — turn_end is the central persona-injection + telemetry site,
  and the stop-guard (no stalled agents). The big one.
- `canvas-inbox-watcher` — polls `inbox.jsonl` (~800ms), coalesces, injects a
  digest → wakes a dormant node. Dies with pi (the daemon owns wake-on-message then).
- `canvas-passive-context` — drains `passive.jsonl` on every `input` event, prepends
  it as XML pre-text.
- `canvas-context-intro` — injects the `<crtr-context>` bearings on `session_start`
  (NOT before_agent_start/nextTurn — those append AFTER the first user message, so
  bearings would land second instead of first).
- `canvas-goal-capture` — on a node's first real message: persists a bare root's mandate as its goal, and async-names any unnamed node (headless `pi -p`, no spawn-path block).
- `canvas-commands` / `canvas-nav` — slash-commands + the graph-nav chrome.
