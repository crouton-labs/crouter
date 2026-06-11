---
kind: knowledge
when-and-why-to-read: When a child node has been "active" implausibly long with
  no report and its wave is not advancing, this reference should be read because
  the child may be wedged mid-turn on a runaway bash command — it shows how to
  detect that and recover by killing the subprocess, not the node.
short-form: a child stuck mid-turn on a runaway bash command sends NO wake and
  looks "active" forever — detect by pane/process inspection, fix by killing the
  subprocess
system-prompt-visibility: none
file-read-visibility: preview
---

A base node can wedge INDEFINITELY on a single runaway bash command (classic: `grep -rln "..." /` — a recursive grep from filesystem root that scans all of disk and never returns; also any unbounded find/scan over `/` or a network mount). The node's pi turn is blocked waiting on the bash call, so it never `push`es and never finishes.

**Why it's invisible to the orchestrator:** the wake spine only fires on a child's push/finalize/crash. A child wedged *mid-turn* does none of those — its row stays `status=active` and the dashboard shows it `●` working. The parent gets no wake, so an entire wave can stall for hours looking healthy. cli-verbs-B2 sat wedged ~2h14m on a `grep /` before a safety-deadline inspection caught it.

**How to detect:** when a base worker has been "active" implausibly long with no report and the wave isn't advancing, don't trust the status — inspect. `tmux capture-pane -p -t <pane>` shows the live turn (look for `Elapsed NNNNs ⠼ Working...` on one bash command); `pgrep -P <pi_pid>` + `ps -axo pid,ppid,etime,command` reveals the runaway subprocess and how long it's run.

**Why:** crtr's revival/wake model assumes a node either makes progress or dies; a node alive-but-blocked-on-a-syscall is a blind spot the daemon's liveness probe (pane+pi alive) also passes.

**How to apply:** kill the runaway SUBPROCESS, not the node — `kill <grep_pid>`. The bash call then returns and the pi turn resumes on its own, no context lost, no respawn. (Killing the bash `-c` wrapper can orphan the grep; kill the actual scanner PID. A pipeline `grep / | head` resumes fastest if you kill the first-stage grep — the pipe closes and bash proceeds.) Then notify the OWNING orchestrator (deferred tier) so it steers the child to completion and knows the lost time. Related: [[revive-stuck-orchestrator]] (the orchestrator-level false-finish failure mode).
