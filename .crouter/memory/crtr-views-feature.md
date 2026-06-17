---
kind: knowledge
when-and-why-to-read: When you are building, changing, or launching a crtr view,
  this reference should be read because views carry easy-to-violate load-bearing
  constraints — plain .mjs modules, sessionless launch, the tmux-import lint.
short-form: The `crtr view` TUI view library — what it is and its load-bearing constraints
system-prompt-visibility: none
file-read-visibility: preview
---

`crtr view` is a pluggable view library. As of the dual-target migration (the
legacy single-target `view.mjs` path was HARD-CUT, commit 05af799), a view is a
DIRECTORY of up to four files (builtin under `src/builtin-views/<id>/`, or
scope-authored under `~/.crouter/views/<id>/` or `<proj>/.crouter/views/<id>/`,
resolved project→user→builtin):
- `core.mjs` — REQUIRED. manifest · init · sources · commands · intents. Runs in
  BOTH Node and the browser; imports NOTHING (no `node:*`, no crtr). ALL state +
  ALL behavior live here; presenters are pure reads that emit named intents.
- `tui.mjs` — terminal presenter: `render(state, draw, content)` + `keymap` (Node only).
- `web.jsx` — React/Tailwind presenter, default-export component (browser only).
- `text.mjs` — `dump(state)` for the piped / non-TTY path (Node only).

The contract lives in `src/core/view/contract.ts` (loader + bridge + transports in
`src/core/view/`). `crtr view new <name>` scaffolds the four files.

**Two hosts, one core.** TUI: `crtr view run <id>` (full-screen, or `--window`/
`--split` as a monitor, Alt+V `]`/`[` to cycle). WEB: `crtr web serve` (unified
server on 127.0.0.1) renders builtins through their `web.jsx` in the shell
(`src/clients/web/`). **Web bundles BUILTINS ONLY** — `view-registry.ts` is a
build-time static registry; user/project custom views render in the TUI but are
NOT yet loaded on web (the documented v1 seam: a future `crtr view build` would
dynamic-import them). 6 builtins ship: canvas, git-pr, inbox, linkedin, settings,
workspace-sidebar.

**Load-bearing constraints (don't relearn the hard way):**
- Views are loaded by `import(pathToFileURL())` of plain `.mjs` — the published
  binary is `node dist/cli.js` with NO esbuild/tsx, so view defs must be runnable
  JS, not TS. Build copies `src/builtin-views` → `dist/builtin-views`.
- Views are sessionless: NEVER route them through node-focus / swap-pane /
  reviveNode (that assumes a pi session). Launch via `display-popup` (the `/view`
  pi-extension `canvas-view.ts`) or a plain window/split.
- `core.mjs` must import NOTHING — it runs unbundled in the browser too, so a
  `node:*` or crtr import breaks the web target. Keep all behavior in the core;
  presenters never touch data or transport directly.
- Only `placement.ts` / `tmux-chrome.ts` may import `core/runtime/tmux.ts`
  (enforced by `src/core/__tests__/tmux-surface.test.ts`). Check `process.env.TMUX`
  directly elsewhere.
- The LinkedIn view's data path (`capture exec` in a logged-in browser tab) is
  **dev-checkout-only** — published `capture` throws `DEV_ONLY_MSG`.

Design source of truth: this node's `context/crtr-views-spec.md`. See [[silas-cto-crouton-kit]].
