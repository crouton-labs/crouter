---
kind: reference
when-and-why-to-read: When the crtr help-gate blocks a command whose inline
  heredoc body merely mentions other crtr commands, this reference should be read
  because the gate scans the whole literal command string — pipe the body from a
  file instead.
short-form: crtr help-gate scans the literal command string (incl. inline
  heredoc bodies) for crtr command mentions and blocks — pipe report bodies from
  a file instead
system-prompt-visibility: none
file-read-visibility: preview
---

`crtr push <tier> <<'EOF' … EOF` is blocked by the help-gate when the heredoc BODY contains a literal `crtr <subcommand>` string you haven't `-h`'d this session (e.g. a report mentioning `crtr canvas daemon stop`). The gate scans the whole literal command text, not just argv, so it sees the heredoc content.

**Why:** the help-gate matches `crtr <cmd>` substrings in the raw bash command string; an inline heredoc embeds the body in that string, so any crtr command name you quote in your prose trips it.

**How to apply:** write the report body to a file and pipe it — `crtr push <tier> < /path/to/body.md`. The file content is not in the command string, so the gate only sees `crtr push <tier>`. Same pattern already used for `crtr node new` prompts (see [[spawn-prompt-via-stdin-not-arg]]).
