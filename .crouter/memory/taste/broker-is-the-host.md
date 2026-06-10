---
kind: reference
when-and-why-to-read: When you are designing or building any surface that shows
  or drives a crouter node's live session — tmux, web, or otherwise — this
  reference should be read because the CTO has ruled that the headless broker is
  the one host and every UI is merely an attached view.
---

# Broker is the host; every UI is a view

CTO ruling (2026-06-10, during crouter-web scoping): the desired end-state is that **every node runs on the headless broker**, and tmux panes are just attach-client views of it — exactly like the web UI. In his words: "aren't tmux panes supposed to just be 'views' of the headless nodes too? That's how I want our UI as well."

Implications:
- New UI surfaces (web frontend, future viewers) attach to the broker socket (`view.sock`, protocol in `src/core/runtime/broker-protocol.ts`); they never host pi themselves and never tail pane output.
- Code paths that assume pi-runs-in-the-pane are legacy to be converged, not a parallel model to support. Don't build fallbacks for tmux-hosted nodes in new surfaces (e.g. transcript-tailing read-only views) — that's belt-and-suspenders for a host model that's meant to disappear.
- Per the CTO's hard-cut preference, the convergence ends with a single host model, the in-pane path deleted.
