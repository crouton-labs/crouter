# canvas/ — the canvas data-access layer

The ONE place that reads/writes the node+edge model. Everything above (runtime,
feed, daemon, commands) goes through `canvas.ts`; nothing else touches the db or
`meta.json` directly.

## Source-of-truth split (the rule to internalize, post-keystone)
- A node's `meta.json` (on disk under `nodes/<id>/`) is **durable identity only**
  (`NodeIdentity`: kind/cwd/created/mode/lifecycle/launch/pi_session_id/…). It is
  written rarely — birth, polymorph, session-id capture, naming.
- The five **runtime** fields (`status, intent, pi_pid, window, tmux_session`) are
  **authoritative in the WAL'd `nodes` row**, NOT in meta. Each is mutated by one
  **atomic single-statement `UPDATE`** (`setStatus`/`setIntent`/`setPresence`/
  `recordPid`/`clearPid`), so concurrent writers of different fields can't clobber.
  `getNode()` returns the hydrated `NodeMeta` view (identity ∪ runtime row).
- `status` + `intent` move ONLY through `transition(id, event)` (`runtime/
  lifecycle.ts`) — the one writer of that pair, writing both in one atomic
  statement. It owns its `UPDATE` via `openDb` directly: the single sanctioned
  exception to "only canvas.ts touches the db" (mirroring db.ts's migration
  backfill).
- The identity **columns** on the row stay a derived index over meta, rebuildable
  via `rebuildIndex()`. Runtime columns are NOT in meta and NOT rebuildable from it
  (live process/presence state is meaningless after the event that loses the db) —
  `rebuildIndex()` leaves them at their quiescent defaults; tmux+the daemon are the
  authority for what is live.
- The `subscribes_to` **edges** are db-authoritative: no meta owns them (mutable,
  many concurrent writers — what WAL is for). `rebuildIndex()` rebuilds rows only;
  edges are left intact (`spawned_by` is re-derived from each meta).
- The **`focuses`** table (`focuses.ts`, migration v6) is likewise db-authoritative
  and the CANONICAL focus store — canvas.db is "topology + focuses". One row per
  durable on-screen viewport, keyed on the tmux `%pane_id`, `node_id` UNIQUE. There
  is no `focus.ptr` file and no dual-write bridge; placement composes over the
  atomic setters (`openFocusRow`/`setFocusOccupant`/`setFocusPane`/`closeFocusRow`).

## Vocabulary (types.ts)
- Two orthogonal axes every node carries: **mode** (base↔orchestrator) ×
  **lifecycle** (terminal↔resident). The whole runtime keys on this 2×2.
- Two edge types: `subscribes_to` is the load-bearing spine (flow, org chart,
  completion routing — `from`=subscriber, `to`=publisher); `spawned_by` is audit only.
- `NodeMeta` = `NodeIdentity` (durable, in meta.json) ∪ `NodeRuntime`
  (`status`/`intent`/`pi_pid`/`window`/`tmux_session`, authoritative in the row).
  The public `NodeMeta` view keeps the same field set, so every `meta.X` read still
  typechecks — but the two halves now persist in different stores.

## Sharp edges
- `updateNode` is **identity-only** (`Partial<NodeIdentity>`): a whole-file
  read-modify-write of meta.json, safe because identity has a single writer per
  node. It CANNOT write `status`/`intent`/`pi_pid`/`window`/`tmux_session` — those
  go through the atomic row setters / `transition()`. The old cross-process
  lost-update race (daemon stamping `pi_pid` while a node flipped `status`) is
  structurally gone: each runtime field is its own atomic `UPDATE`, serialized by WAL.
- `paths.ts` maps the entire `~/.crouter/canvas/` layout; `CRTR_HOME` overrides the root
  (tests/isolated runs). Resolve paths through it, never hand-join.
