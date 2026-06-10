---
kind: reference
when-and-why-to-read: When you wonder whether the crtr help-gate will block a
  command because its heredoc body or quoted prompt mentions other crtr
  commands, this reference should be read because the gate strips heredoc bodies
  before scanning — body mentions are safe, so deliver prompts and report bodies
  the way crtr's own -h tells you to.
short-form: crtr help-gate strips heredoc bodies (and never splits quoted args)
  before scanning, so `crtr <cmd>` names inside a heredoc/prompt body do NOT
  trip it — use heredocs freely, as crtr's own help instructs
system-prompt-visibility: none
file-read-visibility: preview
---

The help-gate scans a bash command for `crtr <leaf>` invocations and blocks any whose `-h` you haven't read this session. It is **heredoc-aware**: before scanning it strips heredoc bodies (`<<'EOF' … EOF`, `<<-EOF`, command-subst prompts like `"$(cat <<EOF … EOF)"`), and it keeps a quoted argument as a single token. So a `crtr memory list` / `crtr push update` mention *inside* a prompt or report body is data, not an invocation, and does not trip the gate — only the real opening-line command (`push final`, `node new`) is gated.

**Why:** heredoc bodies and quoted args are stdin/argument *data*, never executed as shell commands, so the gate drops them before matching. This is exactly how crtr's own `-h` tells you to pass bodies (`crtr push <tier> <<'EOF' … EOF`, `crtr node new … <<'EOF'`) — the gate and the contract now agree.

**How to apply:** deliver large report bodies and spawn prompts via heredoc or a file (`crtr push final <<'EOF' … EOF`, `crtr node new <kind> < prompt.md`) without worrying about crtr names in the body. The gate (`pi-personal-extensions/extensions/crtr-help-gate.ts`, `stripHeredocs`) handles it. Related: [[spawn-prompt-via-stdin-not-arg]].
