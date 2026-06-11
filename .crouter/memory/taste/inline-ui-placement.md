---
kind: preference
when-and-why-to-read: When building, placing, or laying out ANY crtr TUI element
  — pickers, dialogs, overlays, panels, feedback, status — read this preference
  because it carries the standing first-principles of where UI belongs and why.
short-form: "TUI placement first-principles: bottom=now/top=history, inline by
  default, locality, terse self-clearing feedback, adaptive cockpit."
system-prompt-visibility: preview
file-read-visibility: none
---

First principles for where crtr TUI content belongs and why. The crtr attach viewer is the reference surface; these govern crouter-web and any future surface too. Layout today, top→bottom: scrolling **chat** (history) · divider · **badge** (node id) · **managers** panel (↑ who I report to) · queued · **editor** (the action) · **pickerPanel** (inline pickers/dialogs) · **reports** panel (↓ what I watch) · **status bar**.

1. **The bottom is "now"; the top is history.** pi-tui anchors the viewport to the cursor at the bottom, so the scrolling region above is the document/log and the bottom-anchored stack is the live cockpit you act from. Durable controls and state live in the bottom stack; records scroll up. Never put interactive/persistent UI where it scrolls away, and never pollute the conversation log with chrome.

2. **Locality — UI mounts in the surface it acts on.** A control belongs adjacent to its target. Session pickers/dialogs mount inline under the editor (where you invoke them), in the `pickerPanel` slot, via `onMountPicker`/`PickerControls.replace` — never a centered float. Inline keeps surrounding context visible and preserves your place (no reflow of the chat).

3. **Inline is the default; promote to full-screen/blocking only when EARNED.** Take over the screen (popup/overlay) only when either (a) the content is genuinely rich — a lot to visualize and/or many custom commands/affordances that won't fit inline (the graph overlay, the canvas-browse navigator), or (b) the action must block everything until answered. The cost of a takeover is severed context; pay it only for "a different place" or a hard gate. Otherwise stay inline.

4. **Transient feedback is terse and self-clearing, never interruptive.** Errors, command results, and confirmations surface on the status bar (right edge) and auto-clear after a few seconds. They never interrupt the conversation, push into the log, or demand dismissal. Feedback is a whisper.

5. **Persistent chrome is adaptive to space.** Show the full cockpit (badge, manager ↑, subscriptions ↓, status) when there's room; as the terminal shrinks, collapse the lowest-priority panels first, protecting the conversation and the editor+status. Every persistent row costs forever — earn it, and yield it gracefully under pressure.

6. **Spatial stability + designated slots.** Fixed chrome holds stable positions so eye and hands learn them; even transient UI appears in designated slots (`pickerPanel`, status-right), never arbitrary positions. Predictable beats clever.

7. **Reading order = context → action → status.** Top-to-bottom should flow: history (chat) → orientation (badge, manager) → action (editor + its inline pickers) → what I'm watching (subscriptions) → live status (footer). The eye moves from where-am-I to what-I-do to how-it's-going.

8. **Graph-framing metaphor — working model, OPEN.** The cockpit frames the editor as "you": manager above (↑ report-to), subscriptions below (↓ watching). This is the current default. UNRESOLVED direction the user is weighing: a persistent mini-map at the TOP showing this node's place in the larger tree/graph. Not decided — treat framing as the working model; revisit if the mini-map lands.

9. **Match the host idiom (pi parity) where it serves muscle memory** — reuse pi's components and mirror pi's interactive layout so familiarity transfers, but bend it to these placement rules (notably: inline, not pi's centered defaults) when they conflict.

10. **Restraint — terse by default, reveal on demand.** Monospace rows are scarce. Default compact; expose detail through expand/collapse (ctrl+o context, tool-output collapse) rather than always-on verbosity.

11. **An earned popup must read as a distinct surface — give it a different background.** When a takeover IS earned (rule 3), the overlay/popup must use a background color distinct from the normal surface background. Matching backgrounds make the popup's edges invisible and the user can't tell where the float begins — defeating the point of taking over the screen. The contrast IS the signal that you've entered "a different place."
