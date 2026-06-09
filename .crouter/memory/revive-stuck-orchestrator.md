---
kind: reference
when: When an orchestrator sits idle with a dead pi and intent=idle-release,
  or got falsely auto-finalized
why: The one safe recovery is a critical node msg — canvas revive
  --fresh makes it worse
short-form: How to recover a stuck/false-finished orchestrator node — use
  critical node msg, never canvas revive --fresh
system-prompt-visibility: none
file-read-visibility: preview
---

A `node yield` can get STUCK if a message lands in the node's pane and races the yield: the node ends up `status=idle / intent=idle-release` with its pi dead and `window=null`, and the refresh-revival never fires (the healthy daemon won't revive an `idle` node — idle reads as "intentionally waiting"). Symptom: an orchestrator sits idle for minutes with all children done and work remaining; `crtr node inspect show <id>` shows `idle` + `idle-release` + dead `pi_pid`.

**Do NOT recover it with `crtr canvas revive --fresh`.** On an orchestrator, `--fresh` boots a clean pi with NO task prompt; it immediately ends its turn, and the runtime AUTO-FINALIZES it (`status=done`, no real `push final`) — making things worse.

**Why:** `--fresh` = empty pi + bearings only, nothing actionable → terminal node ends → stophook finalizes. A real `node yield` differs: it injects a "revived fresh, continue toward your goal" framing; `--fresh` does not replicate that.

**How to apply:** recover a stuck or falsely-finished orchestrator with `crtr node msg <id> --tier critical < prompt.md`. A critical msg revives by RESUMING the saved session (full context retained) AND delivers an actionable prompt, so the node gets a real turn and can't immediately re-finalize. Tell it plainly: you are NOT done (false finish), your roadmap is current, continue per it. Verified working 2026-06-09 (substrate-impl mq5v9hfa). Related: [[help-gate-scans-heredoc-bodies]] (pipe the prompt from a file).
