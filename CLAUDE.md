# crouter

## Development workflow
When your changes are done: **build, restart the daemon, then commit.** Run all three — don't stop at the build.
```bash
npm run build && crtr canvas daemon stop && crtr canvas daemon start
```
Why the restart matters: `crtrd` (and every running node's pi process) loads compiled `dist/` at process start and **never reloads it**. A long-lived daemon silently keeps running stale code after a rebuild — that's how auto-revive breaks invisibly (a dormant node's inbox gets a push but the old daemon never resumes it). `crtr canvas daemon status` shows the running pid; if its process start time predates your last `dist/` build, it's stale — restart it. Then commit (conventional commits; CI publishes on push to `main`).

**Restarting the daemon is safe — it does not disturb running nodes or their state.** `crtrd` is a thin supervisor (`src/daemon/crtrd.ts`): it polls tmux-pane + pi liveness every ~2s and revives dead nodes, nothing more. It does NOT host the agents — each node is an independent `pi` process in its own tmux pane. `daemon stop` (SIGTERM) just removes the pidfile and exits; it never signals any node's pi, so running agents keep going untouched. Durable state (`cycles`, lifecycle, presence) lives in `canvas.db` / `meta.json`, not in the daemon; the only daemon in-memory state is the `unhealthySince` grace-timer map, whose reset costs at most one extra ~20s grace before reviving an already-dead pi. The sole cost of a restart is the ~1–2s supervision gap between stop and start: a node that yields or dies in that window just waits for the next tick after the daemon is back (its `intent` persists) — nothing is lost or corrupted.

## Testing policy
Only two kinds of tests belong in this codebase — nothing else:
1. **Lifecycle tests** — the node/canvas lifecycle suite (spawn → revive → close → cascade-close, placement, daemon liveness, stop-guard).
2. **Bug-regression tests** — a test written to lock in the fix for a *real, observed* bug.

A real bug is the **only** trigger for a new non-lifecycle test. "This function ought to have coverage" is not — do not add speculative/feature-coverage tests. When you fix a bug, add the regression test that would have caught it, and reference the bug in the test.

### Two tiers: fast (local default) vs full (CI)
`npm test` is the **fast tier** — tmux-free, <10s, the local default; it globs `src/**/__tests__/*.test.ts`, matching every file directly under a `__tests__/` dir but NOT the `full/` subdir. `npm run test:full` is **everything**, including the genuine-tmux chrome tests in `src/core/__tests__/full/` (it globs `src/**/__tests__/**/*.test.ts`); it boots a real isolated tmux session and is what CI runs (`.github/workflows/test.yml`, which also gates publish).

**Run only what you changed.** In the local loop, run the single file or dir you touched — `node --import tsx/esm --test <path>` — not the whole suite. Full-suite runs belong in CI, not in every dev iteration.

## Constraints
- **crtr ONLY runs inside tmux.** The whole runtime (focus/placement, the `/resume-node` popup, `canvas browse`, the daemon's window management) assumes a tmux server. Do NOT add non-tmux fallback UIs — outside tmux a command should notify + no-op (or, for a non-TTY pipe, print a static dump), never reimplement an interactive path. (A non-TTY guard for piping is fine; a parallel non-tmux *interactive* fallback is not.)
- **`reviveNode()` (`src/core/runtime/revive.ts`) is the ONLY sanctioned launcher of `pi --session <file>`.** It alone sets `CRTR_NODE_ID` + the `-e` canvas extensions and runs `transition('revive')`, keeping the canvas-db row ⇄ pi session in lockstep. A RAW `pi --session <file>` has neither, so every canvas hook is inert: the stophook never records `pi_pid` / clears `intent` / marks `done`, no inbox-watcher wakes it, and the row stays dormant; worst case (`idle + intent=idle-release`) the daemon can't see the raw pi and DOUBLE-SPAWNS a second pi on the same `.jsonl`, corrupting the conversation. UIs (e.g. the `/resume-node` picker in `src/pi-extensions/canvas-resume.ts`) must open nodes via `crtr node focus` / `crtr canvas revive`, NEVER by spawning pi directly.
- `@crouton-kit/humanloop` is a **yalc** local link (`file:.yalc/...`), not an npm package. After a fresh clone, restore with `yalc add @crouton-kit/humanloop` from this dir (requires `yalc push` from the humanloop package first). Publishing to npm while this reference is active will silently ship a broken package — run `yalc remove @crouton-kit/humanloop` and pin a real semver before publishing.

## Storage locations

Three tiers, each with a distinct durability and ownership contract:

1. **Scope root** (`~/.crouter/` for user scope, or `<project>/.crouter/` for project scope) — durable, user-authored content resolved by the scope resolver (`src/core/scope.ts`): `skills/`, `plugins/`, `marketplaces/`, `config.json`. Persists across project changes; belongs to the user or the repo.

2. **Per-cwd crouter root** (`~/.crouter/<mangled-cwd>/`) — per-project working artifacts keyed by the originating cwd via `mangleCwd` (see `src/core/artifact.ts`): `interactions/` (humanloop decks for the `crtr human` bridge; `interactions/<id>/` holds `deck.json`/`run.json`/`response.json`).

3. **Canvas home** (`~/.crouter/canvas/`, override with `CRTR_HOME`; see `src/core/canvas/paths.ts`) — the agent-runtime state for the node graph. `canvas.db` is the sqlite (WAL) topology store (nodes + edges only); `nodes/<node_id>/` holds each node's durable state: `meta.json` (source of truth for the row), `context/` (roadmap.md, prompts, artifacts), `job/` (`log.jsonl`, `telemetry.json`), `reports/` (append-only `<ts>-<kind>.md` push history), `inbox.jsonl` (messages + coalesced subscription feed), `transcript.jsonl`, and `session.ptr` (pi session id). On-screen focus is the `focuses` table in `canvas.db` (durable, plural viewports keyed on the tmux `%pane_id`) — there is no `focus.ptr` file.

**Contributor rule:** durable user content → scope root; per-project working artifacts → per-cwd crouter root; node-graph runtime state (topology, context, reports, inbox, telemetry) → canvas home.

> The legacy `sessions/` agent-session graph and the `$XDG_STATE_HOME/crtr/jobs/` job-records tier were removed when the node/canvas runtime replaced the session/job model; node telemetry now lives in each node's `job/telemetry.json` under the canvas home (`~/.crouter/canvas/`).
