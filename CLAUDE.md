# crouter

## Constraints
- `@crouton-kit/humanloop` is a **yalc** local link (`file:.yalc/...`), not an npm package. After a fresh clone, restore with `yalc add @crouton-kit/humanloop` from this dir (requires `yalc push` from the humanloop package first). Publishing to npm while this reference is active will silently ship a broken package — run `yalc remove @crouton-kit/humanloop` and pin a real semver before publishing.

## Storage locations

Three tiers, each with a distinct durability and ownership contract:

1. **Scope root** (`~/.crouter/` for user scope, or `<project>/.crouter/` for project scope) — durable, user-authored content resolved by the scope resolver: `skills/`, `agents/`, `plugins/`, `marketplaces/`, `config.json`. Persists across project changes; belongs to the user or the repo.

2. **Per-cwd crouter root** (`~/.crouter/<mangled-cwd>/`) — per-project working artifacts keyed by the originating cwd via `mangleCwd` (see `src/core/artifact.ts`): `specs/`, `plans/`, `interactions/`, and `sessions/` (the live agent-session graph; `sessions/<id>/session.json`). Session records are **live-state, not history** — they are reaped when their tmux panes are gone.

3. **`$XDG_STATE_HOME/crtr/jobs/`** (default `~/.local/state/crtr/jobs/`) — job records: `meta.json`, `log.jsonl`, `result.{md,json}`, and the `telemetry.json` sidecar. Durable per-job history and the source of truth for status/result. The session graph indexes by `job_id` and joins their telemetry at read time.

**Contributor rule:** durable user content → scope root; per-project working artifacts → per-cwd crouter root; job execution records and telemetry → `$XDG_STATE_HOME`.
