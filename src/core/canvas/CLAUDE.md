# canvas/ — the canvas data-access layer

The ONE place that reads/writes the node+edge model. Everything above (runtime,
feed, daemon, commands) goes through `canvas.ts`; nothing else touches the db or
`meta.json` directly.

## Source-of-truth split (the rule to internalize)
- A node's `meta.json` (on disk under `nodes/<id>/`) is **canonical** for its own
  fields.
- The sqlite `nodes` row is a **derived index** — a queryable projection of the
  meta, rebuildable from disk via `rebuildIndex()`. Never treat it as authoritative.
- The `subscribes_to` **edges** are the exception: no meta owns them, so the db IS
  authoritative for edges (mutable, many concurrent writers — what WAL is for).
- `updateNode()` re-derives the row on every meta write. `rebuildIndex()` rebuilds
  rows only; edges are left intact (`spawned_by` is re-derived from each meta).

## Vocabulary (types.ts)
- Two orthogonal axes every node carries: **mode** (base↔orchestrator) ×
  **lifecycle** (terminal↔resident). The whole runtime keys on this 2×2.
- Two edge types: `subscribes_to` is the load-bearing spine (flow, org chart,
  completion routing — `from`=subscriber, `to`=publisher); `spawned_by` is audit only.
- `NodeMeta` mixes durable identity (kind/cwd/created) with hot transient presence
  (`tmux_session`/`window`/`pi_pid`/`status`/`intent`), all rewritten wholesale on
  every mutation.

## Sharp edges
- `updateNode` is a whole-file read-modify-write with **no locking/CAS**. Two
  concurrent writers — the node's own `crtr` subprocess and the daemon reviving it
  — can clobber each other's fields. Keep a node's meta writes single-writer where
  you can.
- `paths.ts` maps the entire `~/.crtr/` layout; `CRTR_HOME` overrides the root
  (tests/isolated runs). Resolve paths through it, never hand-join.
