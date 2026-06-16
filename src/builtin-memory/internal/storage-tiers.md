---
kind: knowledge
when-and-why-to-read: When you need to know where a piece of crtr state lives on disk — or you are adding a new kind of file and must decide where it belongs — this reference should be read because it names the three storage tiers and their durability/ownership contracts, so you put (or find) the file in the right place instead of scattering state.
short-form: The three crtr storage tiers — scope root (durable user/repo content), per-cwd crouter root (per-project working artifacts), and canvas home (node-graph runtime state).
system-prompt-visibility: name
file-read-visibility: none
---

# Where everything lives (the three storage tiers)

crtr state splits into three tiers, each with a distinct durability and ownership contract. This consolidates the contract for routing; for the precise resolver behavior consult the crouter sources (`src/core/scope.ts`, `src/core/artifact.ts`, `src/core/canvas/paths.ts`) and, in the crouter repo, the "Storage locations" section of its `CLAUDE.md`.

## 1. Scope root — durable, user/repo-authored content

`~/.crouter/` (user scope) or `<project>/.crouter/` (project scope). Resolved by the scope resolver (`src/core/scope.ts`). Holds: `memory/`, `plugins/`, `marketplaces/`, `personas/`, `config.json`. Persists across project changes; belongs to the user or the repo.

## 2. Per-cwd crouter root — per-project working artifacts

`~/.crouter/<mangled-cwd>/`, keyed on the originating cwd via `mangleCwd` (`src/core/artifact.ts`). Holds working artifacts like `interactions/` (humanloop decks for the `crtr human` bridge; `interactions/<id>/` holds `deck.json` / `run.json` / `response.json`).

## 3. Canvas home — node-graph runtime state

`~/.crouter/canvas/` (override with `CRTR_HOME`; see `src/core/canvas/paths.ts`). The agent-runtime state for the node graph:

- `canvas.db` — sqlite (WAL) topology store: nodes + edges only. On-screen focus is the `focuses` table here (durable, keyed on tmux `%pane_id`).
- `nodes/<node_id>/` — each node's durable state: `meta.json` (source of truth for the row), `context/` (roadmap.md, prompts, artifacts), `job/` (`log.jsonl`, `telemetry.json`), `reports/` (append-only `<ts>-<kind>.md` push history), `inbox.jsonl` (messages + coalesced feed), `transcript.jsonl`, `session.ptr` (pi session id).

## The contributor rule

Durable user content → **scope root**. Per-project working artifacts → **per-cwd crouter root**. Node-graph runtime state (topology, context, reports, inbox, telemetry) → **canvas home**.

(The legacy `sessions/` graph and `$XDG_STATE_HOME/crtr/jobs/` tier were removed when the node/canvas runtime replaced the session/job model; node telemetry now lives in each node's `job/telemetry.json` under the canvas home.)
