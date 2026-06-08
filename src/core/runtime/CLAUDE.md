# runtime/ — the behavior/lifecycle layer

Above `canvas/` (pure data), below `daemon/`. Where the *rules* live: how a node
spawns, launches, revives, resets, closes, and polymorphs. Composes canvas (birth
+ spine) + personas (prose) + tmux (placement) into a running pi process.

- Any new path that boots a pi process (root or child) **must** set `CRTR_FRONT_DOOR=1` in the child's env — omitting it means a child that re-invokes a removed/renamed subcommand bypasses the recursion guard in `front-door.ts` and fork-bombs pi. See `spawn.ts` lines 76 and 95 for the two existing call sites that set it.

## The mode×lifecycle model
- Two orthogonal axes: **mode** (base↔orchestrator) × **lifecycle** (terminal↔
  resident). promote/demote flip mode; residency is independent.
- `persona.ts` is the SINGLE source of transition prose. Commands just call
  `updateNode({mode|lifecycle})`; the injector compares live meta to `persona_ack`
  and, on drift, delivers guidance from exactly two sites — the stophook turn_end
  and the revive kickoff — then commits the ack. Do NOT hand-emit guidance elsewhere.
- Name clash to keep straight: `runtime/persona.ts` INJECTS transition guidance;
  `core/personas/` COMPOSES the system-prompt prose. Different jobs.

## Crash-safety invariant (honored in reset/close/revive)
- **Flip status BEFORE killing the window.** The daemon only revives active|idle
  nodes, so marking done/canceled first closes the race where it sees a window-gone
  live node and revives or kills it, overwriting your transition.
- `LaunchSpec` (in meta) is the canonical revive recipe — rewritten on every
  polymorph so a node comes back as its *current* self.
- `pi_pid` is the daemon's liveness signal: a tmux window can outlive a dead pi.

## Wake provenance (the `<crtr-wake>` block)
`bearings.ts` owns `WakeOrigin` + `buildWakeBearings()` — the agent-facing block
that tells a node a TIMER (not an inbox event) woke or birthed it (Invariant B/D).
Two injection seams, both set ONLY by the daemon's wakeups pass: `spawn.ts` prepends
it to a wake-BORN node's kickoff when `SpawnChildOpts.wakeOrigin` is set (in-memory
only, never the stored recipe — `node new` leaves it unset); `kickoff.ts`
`buildReviveKickoff(…, wakeReason?)` prepends it to a `bare`-wake fresh-revive
(threaded via `reviveNode`'s `wakeReason`). Cadence renders through `core/wake.ts`
`cadenceDisplay` (shared with `node wake list`). noted/deadline self-mark via their
inbox label instead, not this block.

## File map
spawn/launch/kickoff (birth+boot) · revive/reset/close (lifecycle) ·
promote/demote/persona (polymorph) · presence/tmux/front-door (placement+entry) ·
bearings/memory/roadmap/naming (durable context) · stop-guard (no stalled agents).
