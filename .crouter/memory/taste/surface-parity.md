---
kind: reference
when-and-why-to-read: When you add, change, or remove anything a node renders
  into its live attached TUI — chrome, a widget, a picker, a status signal, a
  recap card — this reference should be read because the CTO expects that change
  to also land in crouter-web's operator view, and for many to get a friendlier
  treatment in the studio view, so a TUI-only change is presumptively incomplete.
system-prompt-visibility: none
file-read-visibility: preview
---

# Surface parity — a TUI change owes the web views too

CTO ruling (2026-06-11): almost any change that shows up in a node's attached TUI should **at least** show up in crouter-web's **operator view**, and for many changes should **also** appear in a more user-friendly form in the **studio view**. Treat a change that only touches the TUI as presumptively unfinished work, not a done feature.

This follows directly from `taste/broker-is-the-host`: every node runs on the headless broker and every UI — tmux pane, web operator view, web studio view — is just an attached view of that one host. A feature that surfaces in one view but not the others isn't a per-surface choice; it's drift between views of the same model.

How to apply it:
- **Operator view = near-parity with the attach TUI.** It's the raw operator surface, the web peer of the tmux attach client. New chrome/widgets/signals that an operator sees in the pane should reach it. The default is: if the TUI shows it, the operator view shows it.
- **Studio view = the friendlier framing.** The user-facing surface re-expresses the same underlying state more legibly. Not everything needs a studio treatment, but anything an end user (not just an operator) would care about does — translate it, don't just mirror the raw widget.
- **Mechanism, not duplication.** Because all three are broker views, parity is achieved by surfacing the same broker-side state/signal to each view's renderer — `ui.setWidget` already broadcasts to all attached surfaces (see canvas-recap) — not by re-implementing the feature three times. If a TUI feature can't reach the web views, that's usually a sign the state lives in the wrong place (pane-local instead of broker-side).
- **Scope it when you build it.** When adding a TUI surface, decide up front which views it owes (operator always; studio if a user cares) rather than shipping TUI-only and backfilling later.
