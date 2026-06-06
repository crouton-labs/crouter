# crouter

## Development workflow
When your changes are done: **build, restart the daemon, then commit.** Run all three — don't stop at the build.
```bash
npm run build && crtr canvas daemon stop && crtr canvas daemon start
```
Why the restart matters: `crtrd` (and every running node's pi process) loads compiled `dist/` at process start and **never reloads it**. A long-lived daemon silently keeps running stale code after a rebuild — that's how auto-revive breaks invisibly (a dormant node's inbox gets a push but the old daemon never resumes it). `crtr canvas daemon status` shows the running pid; if its process start time predates your last `dist/` build, it's stale — restart it. Then commit (conventional commits; CI publishes on push to `main`).

## Constraints
- **`reviveNode()` (`src/core/runtime/revive.ts`) is the ONLY sanctioned launcher of `pi --session <file>`.** It alone sets `CRTR_NODE_ID` + the `-e` canvas extensions and runs `transition('revive')`, keeping the canvas-db row ⇄ pi session in lockstep. A RAW `pi --session <file>` has neither, so every canvas hook is inert: the stophook never records `pi_pid` / clears `intent` / marks `done`, no inbox-watcher wakes it, and the row stays dormant; worst case (`idle + intent=idle-release`) the daemon can't see the raw pi and DOUBLE-SPAWNS a second pi on the same `.jsonl`, corrupting the conversation. UIs (e.g. the `/resume-node` picker in `src/pi-extensions/canvas-resume.ts`) must open nodes via `crtr node focus` / `crtr canvas revive`, NEVER by spawning pi directly.
- `@crouton-kit/humanloop` is a **yalc** local link (`file:.yalc/...`), not an npm package. After a fresh clone, restore with `yalc add @crouton-kit/humanloop` from this dir (requires `yalc push` from the humanloop package first). Publishing to npm while this reference is active will silently ship a broken package — run `yalc remove @crouton-kit/humanloop` and pin a real semver before publishing.

## Storage locations

Three tiers, each with a distinct durability and ownership contract:

1. **Scope root** (`~/.crouter/` for user scope, or `<project>/.crouter/` for project scope) — durable, user-authored content resolved by the scope resolver (`src/core/scope.ts`): `skills/`, `plugins/`, `marketplaces/`, `config.json`. Persists across project changes; belongs to the user or the repo.

2. **Per-cwd crouter root** (`~/.crouter/<mangled-cwd>/`) — per-project working artifacts keyed by the originating cwd via `mangleCwd` (see `src/core/artifact.ts`): `interactions/` (humanloop decks for the `crtr human` bridge; `interactions/<id>/` holds `deck.json`/`run.json`/`response.json`).

3. **Canvas home** (`~/.crtr/`, override with `CRTR_HOME`; see `src/core/canvas/paths.ts`) — the agent-runtime state for the node graph. `canvas.db` is the sqlite (WAL) topology store (nodes + edges only); `nodes/<node_id>/` holds each node's durable state: `meta.json` (source of truth for the row), `context/` (roadmap.md, prompts, artifacts), `job/` (`log.jsonl`, `telemetry.json`), `reports/` (append-only `<ts>-<kind>.md` push history), `inbox.jsonl` (messages + coalesced subscription feed), `transcript.jsonl`, and `session.ptr` (pi session id). On-screen focus is the `focuses` table in `canvas.db` (durable, plural viewports keyed on the tmux `%pane_id`) — there is no `focus.ptr` file.

**Contributor rule:** durable user content → scope root; per-project working artifacts → per-cwd crouter root; node-graph runtime state (topology, context, reports, inbox, telemetry) → canvas home.

> The legacy `sessions/` agent-session graph and the `$XDG_STATE_HOME/crtr/jobs/` job-records tier were removed when the node/canvas runtime replaced the session/job model; node telemetry now lives in each node's `job/telemetry.json` under the canvas home.
