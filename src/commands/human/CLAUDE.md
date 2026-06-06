# src/commands/human — the `crtr human` bridge

`ask|approve|review` spawn a `kind:"human"` node under the asking node, write
deck/run JSON to `interactionDir`, and open a detached humanloop TUI pane;
`notify`/`show` open a pane with no node. The blocking humanloop call runs in the
detached `crtr human _run` worker (queue.ts), which `pushFinal`s the answer into
the asking node's inbox (parent auto-subscribed at spawn).

## Surfacing rule (load-bearing)
A human prompt must LAND in the tmux session the user is WATCHING — never the
backstage `crtr` node session (`nodeSession()`), which they don't look at. An
untargeted `split-window` resolves against the caller's pane → backstage; that is
the bug this routing prevents.
- Open every TUI through `detachHumanTui` (shared.ts), not a bare
  `spawnAndDetach`. It targets the right pane and opens `detached: true`.
- `resolveHumanTarget`: a node prompt routes to the **highest focused node of the
  asking node's graph** (`graphSurfaceTarget`, placement.ts — the focused node
  closest to the graph root); fallback is the user's attached pane
  (`attachedClientPane`).
- `pickPlacement(targetPane)` must count panes in the TARGET window, not the
  caller's.
- NEVER force a jump: don't `switch-client`/`select-window`, and open new windows
  `-d` (DetachOptions.detached). The TUI lands beside the watched node; the user
  sees it when they look there. It must not yank their session/window.

## Driver access
The §5.1 lint (tmux-surface.test.ts) forbids importing `core/runtime/tmux.ts`
here — cross-session focus helpers live in `placement.ts`. shared.ts/spawn.ts
shell raw `tmux` for reads (`attachedClientPane`, `paneAlive`); only the driver
MODULE import is restricted, not raw `tmux` calls.

## killPane safety
`killPane` (shared.ts) refuses any pane whose start command lacks the interaction
dir — a bad/empty `-t` falls back to the caller's pane and would kill the agent's
own pi. Keep that guard.
