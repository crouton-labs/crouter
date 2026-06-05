# daemon/ — the thin supervisor (crtrd)

One `crtrd` per canvas. Sole job: poll tmux-window + pi liveness and revive nodes.
**No orchestration logic lives here** — it is a process-lifecycle watcher only.

## The tick (superviseTick, every ~2s)
For each active|idle node with a tmux placement:
- **window alive** → check `pi_pid`; window-existence does NOT prove pi is up (an
  inline root runs pi under a login shell that survives pi's death). A pi dead past
  `REVIVE_GRACE_MS` (20s) → revive.
- **window gone + intent=refresh** → fresh respawn (the node yielded).
- **window gone + intent=idle-release** → clear the stale window, revive on the next
  unseen inbox entry (second pass — the in-process watcher died with pi, so the
  daemon owns wake-on-message for dormant nodes).
- **window gone, any other intent** → mark `dead`; if `pi_session_id` was never
  recorded the vehicle never booted → `surfaceBootFailure` (urgent push up the spine).

## Invariants
- `REVIVE_GRACE_MS` MUST exceed worst-case pi boot: `reviveInPlace` transiently
  shows a dead OLD pid during the old-pi-dies→fresh-pi-boots gap; reviving into it
  would double-spawn.
- `livenessVerdict` is the pure, unit-tested decision core; the time/tmux side
  effects live in `handleLiveWindow`.
- Single instance via `crtrHome()/crtrd.pid`. One bad node never kills the loop.
- `manage.ts` `ensureDaemon()` is the silent best-effort starter the runtime calls
  before spawning children; a missing dist must not break the caller.
