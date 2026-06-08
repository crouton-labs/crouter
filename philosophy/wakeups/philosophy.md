# Wakeups — what stirs a dormant node

A node with nothing to do right now goes dormant: its pane closes, it burns no compute, and its whole goal and state live on disk. This doc is the model for what brings it back — the set of conditions a dormant node waits on. A node waits on an event, on a time, or on whichever comes first, and it waits *cheaply*, costing nothing until the moment it is worth acting again.

## The core principle

> **A dormant node is waiting, not finished. Waiting is free — it holds no window and burns no compute — and the runtime wakes the node the instant a condition it waits on is met: a message arrives, or a scheduled time comes — a self-scheduled wake, or a deadline bounding a wait the runtime cannot push to.**

Because waiting is dormant, a node can wait for minutes, hours, or days against something the canvas can't push to it — a CI run, a deploy going green, a human, tomorrow morning — without holding a single resource. The only cost a wait ever incurs is the wake itself.

> **Invariant A — Waiting is free.** A node waits while fully dormant; waiting never requires staying resident to watch a clock, and never requires a busy loop that holds a window open to poll. The cheapness of waiting is what lets a node wait at all, rather than finishing prematurely and forgetting its goal.

## The wake channel, completed

Every wake arrives through one channel — the node's inbox — so there is exactly one way a node comes back, however the wake was triggered. Two kinds of trigger feed that channel: an **event** (a report pushed up the spine, a sibling's message, a human's reply) and a **time** (a moment scheduled in advance, by the node for itself or by a parent for a child). Time-based waking is not a separate subsystem bolted alongside the event path; it is the second half of one wake model, and a scheduled wakeup is simply a delivery into the inbox that the runtime makes when its moment arrives.

> **Invariant B — One channel, two triggers.** A dormant node is woken only through its inbox, and a time-triggered wake is indistinguishable from an event-triggered one once it lands there. Both ride the identical revive path — including resuming a once-focused node into its own focus pane rather than opening a new window — so scheduling adds nothing the focus and placement models must learn about.

## What a wakeup carries — bare or noted

A wake comes in two flavors, and the difference is whether it speaks to the woken node:

- **Bare wake.** The node simply cycles: it comes back with a clean window, re-reads its own durable state — roadmap, last reports, what it wrote to disk — and decides for itself what the moment calls for. Nothing is injected; the "why" is whatever it left itself on disk. This is the time-triggered twin of an ordinary refresh, and it is the right shape for a standing job that always does the same kind of work, or for any wake whose reason is fully recoverable from the node's own state.
- **Noted wake.** The wakeup carries a short note — a message the scheduling node writes to its own fresh future context ("re-check CI #4821; you were waiting on the deploy to go green before merging"). Because a woken node keeps no memory beyond disk, the note is how a node tells its future self why *this* moment matters.

> **Invariant C — Every wake carries its own justification.** A woken node always knows why it woke: from the note the wake carried, or from the durable state a bare wake sends it back to re-read — never from in-window memory it no longer has. A wake that leaves the node unable to reconstruct its reason is malformed.

## One primitive, two targets

A scheduled wakeup is a single primitive — a durable record of "do this at time T" — that points at one of two targets:

- **Revive an existing dormant node** (a self-alarm). The node resumes its own goal and disk state and picks up where its roadmap left it.
- **Spawn a fresh node** from a recipe (a deferred birth). The target does not exist yet, so the fired wakeup creates it.

Same record, same firing, same durability; only the target differs. "Schedule myself to re-check later" and "schedule a new agent to start the migration tomorrow" are the same feature seen from two angles.

> **Invariant D — One primitive, two targets.** A fired wakeup either revives an existing node or spawns a new one from a recipe. There is one scheduling mechanism, not a separate one per flavor.

## Recurrence — adaptive and declarative

A standing wait can recur, and there are two shapes because two intents pull in opposite directions:

- **Self-re-arming one-shot — adaptive.** Each time it wakes, the node re-decides when to wake next: back off when nothing changed, tighten as it gets close, stop when the goal is met. The cadence is a judgment the node remakes with a fresh window every cycle. This is the right shape for polling, where the next interval depends on what the last check found.
- **Declarative recurrence — reliable.** A cadence the runtime owns and fires on schedule even if the node crashed, errored, or never woke to re-arm. This is the dependable agentic cron: a standing agent that triages overnight failures every morning, whether or not yesterday's instance survived to schedule today's.

> **Invariant E — Two recurrence shapes, chosen by intent.** Adaptive recurrence (the node re-arms itself each cycle) is for waits whose cadence is a live judgment; declarative recurrence (the runtime fires on a fixed cadence) is for standing jobs that must keep firing independent of any single instance's survival. The choice between them is the choice between adaptivity and reliability, made per use.

## Bounded waits — the runtime's guarantee

The runtime bounds every wait on a pushable event, so a node never bounds it by hand. It wakes the node on a human's reply, a sibling's message, and any terminal outcome of a delegate — a finish, a death, and a close all reach the inbox alike. A node that delegates and goes dormant therefore arms nothing and just stops. The one exception is a wait nothing can push to it — CI, a clock — where scheduling is the only way to wait (Invariant E).

> **Invariant F — A deadline bounds only the unpushable wait.** "You won't hang forever" is the runtime's guarantee, not a deadline a node sets against its delegates. Arming a timer on a pushable event is the belt-and-suspenders `trust-the-system` forbids.

## Durability and missed wakes

A wait is a durable fact about the canvas, not an in-memory timer, so it must outlive the things that watch it.

> **Invariant G — Durable, coalesced, and tick-scale.** A scheduled wake survives daemon and machine restarts. A recurring wake that came due while the runtime was down fires **once** on catch-up, never once per missed interval — coalesce, never backlog. And wake timing is tick-scale (seconds), tuned to human, CI, and day-length cadence; it is deliberately not a real-time scheduler and promises no sub-second precision.

## What "good" feels like

- A node waiting on CI sleeps fully dormant and wakes itself every couple of minutes to re-check, lengthening its own interval as the build drags, costing nothing in between.
- A node delegates, arms nothing, and goes dormant — and whether a child finishes, dies, or is closed, the runtime wakes it to fold the outcome in; stopping clean is the whole move.
- A standing agent triages overnight failures every morning, reliably, even though last morning's instance reaped itself the moment it finished.
- A node hands itself a one-line note before sleeping and wakes hours later knowing exactly why, in a clean window ready to act.
- A once-focused node's scheduled wake resumes it in its own focus pane, indistinguishable from a child reporting up — no new window ever appears.

## Anti-goals (the "broken" feel)

- **Busy-waiting.** A resident node holding a window open only to watch a clock or re-poll a URL. Waiting must be dormant; a wait that costs a live window is a bug.
- **Finishing in order to stop waiting.** A node that reaps its own goal because it has no way to wait, leaving a human to re-kick it when the awaited thing finally happens.
- **Amnesiac wakes.** A node that comes back unable to tell why — no note, nothing on disk to re-read — and flails or redoes work it already did.
- **Backlog storms.** A recurring wake that fires fifty times to "catch up" after the runtime was down, instead of once.
- **A cron that dies with its agent.** A standing recurring job that silently stops because the single instance responsible for re-arming it crashed — when reliability was its entire purpose.
- **Unbidden windows on a timed wake.** A scheduled revive of a once-focused node popping open a new window instead of resuming into its focus pane — a timed wake must never be a backdoor around the focus model.
- **Pretending to be real-time.** Leaning on wake timing for precision it never promised, instead of treating it as tick-scale, human-cadence scheduling.
