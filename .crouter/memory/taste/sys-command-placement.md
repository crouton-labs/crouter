---
kind: preference
when-and-why-to-read: "When adding a new crtr leaf that only reports
  system/runtime state, this preference should be read because it records the
  standing placement rule the CTO corrected: use the sys subtree for
  system-facing inspection commands, and keep node reserved for node
  lifecycle/graph verbs."
system-prompt-visibility: preview
file-read-visibility: none
---

# System-command placement

When a new command is read-only system/runtime inspection or self-management, place it under `sys`, not `node`, unless it directly operates on a node's lifecycle, graph position, or agent delegation surface. The `node` subtree is reserved for the core node lifecycle/graph verbs; `sys` is the home for installation/self-management and other system-facing views.
