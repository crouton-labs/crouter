---
kind: reference
when: When a task relates to crtr views feature
why: The `crtr view` TUI view library — what it is and its load-bearing constraints
short-form: The `crtr view` TUI view library — what it is and its load-bearing constraints
system-prompt-visibility: none
file-read-visibility: preview
needs-refinement: true
---

`crtr view` is a pluggable terminal-view library (committed 9cf8417). A view = a
self-contained ESM `.mjs` module (builtin in `src/builtin-views/<id>/view.mjs`, or
scope-authored in `~/.crouter/views/<id>/` or `<proj>/.crouter/views/<id>/`),
default-exporting a `ViewModule`. The host (`src/core/tui/host.ts` `runView`) owns
the alt-screen loop, input, layout, chrome, and a single-flight async lane; the
view paints into an injected `Draw` API (`src/core/tui/draw.ts`) and imports
NOTHING from crtr. Contract + loader live in `src/core/tui/`.

**Load-bearing constraints (don't relearn the hard way):**
- Views are loaded by `import(pathToFileURL())` of plain `.mjs` — the published
  binary is `node dist/cli.js` with NO esbuild/tsx, so view defs must be runnable
  JS, not TS. Build copies `src/builtin-views` → `dist/builtin-views`.
- Views are sessionless: NEVER route them through node-focus / swap-pane /
  reviveNode (that assumes a pi session). Launch via `display-popup` (the `/view`
  pi-extension `canvas-view.ts`) or a plain window/split.
- Only `placement.ts` / `tmux-chrome.ts` may import `core/runtime/tmux.ts`
  (enforced by `src/core/__tests__/tmux-surface.test.ts`). Check `process.env.TMUX`
  directly elsewhere.
- The LinkedIn view's data path (`capture exec` in a logged-in browser tab) is
  **dev-checkout-only** — published `capture` throws `DEV_ONLY_MSG`.

Design source of truth: this node's `context/crtr-views-spec.md`. See [[silas-cto-crouton-kit]].
